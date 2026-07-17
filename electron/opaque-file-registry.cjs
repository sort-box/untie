const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
	CapabilityAuthorizationError,
	canonicalizePath,
	isContained,
} = require("./capabilities/authorization.cjs");

const DEFAULT_FILE_ID_TTL_MS = 30 * 60 * 1000;
const FILE_ID_PATTERN = /^file_[0-9a-f]{32}$/;

function newFileId(random = randomUUID) {
	return `file_${random().replaceAll("-", "")}`;
}

function sameSnapshot(left, right) {
	return (
		left.canonicalPath === right.canonicalPath &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.dev === right.dev &&
		left.ino === right.ino
	);
}

function createOpaqueFileRegistry({
	referenceStore,
	fsApi = fs,
	now = Date.now,
	ttlMs = DEFAULT_FILE_ID_TTL_MS,
	randomUUID: random = randomUUID,
}) {
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
		throw new TypeError("Opaque file ID TTL must be a positive integer");
	}

	const byId = new Map();
	const currentBySource = new Map();

	function sourceKey(grantId, canonicalPath) {
		return `${grantId}\0${canonicalPath}`;
	}

	function invalidate(record) {
		if (record.status === "invalidated") return;
		record.status = "invalidated";
		if (currentBySource.get(record.key) === record) {
			currentBySource.delete(record.key);
		}
		referenceStore.setItem({
			...record.reference,
			status: "invalidated",
		});
	}

	function capture(canonicalGrantPath, name) {
		const candidate = path.join(canonicalGrantPath, name);
		const canonicalPath = canonicalizePath(candidate, fsApi);
		if (
			!isContained(canonicalGrantPath, canonicalPath) ||
			path.dirname(canonicalPath) !== canonicalGrantPath
		) {
			throw new CapabilityAuthorizationError(
				"NOT_CONTAINED",
				"Scanned file resolves outside the granted folder",
			);
		}
		let stat;
		try {
			stat = fsApi.statSync(canonicalPath);
		} catch {
			throw new CapabilityAuthorizationError(
				"STALE_REFERENCE",
				"Scanned file changed while its snapshot was captured",
			);
		}
		if (!stat.isFile()) {
			throw new CapabilityAuthorizationError(
				"STALE_REFERENCE",
				"Scanned entry is no longer a regular file",
			);
		}
		return Object.freeze({
			canonicalPath,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			dev: stat.dev,
			ino: stat.ino,
		});
	}

	function captureIndexed(canonicalGrantPath, candidate) {
		let canonicalPath;
		try {
			canonicalPath = canonicalizePath(candidate, fsApi);
		} catch (error) {
			if (error?.code === "STALE_REFERENCE") return null;
			throw error;
		}
		if (!isContained(canonicalGrantPath, canonicalPath)) {
			throw new CapabilityAuthorizationError(
				"NOT_CONTAINED",
				"Indexed file resolves outside the granted folder",
			);
		}
		let stat;
		try {
			stat = fsApi.statSync(canonicalPath);
		} catch {
			return null;
		}
		if (!stat.isFile()) return null;
		return Object.freeze({
			canonicalPath,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			dev: stat.dev,
			ino: stat.ino,
		});
	}

	function registerSnapshots({ grant, files, snapshotFor }) {
		const issuedAt = now();
		return files.map((file) => {
			const snapshot = snapshotFor(file);
			const key = sourceKey(grant.id, snapshot.canonicalPath);
			let record = currentBySource.get(key);
			if (
				record &&
				(record.expiresAt <= issuedAt ||
					record.reference.grantRevision !== grant.revision ||
					!sameSnapshot(record.snapshot, snapshot))
			) {
				invalidate(record);
				record = undefined;
			}
			if (!record) {
				const id = newFileId(random);
				const expiresAt = issuedAt + ttlMs;
				const reference = Object.freeze({
					id,
					path: snapshot.canonicalPath,
					grantId: grant.id,
					grantRevision: grant.revision,
					expiresAt,
					snapshot,
					status: "active",
				});
				record = { id, key, snapshot, expiresAt, status: "active", reference };
				byId.set(id, record);
				currentBySource.set(key, record);
				referenceStore.setItem(reference);
			}
			return Object.freeze({ itemId: record.id, name: file.name });
		});
	}

	function registerIndexedResults({ grant, canonicalGrantPath, files }) {
		const sourceIndexes = [];
		const availableFiles = [];
		const snapshots = new Map();
		for (const [sourceIndex, file] of files.entries()) {
			const snapshot = captureIndexed(canonicalGrantPath, file.path);
			if (!snapshot) continue;
			sourceIndexes.push(sourceIndex);
			availableFiles.push(file);
			snapshots.set(file, snapshot);
		}
		const publicFiles = registerSnapshots({
			grant,
			files: availableFiles,
			snapshotFor: (file) => snapshots.get(file),
		});
		Object.defineProperty(publicFiles, "sourceIndexes", {
			value: Object.freeze(sourceIndexes),
		});
		return publicFiles;
	}

	function registerScan({ grant, canonicalGrantPath, files }) {
		const seen = new Set();
		const issuedAt = now();
		const publicFiles = files.map(({ name }) => {
			const snapshot = capture(canonicalGrantPath, name);
			const key = sourceKey(grant.id, snapshot.canonicalPath);
			seen.add(key);
			let record = currentBySource.get(key);

			if (
				record &&
				(record.expiresAt <= issuedAt ||
					record.reference.grantRevision !== grant.revision ||
					!sameSnapshot(record.snapshot, snapshot))
			) {
				invalidate(record);
				record = undefined;
			}

			if (!record) {
				const id = newFileId(random);
				const expiresAt = issuedAt + ttlMs;
				const reference = Object.freeze({
					id,
					path: snapshot.canonicalPath,
					grantId: grant.id,
					grantRevision: grant.revision,
					expiresAt,
					snapshot,
					status: "active",
				});
				record = {
					id,
					key,
					snapshot,
					expiresAt,
					status: "active",
					reference,
				};
				byId.set(id, record);
				currentBySource.set(key, record);
				referenceStore.setItem(reference);
			}

			return Object.freeze({ itemId: record.id, name });
		});

		for (const record of byId.values()) {
			if (
				record.reference.grantId === grant.id &&
				record.status === "active" &&
				!seen.has(record.key)
			) {
				invalidate(record);
			}
		}
		return publicFiles;
	}

	return { registerIndexedResults, registerScan };
}

module.exports = {
	DEFAULT_FILE_ID_TTL_MS,
	FILE_ID_PATTERN,
	createOpaqueFileRegistry,
	newFileId,
	sameSnapshot,
};
