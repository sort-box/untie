import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
}: typeof import("./capabilities/authorization.cjs") = require("./capabilities/authorization.cjs");
const {
	createPreparedPlanStore,
}: typeof import("./prepared-plan-store.cjs") = require("./prepared-plan-store.cjs");
const {
	validateSortPlan,
}: typeof import("./sort-plan-validator.cjs") = require("./sort-plan-validator.cjs");

const directories: string[] = [];
let root: string;
let folder: string;
let now: number;
let references: InstanceType<typeof CapabilityReferenceStore>;
let sequence: number;

function id(kind: "plan" | "file") {
	sequence += 1;
	return `${kind}_${sequence.toString(16).padStart(32, "0")}`;
}

function installItem(itemId: string, name: string) {
	const file = path.join(folder, name);
	fs.writeFileSync(file, name);
	const canonicalPath = fs.realpathSync.native(file);
	const stat = fs.statSync(file);
	references.setItem({
		id: itemId,
		path: canonicalPath,
		grantId: "grant-1",
		grantRevision: 1,
		expiresAt: now + 10_000,
		status: "active",
		snapshot: {
			canonicalPath,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			dev: stat.dev,
			ino: stat.ino,
		},
	});
}

function validated(
	operations = [
		{ itemId: "file-1", destination: { kind: "new", name: "Work" } },
		{ itemId: "file-2", destination: { kind: "new", name: "Work" } },
	],
) {
	return validateSortPlan(
		{ operations },
		{
			files: [
				{ itemId: "file-1", name: "one.txt" },
				{ itemId: "file-2", name: "two.txt" },
				{ itemId: "file-3", name: "excluded.txt" },
			],
			existingDestinations: [],
		},
	);
}

function planInput(
	operations = [
		{ itemId: "file-1", destination: { kind: "new", name: "Work" } },
		{ itemId: "file-2", destination: { kind: "new", name: "Work" } },
	],
) {
	return {
		plan: { operations },
		validationContext: {
			files: [
				{ itemId: "file-1", name: "one.txt" },
				{ itemId: "file-2", name: "two.txt" },
				{ itemId: "file-3", name: "excluded.txt" },
			],
			existingDestinations: [],
		},
	};
}

function store(ttlMs = 1_000) {
	return createPreparedPlanStore({
		directory: root,
		authorizer: createCapabilityAuthorizer({
			store: references,
			now: () => now,
		}),
		now: () => now,
		ttlMs,
		randomUUID: () => id("plan").slice(5),
	});
}

function prepare(planStore = store()) {
	const disclosureManifest = { filenames: 3, snippets: 0 };
	const snapshot = planStore.prepare({
		grantId: "grant-1",
		...planInput(),
		disclosureManifest,
		exclusions: ["file-3"],
	});
	return { planStore, snapshot, disclosureManifest };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-prepared-plan-"));
	directories.push(root);
	folder = fs.mkdtempSync(path.join(root, "grant-"));
	now = 10_000;
	sequence = 0;
	references = new CapabilityReferenceStore();
	references.setGrant({
		id: "grant-1",
		path: folder,
		status: "active",
		revision: 1,
	});
	installItem("file-1", "one.txt");
	installItem("file-2", "two.txt");
	installItem("file-3", "excluded.txt");
});

