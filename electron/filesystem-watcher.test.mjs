import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createFilesystemWatcher } = require("./filesystem-watcher.cjs");

const temporaryDirectories = [];

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-watch-test-"));
	temporaryDirectories.push(root);
	const granted = path.join(root, "Granted");
	fs.mkdirSync(granted);
	let listener;
	const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
	const fsApi = {
		...fs,
		watch: vi.fn((watchedPath, callback) => {
			expect(watchedPath).toBe(fs.realpathSync.native(granted));
			listener = callback;
			return handle;
		}),
	};
	const indexSync = { markStale: vi.fn() };
	const onCoalescedChange = vi.fn();
	const watcher = createFilesystemWatcher({
		authorizer: {
			resolveGrant: () => ({ canonicalPath: fs.realpathSync.native(granted) }),
		},
		indexSync,
		onCoalescedChange,
		fsApi,
		debounceMs: 50,
		setTimer: setTimeout,
		clearTimer: clearTimeout,
	});
	watcher.watchGrant("grant_test");
	return {
		granted,
		handle,
		indexSync,
		listener: () => listener(),
		onCoalescedChange,
		watcher,
	};
}

afterEach(() => {
	vi.useRealTimers();
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("best-effort filesystem watching", () => {
	test("coalesces a burst into one change signal", () => {
		vi.useFakeTimers();
		const { indexSync, listener, onCoalescedChange } = setup();

		listener();
		listener();
		listener();
		expect(indexSync.markStale).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(49);
		expect(onCoalescedChange).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(onCoalescedChange).toHaveBeenCalledOnce();
		expect(onCoalescedChange).toHaveBeenCalledWith({ grantId: "grant_test" });
	});

	test("an overflow or watcher error marks the index stale and removes the watcher", () => {
		const { handle, indexSync, watcher } = setup();

		handle.emit(
			"error",
			Object.assign(new Error("event queue overflow"), {
				code: "ENOSPC",
			}),
		);

		expect(indexSync.markStale).toHaveBeenCalledWith("grant_test");
		expect(handle.close).toHaveBeenCalledOnce();
		expect(watcher.isWatching("grant_test")).toBe(false);
	});

	test("revocation and folder deletion tear down their watcher", () => {
		const revoked = setup();
		revoked.watcher.reconcileGrant({
			grantId: "grant_test",
			state: "revoked",
		});
		expect(revoked.handle.close).toHaveBeenCalledOnce();
		expect(revoked.watcher.isWatching("grant_test")).toBe(false);

		const deleted = setup();
		fs.rmSync(deleted.granted, { recursive: true });
		deleted.listener();
		expect(deleted.indexSync.markStale).toHaveBeenCalledWith("grant_test");
		expect(deleted.handle.close).toHaveBeenCalledOnce();
		expect(deleted.watcher.isWatching("grant_test")).toBe(false);
	});
});
