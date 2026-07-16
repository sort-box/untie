const fs = require("node:fs");
const path = require("node:path");
const { FolderScanCancelledError } = require("./folder-scanner.cjs");

function throwIfCancelled(signal) {
	if (signal?.aborted) throw new FolderScanCancelledError();
}

function identityKey(stat) {
	return `${stat.dev}:${stat.ino}`;
}

function extensionFor(filename) {
	return path
		.extname(filename)
		.slice(1)
		.normalize("NFC")
		.toLocaleLowerCase("en-US");
}

function createIndexSynchronizationEngine({
	index,
	scanner,
	authorizer,
	fsApi = fs,
	now = Date.now,
	onMutation,
}) {
	const statuses = new Map();
	const running = new Set();

	function statusFor(grantId) {
		return (
			statuses.get(grantId) || {
				state: "idle",
				lastSyncedAt: null,
				counts: { indexed: 0, added: 0, updated: 0, removed: 0 },
			}
		);
	}

	function getStatus(grantId) {
		const status = statusFor(grantId);
		return {
			state: status.state,
			lastSyncedAt: status.lastSyncedAt,
			counts: { ...status.counts },
		};
	}

	async function syncGrant(grantId, { signal } = {}) {
		if (running.has(grantId)) throw new Error("This grant is already syncing.");
		running.add(grantId);
		const previous = statusFor(grantId);
		statuses.set(grantId, { ...previous, state: "syncing" });
		try {
			throwIfCancelled(signal);
			const authorization = authorizer.resolveGrant(grantId);
			const root = authorization.canonicalPath;
			const scan = await scanner.scanFolder(root, { signal });
			const records = [];
			for (const file of scan.files) {
				throwIfCancelled(signal);
				const currentPath = path.join(root, file.name);
				if (index.isExcludedPath(currentPath)) continue;
				const stat = await fsApi.promises.lstat(currentPath);
				throwIfCancelled(signal);
				if (!stat.isFile() || stat.isSymbolicLink()) continue;
				records.push({
					identityKey: identityKey(stat),
					currentPath,
					filename: file.name,
					extension: extensionFor(file.name),
					sizeBytes: stat.size,
					createdAtMs: Number.isFinite(stat.birthtimeMs)
						? Math.trunc(stat.birthtimeMs)
						: null,
					modifiedAtMs: Math.trunc(stat.mtimeMs),
				});
			}

			throwIfCancelled(signal);
			const database = index.database;
			const existingRows = database
				.prepare(`
					SELECT i.id, i.identity_key, p.current_path, p.filename,
						p.extension, p.size_bytes, p.created_at_ms, p.modified_at_ms
					FROM indexed_grants g
					JOIN file_identities i ON i.id = g.file_id
					JOIN file_paths p ON p.file_id = i.id
					WHERE g.grant_id = ?
				`)
				.all(grantId);
			const existing = new Map(
				existingRows.map((row) => [row.identity_key, row]),
			);
			const seen = new Set(records.map((record) => record.identityKey));
			let added = 0;
			let updated = 0;
			let removed = 0;

			database.exec("BEGIN IMMEDIATE");
			try {
				for (const record of records) {
					const previousRecord = existing.get(record.identityKey);
					if (
						previousRecord &&
						previousRecord.current_path !== record.currentPath
					) {
						database
							.prepare(
								"UPDATE file_paths SET current_path = ? WHERE file_id = ?",
							)
							.run(
								`untie-index-sync://pending/${previousRecord.id}`,
								previousRecord.id,
							);
					}
				}
				for (const record of records) {
					throwIfCancelled(signal);
					onMutation?.({ type: "upsert", record });
					throwIfCancelled(signal);
					const previousRecord = existing.get(record.identityKey);
					const pathOwner = database
						.prepare(`
							SELECT p.file_id, i.identity_key
							FROM file_paths p
							JOIN file_identities i ON i.id = p.file_id
							WHERE p.current_path = ?
						`)
						.get(record.currentPath);
					if (pathOwner && pathOwner.identity_key !== record.identityKey) {
						database
							.prepare("DELETE FROM file_search WHERE file_id = ?")
							.run(pathOwner.file_id);
						database
							.prepare("DELETE FROM file_identities WHERE id = ?")
							.run(pathOwner.file_id);
					}
					database
						.prepare(
							"INSERT INTO file_identities(identity_key, created_at_ms) VALUES (?, ?) ON CONFLICT(identity_key) DO NOTHING",
						)
						.run(record.identityKey, now());
					const fileId = database
						.prepare("SELECT id FROM file_identities WHERE identity_key = ?")
						.get(record.identityKey).id;
					database
						.prepare(`
						INSERT INTO file_paths(file_id, current_path, filename, extension, size_bytes, created_at_ms, modified_at_ms)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(file_id) DO UPDATE SET current_path = excluded.current_path,
							filename = excluded.filename, extension = excluded.extension,
							size_bytes = excluded.size_bytes, created_at_ms = excluded.created_at_ms,
							modified_at_ms = excluded.modified_at_ms
					`)
						.run(
							fileId,
							record.currentPath,
							record.filename,
							record.extension,
							record.sizeBytes,
							record.createdAtMs,
							record.modifiedAtMs,
						);
					database
						.prepare(
							"INSERT INTO indexed_grants(grant_id, file_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
						)
						.run(grantId, fileId);
					database
						.prepare("DELETE FROM file_search WHERE file_id = ?")
						.run(fileId);
					database
						.prepare(
							"INSERT INTO file_search(file_id, filename, path, extension, content) VALUES (?, ?, ?, ?, '')",
						)
						.run(fileId, record.filename, record.currentPath, record.extension);
					if (!previousRecord) added += 1;
					else if (
						previousRecord.current_path !== record.currentPath ||
						previousRecord.filename !== record.filename ||
						previousRecord.extension !== record.extension ||
						previousRecord.size_bytes !== record.sizeBytes ||
						previousRecord.created_at_ms !== record.createdAtMs ||
						previousRecord.modified_at_ms !== record.modifiedAtMs
					)
						updated += 1;
				}

				for (const row of existingRows) {
					if (seen.has(row.identity_key)) continue;
					throwIfCancelled(signal);
					onMutation?.({ type: "remove", row });
					throwIfCancelled(signal);
					database
						.prepare(
							"DELETE FROM indexed_grants WHERE grant_id = ? AND file_id = ?",
						)
						.run(grantId, row.id);
					const memberships = database
						.prepare(
							"SELECT count(*) AS count FROM indexed_grants WHERE file_id = ?",
						)
						.get(row.id).count;
					if (memberships === 0)
						database
							.prepare("DELETE FROM file_search WHERE file_id = ?")
							.run(row.id);
					if (memberships === 0)
						database
							.prepare("DELETE FROM file_identities WHERE id = ?")
							.run(row.id);
					removed += 1;
				}
				throwIfCancelled(signal);
				database.exec("COMMIT");
			} catch (error) {
				try {
					database.exec("ROLLBACK");
				} catch {}
				throw error;
			}

			const counts = { indexed: records.length, added, updated, removed };
			const result = { state: "idle", lastSyncedAt: now(), counts };
			statuses.set(grantId, result);
			return getStatus(grantId);
		} catch (error) {
			statuses.set(grantId, { ...previous, state: "idle" });
			throw error;
		} finally {
			running.delete(grantId);
		}
	}

	return { getStatus, syncGrant };
}

module.exports = { createIndexSynchronizationEngine, identityKey };