afterEach(() => {
	for (const directory of directories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("immutable prepared plan store", () => {
	it("records an immutable validated snapshot with exact counts, exclusions, and disclosure hook", () => {
		const { planStore, snapshot, disclosureManifest } = prepare();

		expect(snapshot).toMatchObject({
			schemaVersion: 1,
			grantId: "grant-1",
			grantRevision: 1,
			operationCounts: { createFolder: 1, move: 2 },
			exclusions: ["file-3"],
			disclosureManifest: { filenames: 3, snippets: 0 },
		});
		expect(snapshot.operations).toEqual(validated().operations);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.operations)).toBe(true);
		disclosureManifest.filenames = 99;
		expect(snapshot.disclosureManifest.filenames).toBe(3);

		const binding = planStore.approve({
			snapshotId: snapshot.id,
			fingerprint: snapshot.fingerprint,
		});
		expect(binding).toEqual({
			snapshotId: snapshot.id,
			fingerprint: snapshot.fingerprint,
		});
		expect(planStore.getApproved(binding)).toEqual(snapshot);
	});

	it("creates only from a successful W10 validation result", () => {
		expect(() =>
			store().prepare({
				grantId: "grant-1",
				plan: {
					operations: [
						{ itemId: "unknown", destination: { kind: "new", name: "Work" } },
					],
				},
				validationContext: planInput().validationContext,
			}),
		).toThrowError(expect.objectContaining({ code: "PLAN_NOT_VALIDATED" }));
	});

	it("binds approval to both snapshot ID and content/version fingerprint", () => {
		const { planStore, snapshot } = prepare();
		expect(() =>
			planStore.approve({
				snapshotId: snapshot.id,
				fingerprint: "0".repeat(64),
			}),
		).toThrowError(expect.objectContaining({ code: "BINDING_MISMATCH" }));
	});

	it.each([
		"prepared",
		"approved",
	])("rejects a tampered persisted %s snapshot before approval or apply-read", (status) => {
		const { planStore, snapshot } = prepare();
		if (status === "approved")
			planStore.approve({
				snapshotId: snapshot.id,
				fingerprint: snapshot.fingerprint,
			});
		const storeFile = path.join(root, "prepared-plans.json");
		const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8"));
		persisted.snapshots[0].snapshot.operations[0].destination.name =
			"Secret-Exfil";
		fs.writeFileSync(storeFile, `${JSON.stringify(persisted, null, 2)}\n`);

		expect(() => store()).toThrowError(
			expect.objectContaining({
				name: "PreparedPlanError",
				code: "STORE_CORRUPT",
			}),
		);
		expect(persisted.snapshots[0].snapshot.fingerprint).toBe(
			snapshot.fingerprint,
		);
	});

	it("makes the old snapshot unusable when an edit creates a replacement", () => {
		const { planStore, snapshot } = prepare();
		const replacement = planStore.replace(snapshot.id, {
			grantId: "grant-1",
			...planInput([
				{ itemId: "file-1", destination: { kind: "new", name: "Personal" } },
			]),
			exclusions: ["file-2", "file-3"],
			disclosureManifest: { filenames: 3 },
		});

		expect(replacement.id).not.toBe(snapshot.id);
		expect(() =>
			planStore.approve({
				snapshotId: snapshot.id,
				fingerprint: snapshot.fingerprint,
			}),
		).toThrowError(expect.objectContaining({ code: "SUPERSEDED" }));
	});

	it("rejects approval after expiry using the injected clock", () => {
		const { planStore, snapshot } = prepare(store(50));
		now += 50;
		expect(() =>
			planStore.approve({
				snapshotId: snapshot.id,
				fingerprint: snapshot.fingerprint,
			}),
		).toThrowError(expect.objectContaining({ code: "EXPIRED" }));
	});

	it("rejects approval and apply-read after a backing grant change", () => {
		const first = prepare();
		references.setGrant({
			id: "grant-1",
			path: folder,
			status: "revoked",
			revision: 2,
		});
		expect(() =>
			first.planStore.approve({
				snapshotId: first.snapshot.id,
				fingerprint: first.snapshot.fingerprint,
			}),
		).toThrowError(expect.objectContaining({ code: "GRANT_CHANGED" }));

		references.setGrant({
			id: "grant-1",
			path: folder,
			status: "active",
			revision: 1,
		});
		const second = prepare();
		const binding = second.planStore.approve({
			snapshotId: second.snapshot.id,
			fingerprint: second.snapshot.fingerprint,
		});
		references.setGrant({
			id: "grant-1",
			path: folder,
			status: "revoked",
			revision: 2,
		});
		expect(() => second.planStore.getApproved(binding)).toThrowError(
			expect.objectContaining({ code: "GRANT_CHANGED" }),
		);
	});

	it("rejects approval and apply-read when a referenced opaque ID is invalidated", () => {
		const first = prepare();
		const item = references.getItem("file-1");
		references.setItem({ ...item, status: "invalidated" });
		expect(() =>
			first.planStore.approve({
				snapshotId: first.snapshot.id,
				fingerprint: first.snapshot.fingerprint,
			}),
		).toThrowError(expect.objectContaining({ code: "SOURCE_CHANGED" }));

		installItem("file-1", "one.txt");
		const second = prepare();
		const binding = second.planStore.approve({
			snapshotId: second.snapshot.id,
			fingerprint: second.snapshot.fingerprint,
		});
		fs.writeFileSync(path.join(folder, "two.txt"), "changed source contents");
		expect(() => second.planStore.getApproved(binding)).toThrowError(
			expect.objectContaining({ code: "SOURCE_CHANGED" }),
		);
	});
});
