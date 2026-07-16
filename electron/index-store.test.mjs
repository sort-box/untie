import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const { initializeLocalStores } = require("./local-store.cjs");
const {
	FTS5_TOKENIZER,
	INDEX_SCHEMA_VERSION,
	initializeFileIndex,
	isInsideAppData,
	runIndexMigrations,
} = require("./index-store.cjs");

const temporaryDirectories = [];

function temporaryStores() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-index-test-"));
	temporaryDirectories.push(root);
	initializeLocalStores(root);
	return root;
}

function value(database, sql) {
	return Object.values(database.prepare(sql).get())[0];
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("file index schema", () => {
	test("initializes the weighted FTS columns with the R3 tokenizer", () => {
		const root = temporaryStores();
		const index = initializeFileIndex(root);

		expect(index.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
		expect(value(index.database, "SELECT version FROM schema_version")).toBe(
			INDEX_SCHEMA_VERSION,
		);
		const definition = index.database
			.prepare(
				"SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'file_search'",
			)
			.get().sql;
		expect(definition).toContain(`tokenize='${FTS5_TOKENIZER}'`);
		expect(definition.indexOf("filename")).toBeLessThan(
			definition.indexOf("path"),
		);
		expect(definition.indexOf("path")).toBeLessThan(
			definition.indexOf("content"),
		);
		index.database.close();
	});

	test("runs each migration transactionally and advances only on commit", () => {
		const database = new DatabaseSync(":memory:");
		const migrations = {
			1: (db) => db.exec("CREATE TABLE retained(value TEXT) STRICT;"),
			2: (db) => {
				db.exec("CREATE TABLE rolled_back(value TEXT) STRICT;");
				throw new Error("simulated failure");
			},
		};

		expect(() =>
			runIndexMigrations(database, { migrations, targetVersion: 2 }),
		).toThrowError(expect.objectContaining({ code: "INDEX_MIGRATION_FAILED" }));
		expect(value(database, "SELECT version FROM schema_version")).toBe(1);
		expect(
			value(
				database,
				"SELECT count(*) FROM sqlite_schema WHERE name = 'retained'",
			),
		).toBe(1);
		expect(
			value(
				database,
				"SELECT count(*) FROM sqlite_schema WHERE name = 'rolled_back'",
			),
		).toBe(0);
		database.close();
	});

	test("keeps stable identity when a file path changes", () => {
		const root = temporaryStores();
		const { database } = initializeFileIndex(root);
		database
			.prepare(
				"INSERT INTO file_identities(identity_key, created_at_ms) VALUES (?, ?)",
			)
			.run("volume-12:file-340", 1);
		const fileId = value(
			database,
			"SELECT id FROM file_identities WHERE identity_key = 'volume-12:file-340'",
		);
		database
			.prepare(
				"INSERT INTO file_paths(file_id, current_path, filename, extension, size_bytes, modified_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(fileId, "/Granted/old.txt", "old.txt", "txt", 4, 2);
		database
			.prepare(
				"UPDATE file_paths SET current_path = ?, filename = ? WHERE file_id = ?",
			)
			.run("/Granted/new.txt", "new.txt", fileId);

		expect(
			database
				.prepare(
					"SELECT i.identity_key, p.current_path FROM file_identities i JOIN file_paths p ON p.file_id = i.id",
				)
				.get(),
		).toEqual({
			identity_key: "volume-12:file-340",
			current_path: "/Granted/new.txt",
		});
		database.close();
	});
});

describe("file index startup recovery", () => {
	test("rebuilds a corrupt index without touching journal or chat data", () => {
		const root = temporaryStores();
		const journal = path.join(root, "journal", "operations", "keep.json");
		const chat = path.join(root, "chat", "history", "keep.json");
		fs.writeFileSync(journal, "journal data");
		fs.writeFileSync(chat, "chat data");
		fs.writeFileSync(path.join(root, "db", "index.sqlite"), "not sqlite");
		const logger = { warn: vi.fn() };

		const index = initializeFileIndex(root, { logger });

		expect(value(index.database, "PRAGMA integrity_check")).toBe("ok");
		expect(logger.warn).toHaveBeenCalledWith(
			"Rebuilt Untie's derived file index after startup validation failed.",
			expect.objectContaining({ reason: expect.any(String) }),
		);
		expect(fs.readFileSync(journal, "utf8")).toBe("journal data");
		expect(fs.readFileSync(chat, "utf8")).toBe("chat data");
		index.database.close();
	});

	test("rebuilds an unsupported newer schema and logs the reason", () => {
		const root = temporaryStores();
		const filename = path.join(root, "db", "index.sqlite");
		const database = new DatabaseSync(filename);
		database.exec(
			"CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES (99);",
		);
		database.close();
		const logger = { warn: vi.fn() };

		const index = initializeFileIndex(root, { logger });

		expect(value(index.database, "SELECT version FROM schema_version")).toBe(
			INDEX_SCHEMA_VERSION,
		);
		expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
			reason: "INDEX_VERSION_UNSUPPORTED",
		});
		index.database.close();
	});

	test("excludes every app-owned database, journal, and chat path", () => {
		const root = temporaryStores();
		const index = initializeFileIndex(root);
		for (const ownedPath of [
			index.filename,
			path.join(root, "journal", "operations", "operation.json"),
			path.join(root, "chat", "history", "chat.json"),
		]) {
			expect(index.isExcludedPath(ownedPath)).toBe(true);
		}
		expect(
			isInsideAppData(path.join(root, "..", "Granted", "file.txt"), root),
		).toBe(false);
		index.database.close();
	});
});
