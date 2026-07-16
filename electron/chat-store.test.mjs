import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	CHAT_SCHEMA_VERSION,
	ChatStoreError,
	createChatStore,
} = require("./chat-store.cjs");

const temporaryDirectories = [];

function temporaryHistory() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-chat-test-"));
	temporaryDirectories.push(root);
	return path.join(root, "chat", "history");
}

const NOW = 1_700_000_000_000;

function sampleMessages() {
	return [
		{ kind: "user", id: "m1", createdAt: NOW, text: "Sort my Downloads" },
		{
			kind: "plan",
			id: "m2",
			createdAt: NOW + 5,
			summary: "3 files into 2 folders",
			fileCount: 3,
			folderCount: 2,
			createdFolderCount: 1,
			folders: [
				{ name: "Invoices", fileCount: 2, isNew: false, examples: ["a.pdf"] },
				{ name: "Photos", fileCount: 1, isNew: true, examples: ["b.jpg"] },
			],
		},
		{
			kind: "result",
			id: "m3",
			createdAt: NOW + 10,
			summary: "Moved 3 files.",
			movedCount: 3,
			folderCount: 2,
			createdFolderCount: 1,
		},
	];
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("chat store round-trip", () => {
	test("persists a session's messages so they survive a relaunch", () => {
		const history = temporaryHistory();
		const messages = sampleMessages();

		const writer = createChatStore(history);
		const saved = writer.saveSession({
			id: "session-1",
			createdAt: NOW,
			messages,
		});
		expect(saved.session.title).toBe("Sort my Downloads");
		expect(saved.session.updatedAt).toBe(NOW + 10);

		// A brand-new store instance over the same directory stands in for a
		// process relaunch: nothing is kept in memory.
		const relaunched = createChatStore(history);
		const loaded = relaunched.loadSession("session-1");
		expect(loaded.session).not.toBeNull();
		expect(loaded.session.messages).toEqual(messages);
		expect(loaded.session.title).toBe("Sort my Downloads");
		expect(loaded.session.createdAt).toBe(NOW);

		const listed = relaunched.listSessions();
		expect(listed.sessions).toEqual([
			{
				id: "session-1",
				title: "Sort my Downloads",
				createdAt: NOW,
				updatedAt: NOW + 10,
				messageCount: 3,
			},
		]);
	});

	test("lists sessions newest-activity first", () => {
		const store = createChatStore(temporaryHistory());
		store.saveSession({
			id: "older",
			createdAt: NOW,
			messages: [{ kind: "user", id: "u", createdAt: NOW, text: "one" }],
		});
		store.saveSession({
			id: "newer",
			createdAt: NOW,
			messages: [{ kind: "user", id: "u", createdAt: NOW + 999, text: "two" }],
		});

		expect(store.listSessions().sessions.map((s) => s.id)).toEqual([
			"newer",
			"older",
		]);
	});

	test("returns null for a missing session and empty for a fresh store", () => {
		const store = createChatStore(temporaryHistory());
		expect(store.loadSession("nope")).toEqual({ session: null });
		expect(store.listSessions()).toEqual({ sessions: [] });
	});
});

describe("chat store schema migration", () => {
	test("migrates a v1 on-disk payload to the current schema on open", () => {
		const history = temporaryHistory();
		fs.mkdirSync(history, { recursive: true });
		const legacy = {
			schemaVersion: 1,
			id: "legacy-1",
			createdAt: NOW,
			messages: [
				{ kind: "user", id: "m1", createdAt: NOW, text: "Find my lease" },
				{
					kind: "failed",
					id: "m2",
					createdAt: NOW + 7,
					title: "Timed out",
					detail: "No plan came back.",
					retryable: true,
				},
			],
		};
		fs.writeFileSync(
			path.join(history, "legacy-1.json"),
			JSON.stringify(legacy),
		);

		const store = createChatStore(history);
		const { session } = store.loadSession("legacy-1");

		// v1 had neither field; v2 derives both from the transcript.
		expect(session.title).toBe("Find my lease");
		expect(session.updatedAt).toBe(NOW + 7);
		expect(session.createdAt).toBe(NOW);
		expect(session.messages).toEqual(legacy.messages);

		// The upgrade is written back once so the file is now at the current schema.
		const onDisk = JSON.parse(
			fs.readFileSync(path.join(history, "legacy-1.json"), "utf8"),
		);
		expect(onDisk.schemaVersion).toBe(CHAT_SCHEMA_VERSION);
		expect(onDisk.title).toBe("Find my lease");
		expect(onDisk.updatedAt).toBe(NOW + 7);
	});

	test("treats a payload without a schema version as the earliest schema", () => {
		const history = temporaryHistory();
		fs.mkdirSync(history, { recursive: true });
		fs.writeFileSync(
			path.join(history, "unversioned.json"),
			JSON.stringify({
				id: "unversioned",
				createdAt: NOW,
				messages: [{ kind: "user", id: "m1", createdAt: NOW, text: "Hello" }],
			}),
		);

		const { session } = createChatStore(history).loadSession("unversioned");
		expect(session.title).toBe("Hello");
		expect(session.updatedAt).toBe(NOW);
	});

	test("refuses a session written by a newer, unknown schema", () => {
		const history = temporaryHistory();
		fs.mkdirSync(history, { recursive: true });
		fs.writeFileSync(
			path.join(history, "future.json"),
			JSON.stringify({
				schemaVersion: CHAT_SCHEMA_VERSION + 50,
				id: "future",
				title: "From the future",
				createdAt: NOW,
				updatedAt: NOW,
				messages: [],
			}),
		);

		expect(() => createChatStore(history).loadSession("future")).toThrowError(
			expect.objectContaining({
				name: "ChatStoreError",
				code: "CHAT_VERSION_UNSUPPORTED",
			}),
		);
	});

	test("skips a single corrupt session instead of failing the whole list", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const history = temporaryHistory();
		const store = createChatStore(history);
		store.saveSession({
			id: "good",
			createdAt: NOW,
			messages: [{ kind: "user", id: "u", createdAt: NOW, text: "ok" }],
		});
		fs.writeFileSync(path.join(history, "broken.json"), "{ not valid json");

		expect(store.listSessions().sessions.map((s) => s.id)).toEqual(["good"]);
	});
});

