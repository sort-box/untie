import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { LocalStoreError, initializeLocalStores } = require("./local-store.cjs");

const temporaryDirectories = [];

function temporaryDirectory() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "untie-store-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function manifest(root, store) {
	return JSON.parse(
		fs.readFileSync(path.join(root, store, "store.json"), "utf8"),
	);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("local stores", () => {
	test("initializes isolated, versioned database, journal, and chat stores", () => {
		const root = temporaryDirectory();
		const result = initializeLocalStores(root);

		expect(Object.keys(result.stores)).toEqual(["db", "journal", "chat"]);
		for (const store of ["db", "journal", "chat"]) {
			expect(manifest(root, store)).toEqual({
				store,
				version: store === "chat" ? 2 : 1,
			});
			expect(result.stores[store].directory).toBe(path.join(root, store));
		}
		expect(fs.statSync(path.join(root, "db", "index.sqlite")).isFile()).toBe(
			true,
		);
		expect(
			fs.statSync(path.join(root, "journal", "operations")).isDirectory(),
		).toBe(true);
		expect(fs.statSync(path.join(root, "chat", "history")).isDirectory()).toBe(
			true,
		);
		expect(
			fs.statSync(path.join(root, "chat", "attachments")).isDirectory(),
		).toBe(true);
	});

	test("migrates a v1 chat store to v2 once while preserving existing data", () => {
		const root = temporaryDirectory();
		const chat = path.join(root, "chat");
		fs.mkdirSync(path.join(chat, "history"), { recursive: true });
		fs.writeFileSync(
			path.join(chat, "store.json"),
			JSON.stringify({ store: "chat", version: 1 }),
		);
		fs.writeFileSync(path.join(chat, "history", "chat-1.json"), "user data");

		initializeLocalStores(root);
		initializeLocalStores(root);

		expect(manifest(root, "chat")).toEqual({ store: "chat", version: 2 });
		expect(fs.statSync(path.join(chat, "attachments")).isDirectory()).toBe(
			true,
		);
		expect(
			fs.readFileSync(path.join(chat, "history", "chat-1.json"), "utf8"),
		).toBe("user data");
	});

	test.each([
		["corrupt", "{not-json", "STORE_CORRUPT"],
		[
			"newer",
			JSON.stringify({ store: "db", version: 99 }),
			"STORE_VERSION_UNSUPPORTED",
		],
	])("fails safely for a %s store without changing its bytes", (_name, contents, code) => {
		const root = temporaryDirectory();
		initializeLocalStores(root);
		const manifestPath = path.join(root, "db", "store.json");
		fs.writeFileSync(manifestPath, contents);
		const before = fs.readFileSync(manifestPath);

		expect(() => initializeLocalStores(root)).toThrowError(
			expect.objectContaining({ name: "LocalStoreError", code, store: "db" }),
		);
		expect(fs.readFileSync(manifestPath)).toEqual(before);
	});

	test("keeps the original store intact when a migration fails", () => {
		const root = temporaryDirectory();
		initializeLocalStores(root);
		const sentinel = path.join(root, "db", "index.sqlite");
		fs.writeFileSync(sentinel, "user data");

		let caught;
		try {
			initializeLocalStores(root, {
				definitions: {
					db: { version: 2, entries: ["index.sqlite"] },
					journal: { version: 1, entries: ["operations"] },
					chat: { version: 1, entries: ["history"] },
				},
				migrations: {
					db: {
						1: (directory) => {
							fs.writeFileSync(path.join(directory, "index.sqlite"), "damaged");
							throw new Error("nope");
						},
					},
				},
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LocalStoreError);
		expect(caught).toMatchObject({
			code: "STORE_MIGRATION_FAILED",
			store: "db",
		});
		expect(fs.readFileSync(sentinel, "utf8")).toBe("user data");
		expect(manifest(root, "db")).toEqual({ store: "db", version: 1 });
	});

	test("reports a permission-denied app data directory without changing it", () => {
		if (process.platform === "win32") return;
		const root = temporaryDirectory();
		const sentinel = path.join(root, "user-data");
		fs.writeFileSync(sentinel, "keep me");
		fs.chmodSync(root, 0o000);

		try {
			expect(() => initializeLocalStores(root)).toThrowError(
				expect.objectContaining({
					name: "LocalStoreError",
					code: "APP_DATA_UNAVAILABLE",
					store: "root",
				}),
			);
		} finally {
			fs.chmodSync(root, 0o700);
		}

		expect(fs.readFileSync(sentinel, "utf8")).toBe("keep me");
	});

	test("recovers store data after an interrupted migration swap instead of silently resetting", () => {
		const root = temporaryDirectory();
		const chat = path.join(root, "chat");
		fs.mkdirSync(path.join(chat, "history"), { recursive: true });
		fs.writeFileSync(
			path.join(chat, "store.json"),
			JSON.stringify({ store: "chat", version: 1 }),
		);
		fs.writeFileSync(path.join(chat, "history", "chat-1.json"), "user data");

		// Simulate a crash mid-swap: the store dir was renamed to a backup and a
		// staging copy exists, but the process died before staging -> directory.
		const backup = `${chat}.backup-crash`;
		const staging = `${chat}.migrating-crash`;
		fs.renameSync(chat, backup);
		fs.cpSync(backup, staging, { recursive: true });
		expect(fs.existsSync(chat)).toBe(false);

		initializeLocalStores(root);

		// The store is restored (not silently reset) and migrated forward.
		expect(fs.existsSync(chat)).toBe(true);
		expect(
			fs.readFileSync(path.join(chat, "history", "chat-1.json"), "utf8"),
		).toBe("user data");
		expect(manifest(root, "chat")).toEqual({ store: "chat", version: 2 });
		// Recovery leftovers are cleaned up.
		expect(fs.existsSync(backup)).toBe(false);
		expect(fs.existsSync(staging)).toBe(false);
	});

	test("discards stale swap leftovers when the store is present", () => {
		const root = temporaryDirectory();
		initializeLocalStores(root);
		const staleBackup = path.join(root, "db.backup-stale");
		fs.mkdirSync(staleBackup, { recursive: true });
		fs.writeFileSync(
			path.join(staleBackup, "store.json"),
			JSON.stringify({ store: "db", version: 1 }),
		);

		initializeLocalStores(root);

		expect(fs.existsSync(staleBackup)).toBe(false);
		expect(manifest(root, "db")).toEqual({ store: "db", version: 1 });
	});

	test("fails loudly when a store is missing with an incomplete migration and no backup", () => {
		const root = temporaryDirectory();
		initializeLocalStores(root);
		fs.rmSync(path.join(root, "journal"), { recursive: true, force: true });
		fs.mkdirSync(path.join(root, "journal.migrating-orphan"), {
			recursive: true,
		});

		expect(() => initializeLocalStores(root)).toThrowError(
			expect.objectContaining({
				name: "LocalStoreError",
				code: "STORE_RECOVERY_FAILED",
				store: "journal",
			}),
		);
	});
});
