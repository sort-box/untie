import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
} = require("./capabilities/authorization.cjs");
const { createFolderScanner } = require("./folder-scanner.cjs");
const { initializeFileIndex } = require("./index-store.cjs");
const { createIndexSynchronizationEngine } = require("./index-sync.cjs");
const { initializeLocalStores } = require("./local-store.cjs");

const temporaryDirectories = [];

function setup(options = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-sync-test-"));
	temporaryDirectories.push(root);
	const granted = path.join(root, "Granted");
	const stores = path.join(root, "Untie Data", "stores");
	fs.mkdirSync(granted, { recursive: true });
	initializeLocalStores(stores);
	const index = initializeFileIndex(stores);
	const references = new CapabilityReferenceStore();
	references.setGrant({
		id: "grant_test",
		path: granted,
		status: "active",
		revision: 1,
	});
	const authorizer = createCapabilityAuthorizer({ store: references });
	const scanner = createFolderScanner({
		appDataDirectory: path.join(root, "Untie Data"),
	});
	const engine = createIndexSynchronizationEngine({
		index,
		scanner,
		authorizer,
		...options,
	});
	return { root, granted, stores, index, references, engine };
}

function rows(database) {
	return database
		.prepare(`
		SELECT i.id, i.identity_key, p.current_path, p.filename, p.size_bytes
		FROM file_identities i JOIN file_paths p ON p.file_id = i.id
		ORDER BY p.filename
	`)
		.all();
}