describe("chat store retention & deletion", () => {
	test("deletes a single chat idempotently", () => {
		const store = createChatStore(temporaryHistory());
		store.saveSession({
			id: "keep",
			createdAt: NOW,
			messages: [{ kind: "user", id: "u", createdAt: NOW, text: "keep" }],
		});
		store.saveSession({
			id: "drop",
			createdAt: NOW,
			messages: [{ kind: "user", id: "u", createdAt: NOW, text: "drop" }],
		});

		expect(store.deleteSession("drop")).toEqual({ deleted: true });
		expect(store.deleteSession("drop")).toEqual({ deleted: false });
		expect(store.listSessions().sessions.map((s) => s.id)).toEqual(["keep"]);
	});

	test("delete-all wipes every persisted chat", () => {
		const history = temporaryHistory();
		const store = createChatStore(history);
		for (const id of ["one", "two", "three"]) {
			store.saveSession({
				id,
				createdAt: NOW,
				messages: [{ kind: "user", id: "u", createdAt: NOW, text: id }],
			});
		}

		expect(store.deleteAll()).toEqual({ deletedCount: 3 });
		expect(store.listSessions()).toEqual({ sessions: [] });
		expect(createChatStore(history).listSessions()).toEqual({ sessions: [] });
	});

	test("delete-all on a fresh store reports nothing removed", () => {
		expect(createChatStore(temporaryHistory()).deleteAll()).toEqual({
			deletedCount: 0,
		});
	});
});

describe("chat store id safety", () => {
	test("rejects a path-shaped session id before touching the filesystem", () => {
		const store = createChatStore(temporaryHistory());
		for (const unsafe of ["../escape", "a/b", "", ".", ".."]) {
			expect(() => store.loadSession(unsafe)).toThrowError(
				expect.objectContaining({
					name: "ChatStoreError",
					code: "CHAT_INVALID_ID",
				}),
			);
		}
		expect(() =>
			store.saveSession({ id: "../evil", createdAt: NOW, messages: [] }),
		).toThrowError(ChatStoreError);
	});
});
