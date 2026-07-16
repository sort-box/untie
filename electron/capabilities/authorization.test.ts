import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
	isContained,
} = require("./authorization.cjs");

const temporaryDirectories: string[] = [];
let root: string;
let granted: string;
let outside: string;
let store: InstanceType<typeof CapabilityReferenceStore>;

function addGrant(overrides = {}) {
	store.setGrant({
		id: "grant-1",
		path: granted,
		status: "active",
		revision: 3,
		...overrides,
	});
}

function addItem(id: string, itemPath: string, overrides = {}) {
	store.setItem({
		id,
		path: itemPath,
		grantId: "grant-1",
		grantRevision: 3,
		...overrides,
	});
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-auth-test-"));
	temporaryDirectories.push(root);
	granted = path.join(root, "Granted");
	outside = path.join(root, "Outside");
	fs.mkdirSync(granted);
	fs.mkdirSync(outside);
	store = new CapabilityReferenceStore();
});

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("capability authorization", () => {
	it("authorizes a legitimate opaque item inside its active grant", () => {
		const file = path.join(granted, "notes.txt");
		fs.writeFileSync(file, "notes");
		addGrant();
		addItem("item-1", file);

		const result = createCapabilityAuthorizer({ store }).resolveItem("item-1");

		expect(result.canonicalPath).toBe(fs.realpathSync.native(file));
		expect(result.identity).toEqual(
			expect.objectContaining({
				dev: expect.any(Number),
				ino: expect.any(Number),
			}),
		);
	});

	it.each([
		"Granted-evil",
		"GrantedSibling",
	])("rejects the string-prefix sibling trick %s", (siblingName) => {
		const sibling = path.join(root, siblingName);
		fs.mkdirSync(sibling);
		const file = path.join(sibling, "secret.txt");
		fs.writeFileSync(file, "secret");
		addGrant();
		addItem("item-evil", file);

		expect(() =>
			createCapabilityAuthorizer({ store }).resolveItem("item-evil"),
		).toThrowError(expect.objectContaining({ code: "NOT_CONTAINED" }));
		expect(isContained(granted, sibling)).toBe(false);
	});

	it("rejects a symlink inside the grant that escapes outside", () => {
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(secret, "secret");
		const link = path.join(granted, "escape.txt");
		fs.symlinkSync(secret, link);
		addGrant();
		addItem("item-link", link);

		expect(() =>
			createCapabilityAuthorizer({ store }).resolveItem("item-link"),
		).toThrowError(expect.objectContaining({ code: "NOT_CONTAINED" }));
	});

	it("rejects dot-dot traversal after canonical resolution", () => {
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(secret, "secret");
		addGrant();
		addItem(
			"item-traversal",
			path.join(granted, "..", "Outside", "secret.txt"),
		);

		expect(() =>
			createCapabilityAuthorizer({ store }).resolveItem("item-traversal"),
		).toThrowError(expect.objectContaining({ code: "NOT_CONTAINED" }));
	});

	it("rejects a renderer-supplied raw path instead of treating it as an ID", () => {
		addGrant();

		expect(() =>
			createCapabilityAuthorizer({ store }).resolveItem(
				path.join(granted, "notes.txt"),
			),
		).toThrowError(expect.objectContaining({ code: "PATH_SUPPLIED" }));
	});

	it("rejects an item backed by a revoked or missing grant", () => {
		const file = path.join(granted, "notes.txt");
		fs.writeFileSync(file, "notes");
		addItem("item-1", file);
		const authorizer = createCapabilityAuthorizer({ store });

		expect(() => authorizer.resolveItem("item-1")).toThrowError(
			expect.objectContaining({ code: "REVOKED_GRANT" }),
		);

		addGrant({ status: "revoked" });
		expect(() => authorizer.resolveItem("item-1")).toThrowError(
			expect.objectContaining({ code: "REVOKED_GRANT" }),
		);
	});

	it("rejects stale grants and stale item revisions", () => {
		const file = path.join(granted, "notes.txt");
		fs.writeFileSync(file, "notes");
		addGrant({ status: "stale" });
		addItem("item-1", file);
		const authorizer = createCapabilityAuthorizer({ store });

		expect(() => authorizer.resolveItem("item-1")).toThrowError(
			expect.objectContaining({ code: "STALE_REFERENCE" }),
		);

		addGrant();
		addItem("item-1", file, { grantRevision: 2 });
		expect(() => authorizer.resolveItem("item-1")).toThrowError(
			expect.objectContaining({ code: "STALE_REFERENCE" }),
		);
	});

	it("rejects a target swapped to an escaping symlink on reauthorization", () => {
		const file = path.join(granted, "notes.txt");
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(file, "notes");
		fs.writeFileSync(secret, "secret");
		addGrant();
		addItem("item-1", file);
		const authorizer = createCapabilityAuthorizer({ store });
		authorizer.resolveItem("item-1");
		fs.unlinkSync(file);
		fs.symlinkSync(secret, file);

		expect(() => authorizer.resolveItem("item-1")).toThrowError(
			expect.objectContaining({ code: "NOT_CONTAINED" }),
		);
	});

	it("rejects replacement of the granted root with a symlink", () => {
		const file = path.join(granted, "notes.txt");
		fs.writeFileSync(file, "notes");
		addGrant();
		addItem("item-1", file);
		const authorizer = createCapabilityAuthorizer({ store });
		authorizer.resolveItem("item-1");
		fs.rmSync(granted, { recursive: true });
		fs.symlinkSync(outside, granted);

		expect(() => authorizer.resolveItem("item-1")).toThrowError(
			expect.objectContaining({ code: "STALE_REFERENCE" }),
		);
	});

	it.each([
		["scanFolder", { grantId: "grant-1" }],
		["classifyFolderRisk", { grantId: "grant-1" }],
		[
			"preparePlan",
			{
				grantId: "grant-1",
				operations: [
					{ itemId: "item-1", destination: { newFolderName: "Docs" } },
				],
			},
		],
		["applyPlan", { planId: "plan-1" }],
		["undo", { operationId: "operation-1" }],
		["revealItem", { itemId: "item-1" }],
		["openItem", { itemId: "item-1" }],
	])("rejects revoked grants before the %s capability runs", (capability, input) => {
		const file = path.join(granted, "notes.txt");
		fs.writeFileSync(file, "notes");
		addGrant({ status: "revoked", revision: 4 });
		addItem("item-1", file, { status: "invalidated" });
		store.setPlan({
			id: "plan-1",
			grantId: "grant-1",
			grantRevision: 3,
			status: "invalidated",
		});
		store.setOperation({
			id: "operation-1",
			grantId: "grant-1",
			grantRevision: 3,
			status: "invalidated",
		});

		expect(() =>
			createCapabilityAuthorizer({ store }).authorize(capability, input),
		).toThrowError(expect.objectContaining({ code: "REVOKED_GRANT" }));
	});
});
