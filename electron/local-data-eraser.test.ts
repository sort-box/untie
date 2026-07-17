import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { createLocalDataEraser } = require("./local-data-eraser.cjs");
const { initializeLocalStores } = require("./local-store.cjs");
const { initializeFileIndex } = require("./index-store.cjs");

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "untie-erase-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("local data eraser", () => {
	it("stops and closes services before removal, then recreates and clears", async () => {
		const calls: string[] = [];
		const root = path.resolve("/app-data");
		const stores = path.join(root, "stores");
		const eraser = createLocalDataEraser({
			localDataDirectory: root,
			fsApi: {
				rmSync(candidate: string) {
					expect(candidate).toBe(stores);
					calls.push("remove");
				},
			},
			services: {
				stopFilesystemWatcher: () => calls.push("watcher"),
				stopIndexSync: () => calls.push("sync"),
				stopExtractionWorkers: () => calls.push("extractors"),
				closeFileIndex: () => calls.push("database"),
				recreateStores: () => calls.push("recreate"),
				clearOpaqueReferences: () => calls.push("references"),
				clearRestoredGrants: () => calls.push("restored-grants"),
			},
		});

		await expect(eraser.eraseAll()).resolves.toEqual({ erased: true });
		expect(calls).toEqual([
			"watcher",
			"sync",
			"extractors",
			"database",
			"remove",
			"recreate",
			"references",
			"restored-grants",
		]);
	});

	it("leaves only clean recreated stores with no sensitive residue", async () => {
		const localData = temporaryDirectory();
		const stores = path.join(localData, "stores");
		const sensitiveFiles = [
			"db/index.sqlite-wal",
			"db/extracted-text-secret",
			"chat/history/conversation.json",
			"chat/attachments/private.txt",
			"journal/operations/operation.json",
			"grants/grants.json",
			"preparedPlans/prepared-plans.json",
			"pins-recent.json",
		];
		for (const relative of sensitiveFiles) {
			const filename = path.join(stores, relative);
			fs.mkdirSync(path.dirname(filename), { recursive: true });
			fs.writeFileSync(filename, `sensitive:${relative}`);
		}

		let recreatedIndex: ReturnType<typeof initializeFileIndex> | undefined;
		const eraser = createLocalDataEraser({
			localDataDirectory: localData,
			services: {
				recreateStores() {
					initializeLocalStores(stores);
					recreatedIndex = initializeFileIndex(stores);
				},
			},
		});
		await eraser.eraseAll();
		recreatedIndex?.database.close();

		const remaining = fs
			.readdirSync(stores, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(entry.parentPath, entry.name));
		for (const filename of remaining) {
			expect(fs.readFileSync(filename, "utf8")).not.toContain("sensitive:");
		}
		expect(fs.existsSync(path.join(stores, "db/index.sqlite-wal"))).toBe(false);
		expect(
			fs.existsSync(path.join(stores, "chat/history/conversation.json")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(stores, "journal/operations/operation.json")),
		).toBe(false);
		expect(fs.existsSync(path.join(stores, "pins-recent.json"))).toBe(false);
	});

	it("rejects an outside removal before calling the filesystem", () => {
		const localData = temporaryDirectory();
		let removals = 0;
		const eraser = createLocalDataEraser({
			localDataDirectory: localData,
			fsApi: { rmSync: () => removals++ },
		});
		expect(() => eraser.removeContained(path.dirname(localData))).toThrow(
			"outside Untie's local-data directory",
		);
		expect(removals).toBe(0);
	});

	it("never removes a sibling sentinel", async () => {
		const parent = temporaryDirectory();
		const localData = path.join(parent, "local-data");
		const sibling = path.join(parent, "user-folder");
		fs.mkdirSync(path.join(localData, "stores"), { recursive: true });
		fs.mkdirSync(sibling);
		const sentinel = path.join(sibling, "keep-me.txt");
		fs.writeFileSync(sentinel, "user data");

		await createLocalDataEraser({ localDataDirectory: localData }).eraseAll();
		expect(fs.readFileSync(sentinel, "utf8")).toBe("user data");
	});
});