function identityRows(database) {
	return database
		.prepare(
			"SELECT id, identity_key, created_at_ms FROM file_identities ORDER BY id",
		)
		.all();
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("grant-scoped index synchronization", () => {
	test("fresh sync inserts metadata and exposes readiness status", async () => {
		const { granted, index, engine } = setup();
		fs.writeFileSync(path.join(granted, "report.txt"), "hello");

		expect(engine.getStatus("grant_test")).toEqual({
			state: "idle",
			lastSyncedAt: null,
			counts: { indexed: 0, added: 0, updated: 0, removed: 0 },
		});
		const result = await engine.syncGrant("grant_test");

		expect(result.state).toBe("idle");
		expect(result.lastSyncedAt).toEqual(expect.any(Number));
		expect(result.counts).toEqual({
			indexed: 1,
			added: 1,
			updated: 0,
			removed: 0,
		});
		expect(rows(index.database)).toEqual([
			expect.objectContaining({ filename: "report.txt", size_bytes: 5 }),
		]);
		expect(
			index.database.prepare("SELECT filename FROM file_search").all(),
		).toEqual([{ filename: "report.txt" }]);
		index.database.close();
	});

	test("re-sync adds, updates, removes, and treats a rename as the same identity", async () => {
		const { granted, index, engine } = setup();
		const movedFrom = path.join(granted, "before.txt");
		const modified = path.join(granted, "modified.md");
		const removed = path.join(granted, "removed.pdf");
		fs.writeFileSync(movedFrom, "move");
		fs.writeFileSync(modified, "old");
		fs.writeFileSync(removed, "remove");
		await engine.syncGrant("grant_test");
		const original = rows(index.database);
		const movedIdentity = original.find((row) => row.filename === "before.txt");

		fs.renameSync(movedFrom, path.join(granted, "after.txt"));
		fs.writeFileSync(modified, "new and longer");
		fs.rmSync(removed);
		fs.writeFileSync(path.join(granted, "added.docx"), "added");
		const result = await engine.syncGrant("grant_test");
		const current = rows(index.database);

		expect(result.counts).toEqual({
			indexed: 3,
			added: 1,
			updated: 2,
			removed: 1,
		});
		expect(current.map((row) => row.filename)).toEqual([
			"added.docx",
			"after.txt",
			"modified.md",
		]);
		expect(current.find((row) => row.filename === "after.txt")?.id).toBe(
			movedIdentity.id,
		);
		expect(new Set(current.map((row) => row.identity_key)).size).toBe(3);
		expect(
			index.database.prepare("SELECT count(*) AS count FROM file_search").get()
				.count,
		).toBe(3);
		index.database.close();
	});

	test("overlapping grants retain shared identities until the last membership is removed", async () => {
		let scanCount = 0;
		const { granted, index, engine, references } = setup({
			scanner: {
				async scanFolder() {
					scanCount += 1;
					return {
						files: scanCount === 3 ? [] : [{ name: "shared.txt" }],
						candidateDestinations: [],
						skipped: [],
					};
				},
			},
			now: (() => {
				let value = 1_000;
				return () => value++;
			})(),
		});
		references.setGrant({
			id: "grant_b",
			path: granted,
			status: "active",
			revision: 1,
		});
		fs.writeFileSync(path.join(granted, "shared.txt"), "shared");

		await engine.syncGrant("grant_test");
		const originalIdentity = identityRows(index.database)[0];
		await engine.syncGrant("grant_b");

		expect(
			index.database
				.prepare(
					"SELECT grant_id, file_id FROM indexed_grants ORDER BY grant_id",
				)
				.all(),
		).toEqual([
			{ grant_id: "grant_b", file_id: originalIdentity.id },
			{ grant_id: "grant_test", file_id: originalIdentity.id },
		]);
		expect(identityRows(index.database)).toEqual([originalIdentity]);

		await engine.syncGrant("grant_b");

		expect(identityRows(index.database)).toEqual([originalIdentity]);
		expect(
			index.database.prepare("SELECT file_id FROM file_search").all(),
		).toEqual([{ file_id: originalIdentity.id }]);
		expect(
			index.database.prepare("SELECT grant_id FROM indexed_grants").all(),
		).toEqual([{ grant_id: "grant_test" }]);
		index.database.close();
	});

	test("an intra-grant path swap preserves identities and index integrity", async () => {
		const { granted, index, engine } = setup();
		const aPath = path.join(granted, "a.txt");
		const bPath = path.join(granted, "b.txt");
		const temporaryPath = path.join(granted, "swap.tmp-name");
		fs.writeFileSync(aPath, "a");
		fs.writeFileSync(bPath, "b");
		await engine.syncGrant("grant_test");
		const originalIdentities = identityRows(index.database);
		const originalByKey = new Map(
			rows(index.database).map((row) => [row.identity_key, row]),
		);

		fs.renameSync(aPath, temporaryPath);
		fs.renameSync(bPath, aPath);
		fs.renameSync(temporaryPath, bPath);
		await engine.syncGrant("grant_test");

		const currentByKey = new Map(
			rows(index.database).map((row) => [row.identity_key, row]),
		);
		for (const [identityKey, original] of originalByKey) {
			const current = currentByKey.get(identityKey);
			expect(current.id).toBe(original.id);
			expect(current.filename).not.toBe(original.filename);
		}
		expect(identityRows(index.database)).toEqual(originalIdentities);
		expect(index.database.prepare("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});
		expect(index.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
			[],
		);
		index.database.close();
	});

	test("cancellation during mutation rolls the entire batch back", async () => {
		const controller = new AbortController();
		let mutations = 0;
		const { granted, index, engine } = setup({
			onMutation: () => {
				mutations += 1;
				if (mutations === 2) controller.abort();
			},
		});
		fs.writeFileSync(path.join(granted, "keep.txt"), "original");
		await engine.syncGrant("grant_test");
		const before = rows(index.database);
		mutations = 0;
		fs.writeFileSync(path.join(granted, "one.txt"), "one");
		fs.writeFileSync(path.join(granted, "two.txt"), "two");

		await expect(
			engine.syncGrant("grant_test", { signal: controller.signal }),
		).rejects.toMatchObject({ code: "CANCELLED" });

		expect(rows(index.database)).toEqual(before);
		expect(
			index.database.prepare("SELECT count(*) AS count FROM file_search").get()
				.count,
		).toBe(1);
		expect(engine.getStatus("grant_test").counts.indexed).toBe(1);
		index.database.close();
	});

	test("never indexes the app database or journal", async () => {
		const { root, index, engine } = setup();
		const appData = path.join(root, "Untie Data");
		const references = new CapabilityReferenceStore();
		references.setGrant({
			id: "grant_app_data_parent",
			path: root,
			status: "active",
			revision: 1,
		});
		const parentEngine = createIndexSynchronizationEngine({
			index,
			scanner: createFolderScanner({ appDataDirectory: appData }),
			authorizer: createCapabilityAuthorizer({ store: references }),
		});
		fs.writeFileSync(path.join(root, "visible.txt"), "visible");

		await parentEngine.syncGrant("grant_app_data_parent");

		expect(rows(index.database).map((row) => row.filename)).toEqual([
			"visible.txt",
		]);
		expect(
			rows(index.database).some((row) =>
				row.current_path.includes("index.sqlite"),
			),
		).toBe(false);
		expect(
			rows(index.database).some((row) => row.current_path.includes("journal")),
		).toBe(false);
		expect(engine.getStatus("grant_test").state).toBe("idle");
		index.database.close();
	});
});
