const fs = require("node:fs");
const path = require("node:path");
const { FolderScanCancelledError } = require("./folder-scanner.cjs");
const { extractFile } = require("./extraction.cjs");

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
	extractor = extractFile,
}) {
	const statuses = new Map();
	const running = new Set();
	const staleRevisions = new Map();
	const listeners = new Set();

	function publish(grantId) {
		const snapshot = getStatus(grantId);
		for (const listener of listeners) listener({ grantId, status: snapshot });
		return snapshot;
	}

	function setStatus(grantId, status) {
		statuses.set(grantId, status);
		return publish(grantId);
	}

	function statusFor(grantId) {
		return (
			statuses.get(grantId) || {
				state: "idle",
				readiness: "partial",
				partial: true,
				lastSyncedAt: null,
				counts: { indexed: 0, added: 0, updated: 0, removed: 0 },
				progress: { phase: "pending", processed: 0, total: 0 },
				error: null,
			}
		);
	}

	function getStatus(grantId) {
		const status = statusFor(grantId);
		return {
			state: status.state,
			readiness: status.readiness,
			partial: status.partial,
			lastSyncedAt: status.lastSyncedAt,
			counts: { ...status.counts },
			progress: { ...status.progress },
			error: status.error ? { ...status.error } : null,
		};
	}

	function subscribe(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	function markStale(grantId) {
		const previous = statusFor(grantId);
		staleRevisions.set(grantId, (staleRevisions.get(grantId) || 0) + 1);
		return setStatus(grantId, {
			...previous,
			state: "stale",
			readiness: "partial",
			partial: true,
		});
	}

	function removeGrant(grantId) {
		// Policy: remove this grant's membership immediately. Orphaned derived rows
		// are deleted; rows shared with another grant remain available to that grant.
		const database = index.database;
		database.exec("BEGIN IMMEDIATE");
		try {
			const rows = database
				.prepare("SELECT file_id FROM indexed_grants WHERE grant_id = ?")
				.all(grantId);
			database
				.prepare("DELETE FROM indexed_grants WHERE grant_id = ?")
				.run(grantId);
			for (const { file_id: fileId } of rows) {
				const memberships = database
					.prepare(
						"SELECT count(*) AS count FROM indexed_grants WHERE file_id = ?",
					)
					.get(fileId).count;
				if (memberships === 0)
					database
						.prepare("DELETE FROM file_search WHERE file_id = ?")
						.run(fileId);
				if (memberships === 0)
					database
						.prepare("DELETE FROM file_identities WHERE id = ?")
						.run(fileId);
			}
			database.exec("COMMIT");
			const previous = statusFor(grantId);
			return setStatus(grantId, {
				state: "unavailable",
				readiness: "error",
				partial: false,
				lastSyncedAt: previous.lastSyncedAt,
				counts: { indexed: 0, added: 0, updated: 0, removed: rows.length },
				progress: { phase: "error", processed: 0, total: 0 },
				error: { code: "GRANT_UNAVAILABLE", message: "Folder unavailable" },
			});
		} catch (error) {
			try {
				database.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	async function syncGrant(grantId, { signal } = {}) {
		if (running.has(grantId)) throw new Error("This grant is already syncing.");
		running.add(grantId);
		const previous = statusFor(grantId);
		const staleRevisionAtStart = staleRevisions.get(grantId) || 0;
		setStatus(grantId, {
			...previous,
			state: "syncing",
			readiness: "partial",
			partial: true,
			progress: { phase: "scanning", processed: 0, total: 0 },
			error: null,
		});
		try {
			throwIfCancelled(signal);
			const authorization = authorizer.resolveGrant(grantId);
			const root = authorization.canonicalPath;
			const scan = await scanner.scanFolder(root, { signal });
			const records = [];
			const total = scan.files.length;
			setStatus(grantId, {
				...statusFor(grantId),
				progress: { phase: "processing", processed: 0, total },
			});
			for (const file of scan.files) {
				throwIfCancelled(signal);
				const currentPath = path.join(root, file.name);
				if (index.isExcludedPath(currentPath)) continue;
				const stat = await fsApi.promises.lstat(currentPath);
				throwIfCancelled(signal);
				if (!stat.isFile() || stat.isSymbolicLink()) continue;
				const extraction = await extractor(currentPath);
				throwIfCancelled(signal);
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
					content: extraction.status === "extracted" ? extraction.text : "",
				});
				setStatus(grantId, {
					...statusFor(grantId),
					progress: {
						phase: "processing",
						processed: records.length,
						total,
					},
				});
			}

			throwIfCancelled(signal);
			setStatus(grantId, {
				...statusFor(grantId),
				progress: { phase: "committing", processed: total, total },
			});
			// A scan can outlive its grant. Reauthorize immediately before the
			// synchronous transaction so revocation cannot repopulate cleared rows.
			authorizer.resolveGrant(grantId);
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
							"INSERT INTO file_search(file_id, filename, path, extension, content) VALUES (?, ?, ?, ?, ?)",
						)
						.run(
							fileId,
							record.filename,
							record.currentPath,
							record.extension,
							record.content,
						);
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
			const becameStaleDuringSync =
				(staleRevisions.get(grantId) || 0) !== staleRevisionAtStart;
			const result = {
				state: becameStaleDuringSync ? "stale" : "idle",
				readiness: becameStaleDuringSync ? "partial" : "complete",
				partial: becameStaleDuringSync,
				lastSyncedAt: now(),
				counts,
				progress: { phase: "complete", processed: total, total },
				error: null,
			};
			return setStatus(grantId, result);
		} catch (error) {
			const becameStaleDuringSync =
				(staleRevisions.get(grantId) || 0) !== staleRevisionAtStart;
			setStatus(grantId, {
				...previous,
				state: becameStaleDuringSync ? "stale" : previous.state,
				readiness: "error",
				partial: false,
				progress: {
					...statusFor(grantId).progress,
					phase: "error",
				},
				error: { code: "INDEX_SYNC_FAILED", message: "Index sync failed" },
			});
			throw error;
		} finally {
			running.delete(grantId);
		}
	}

	return { getStatus, markStale, removeGrant, subscribe, syncGrant };
}

module.exports = { createIndexSynchronizationEngine, identityKey };
