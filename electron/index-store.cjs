const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createNodeSqliteIndexAdapter } = require("./index-adapter.cjs");

const INDEX_SCHEMA_VERSION = 2;
const FTS5_TOKENIZER = "porter unicode61 remove_diacritics 2";

const INDEX_MIGRATIONS = Object.freeze({
	1: (database) => {
		database.exec(`
			CREATE TABLE file_identities (
				id INTEGER PRIMARY KEY,
				identity_key TEXT NOT NULL UNIQUE,
				created_at_ms INTEGER NOT NULL
			) STRICT;
			CREATE TABLE file_paths (
				file_id INTEGER PRIMARY KEY REFERENCES file_identities(id) ON DELETE CASCADE,
				current_path TEXT NOT NULL UNIQUE,
				filename TEXT NOT NULL,
				extension TEXT NOT NULL,
				size_bytes INTEGER NOT NULL,
				created_at_ms INTEGER,
				modified_at_ms INTEGER NOT NULL,
				content TEXT NOT NULL DEFAULT '',
				is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1))
			) STRICT;
		`);
	},
	2: (database) => {
		// Column order is intentional: the retrieval layer can give filename the
		// highest bm25 weight, followed by path, extension, then document content.
		database.exec(`
			CREATE VIRTUAL TABLE file_search USING fts5(
				file_id UNINDEXED,
				filename,
				path,
				extension,
				content,
				tokenize='${FTS5_TOKENIZER}'
			);
		`);
	},
});

class IndexStoreError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "IndexStoreError";
		this.code = code;
	}
}

function indexError(code, message, cause) {
	return new IndexStoreError(code, message, cause ? { cause } : undefined);
}

function scalar(database, sql) {
	const row = database.prepare(sql).get();
	return row && Object.values(row)[0];
}

function verifyFts5(database) {
	try {
		database.exec(
			"CREATE VIRTUAL TABLE temp.untie_fts5_probe USING fts5(value); DROP TABLE temp.untie_fts5_probe;",
		);
	} catch (cause) {
		throw indexError(
			"FTS5_UNAVAILABLE",
			"The SQLite index provider does not include FTS5.",
			cause,
		);
	}
}

function ensureVersionTable(database) {
	database.exec("BEGIN IMMEDIATE");
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS schema_version (
				version INTEGER NOT NULL CHECK (version >= 0)
			) STRICT;
			INSERT INTO schema_version(version)
			SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
		`);
		database.exec("COMMIT");
	} catch (cause) {
		try {
			database.exec("ROLLBACK");
		} catch {}
		throw cause;
	}
	const count = scalar(database, "SELECT count(*) FROM schema_version");
	if (count !== 1) throw new Error("Invalid schema version table.");
}

function runIndexMigrations(
	database,
	{ migrations = INDEX_MIGRATIONS, targetVersion = INDEX_SCHEMA_VERSION } = {},
) {
	ensureVersionTable(database);
	let version = scalar(database, "SELECT version FROM schema_version");
	if (!Number.isSafeInteger(version) || version < 0)
		throw new Error("Invalid index schema version.");
	if (version > targetVersion)
		throw indexError(
			"INDEX_VERSION_UNSUPPORTED",
			"The index was created by a newer version of Untie.",
		);

	while (version < targetVersion) {
		const nextVersion = version + 1;
		const migrate = migrations[nextVersion];
		if (typeof migrate !== "function")
			throw new Error(`Missing index migration to version ${nextVersion}.`);
		database.exec("BEGIN IMMEDIATE");
		try {
			migrate(database);
			database
				.prepare("UPDATE schema_version SET version = ?")
				.run(nextVersion);
			database.exec("COMMIT");
			version = nextVersion;
		} catch (cause) {
			try {
				database.exec("ROLLBACK");
			} catch {
				// Preserve the original migration failure.
			}
			throw indexError(
				"INDEX_MIGRATION_FAILED",
				`Index migration to version ${nextVersion} failed.`,
				cause,
			);
		}
	}
	return version;
}

function openAndValidate(filename, createAdapter, migrationOptions) {
	const database = createAdapter(filename);
	try {
		database.exec("PRAGMA foreign_keys = ON;");
		const integrity = scalar(database, "PRAGMA integrity_check");
		if (integrity !== "ok")
			throw indexError(
				"INDEX_INTEGRITY_FAILED",
				"The derived file index failed its integrity check.",
			);
		verifyFts5(database);
		runIndexMigrations(database, migrationOptions);
		return database;
	} catch (error) {
		try {
			database.close();
		} catch {
			// The opening error is more useful than a close error.
		}
		throw error;
	}
}

function isRecoverable(error) {
	return (
		error?.code === "INDEX_VERSION_UNSUPPORTED" ||
		error?.code === "INDEX_INTEGRITY_FAILED" ||
		(error?.code !== "FTS5_UNAVAILABLE" &&
			error?.code !== "INDEX_MIGRATION_FAILED")
	);
}

function removeDatabaseFiles(filename) {
	for (const suffix of ["", "-wal", "-shm"])
		fs.rmSync(`${filename}${suffix}`, { force: true });
}

function removeSidecars(filename) {
	for (const suffix of ["-wal", "-shm"])
		fs.rmSync(`${filename}${suffix}`, { force: true });
}

function rebuildIndex(filename, createAdapter, logger, reason) {
	const staging = `${filename}.rebuilding-${randomUUID()}`;
	const backup = `${filename}.discarded-${randomUUID()}`;
	let database;
	try {
		database = openAndValidate(staging, createAdapter);
		database.close();
		database = undefined;
		if (fs.existsSync(filename)) fs.renameSync(filename, backup);
		fs.renameSync(staging, filename);
		removeDatabaseFiles(backup);
		removeSidecars(filename);
		database = openAndValidate(filename, createAdapter);
		logger.warn(
			"Rebuilt Untie's derived file index after startup validation failed.",
			{
				reason: reason?.code || "SQLITE_UNREADABLE",
			},
		);
		return database;
	} catch (cause) {
		try {
			database?.close();
		} catch {}
		removeDatabaseFiles(staging);
		if (fs.existsSync(backup) && !fs.existsSync(filename))
			fs.renameSync(backup, filename);
		throw indexError(
			"INDEX_RECOVERY_FAILED",
			"The derived file index could not be rebuilt.",
			cause,
		);
	}
}

function isInsideAppData(candidatePath, appDataDirectory) {
	const relative = path.relative(
		path.resolve(appDataDirectory),
		path.resolve(candidatePath),
	);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function initializeFileIndex(appDataDirectory, options = {}) {
	const filename = path.join(appDataDirectory, "db", "index.sqlite");
	const createAdapter = options.createAdapter || createNodeSqliteIndexAdapter;
	const logger = options.logger || console;
	let database;
	try {
		database = openAndValidate(filename, createAdapter);
	} catch (error) {
		if (!isRecoverable(error)) throw error;
		database = rebuildIndex(filename, createAdapter, logger, error);
	}
	return {
		database,
		filename,
		schemaVersion: INDEX_SCHEMA_VERSION,
		isExcludedPath: (candidatePath) =>
			isInsideAppData(candidatePath, appDataDirectory),
	};
}

module.exports = {
	FTS5_TOKENIZER,
	INDEX_MIGRATIONS,
	INDEX_SCHEMA_VERSION,
	IndexStoreError,
	initializeFileIndex,
	isInsideAppData,
	runIndexMigrations,
};
