import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
}: typeof import("./capabilities/authorization.cjs") = require("./capabilities/authorization.cjs");
const {
	FILE_ID_PATTERN,
	createOpaqueFileRegistry,
}: typeof import("./opaque-file-registry.cjs") = require("./opaque-file-registry.cjs");

const temporaryDirectories: string[] = [];
let folder: string;
let file: string;
let now: number;
let store: InstanceType<typeof CapabilityReferenceStore>;

function addGrant(status = "active", revision = 1) {
	store.setGrant({ id: "grant-1", path: folder, status, revision });
}

function createRegistry(ttlMs = 1_000) {
	return createOpaqueFileRegistry({
		referenceStore: store,
		now: () => now,
		ttlMs,
	});
}

function scan(registry: ReturnType<typeof createRegistry>) {
	return registry.registerScan({
		grant: store.getGrant("grant-1"),
		canonicalGrantPath: fs.realpathSync.native(folder),
		files: [{ name: "notes.txt" }],
	});
}

beforeEach(() => {
	folder = fs.mkdtempSync(path.join(os.tmpdir(), "untie-file-id-"));
	temporaryDirectories.push(folder);
	file = path.join(folder, "notes.txt");
	fs.writeFileSync(file, "notes");
	now = 10_000;
	store = new CapabilityReferenceStore();
	addGrant();
});

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("opaque file registry", () => {
	it("issues a stable path-free renderer surface and resolves only in main", () => {
		const registry = createRegistry();
		const first = scan(registry);
		const second = scan(registry);

		expect(first).toEqual(second);
		expect(first).toEqual([
			{ itemId: expect.stringMatching(FILE_ID_PATTERN), name: "notes.txt" },
		]);
		expect(JSON.stringify(first)).not.toContain(folder);
		expect(Object.keys(first[0] ?? {}).sort()).toEqual(["itemId", "name"]);
		expect(
			createCapabilityAuthorizer({ store, now: () => now }).resolveItem(
				first[0]?.itemId,
			),
		).toMatchObject({ canonicalPath: fs.realpathSync.native(file) });
	});

	it("rejects an expired ID with a typed error", () => {
		const issued = scan(createRegistry(50));
		now += 50;

		expect(() =>
			createCapabilityAuthorizer({ store, now: () => now }).resolveItem(
				issued[0]?.itemId,
			),
		).toThrowError(expect.objectContaining({ code: "EXPIRED_ID" }));
	});

	it("rejects an ID after its backing grant is revoked", () => {
		const issued = scan(createRegistry());
		addGrant("revoked", 2);

		expect(() =>
			createCapabilityAuthorizer({ store, now: () => now }).resolveItem(
				issued[0]?.itemId,
			),
		).toThrowError(expect.objectContaining({ code: "REVOKED_GRANT" }));
	});

	it("invalidates the old ID when a re-scan sees a changed source", () => {
		const registry = createRegistry();
		const oldId = scan(registry)[0]?.itemId;
		fs.writeFileSync(file, "changed and larger");
		const newId = scan(registry)[0]?.itemId;

		expect(newId).not.toBe(oldId);
		expect(() =>
			createCapabilityAuthorizer({ store, now: () => now }).resolveItem(oldId),
		).toThrowError(expect.objectContaining({ code: "INVALIDATED_ID" }));
		expect(
			createCapabilityAuthorizer({ store, now: () => now }).resolveItem(newId),
		).toMatchObject({ canonicalPath: fs.realpathSync.native(file) });
	});

	it("rejects an ID immediately when the immutable snapshot changes on disk", () => {
		const issued = scan(createRegistry());
		fs.writeFileSync(file, "changed and larger");

		expect(() =>
			createCapabilityAuthorizer({ store, now: () => now }).resolveItem(
				issued[0]?.itemId,
			),
		).toThrowError(expect.objectContaining({ code: "INVALIDATED_ID" }));
	});
});
