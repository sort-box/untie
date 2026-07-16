import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { initializeLocalStores } = require("./local-store.cjs");
const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
} = require("./capabilities/authorization.cjs");
const {
	createFolderGrantService,
	createGrantStore,
} = require("./grant-store.cjs");
const { createFolderScanner } = require("./folder-scanner.cjs");
const { createOpaqueFileRegistry } = require("./opaque-file-registry.cjs");
const { validateSortPlan } = require("./sort-plan-validator.cjs");
const { createPreparedPlanStore } = require("./prepared-plan-store.cjs");
const { createJournaledApplyEngine } = require("./journaled-apply.cjs");

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("walking-skeleton sort", () => {
	it("runs grant -> scan -> review/approve -> apply -> undo with safety invariants", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-w16-e2e-"));
		roots.push(root);
		const grantedFolder = path.join(root, "Downloads");
		const appData = path.join(root, "app-data");
		fs.mkdirSync(grantedFolder);
		fs.mkdirSync(appData);
		fs.mkdirSync(path.join(grantedFolder, "Documents"));

		const originals = new Map([
			["invoice.pdf", Buffer.from("%PDF representative invoice\n")],
			["notes.txt", Buffer.from("meeting notes\nline two\n")],
			["photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02])],
		]);
		for (const [name, contents] of originals)
			fs.writeFileSync(path.join(grantedFolder, name), contents);
		const existingFile = Buffer.from("pre-existing destination content");
		fs.writeFileSync(
			path.join(grantedFolder, "Documents", "keep.md"),
			existingFile,
		);
		fs.writeFileSync(path.join(grantedFolder, ".hidden"), "untouched");

		const local = initializeLocalStores(appData);
		const references = new CapabilityReferenceStore();
		const picker = vi.fn().mockResolvedValue({
			canceled: false,
			filePaths: [grantedFolder],
		});
		const grants = createFolderGrantService({
			store: createGrantStore(local.stores.grants.directory),
			referenceStore: references,
			showOpenDialog: picker,
		});
		const { grantId } = await grants.selectFolder();
		expect(grantId).toMatch(/^grant_[0-9a-f]{32}$/);
		expect(picker).toHaveBeenCalledWith({ properties: ["openDirectory"] });

		const authorizer = createCapabilityAuthorizer({ store: references });
		const resolvedGrant = authorizer.resolveGrant(grantId);
		const scanner = createFolderScanner({ appDataDirectory: appData });
		const scan = await scanner.scanFolder(resolvedGrant.canonicalPath);
		expect(scan.files.map(({ name }: { name: string }) => name)).toEqual([
			"invoice.pdf",
			"notes.txt",
			"photo.jpg",
		]);
		expect(scan.skipped).toContainEqual({ name: ".hidden", reason: "HIDDEN" });

		const registry = createOpaqueFileRegistry({ referenceStore: references });
		const files = registry.registerScan({
			grant: resolvedGrant.grant,
			canonicalGrantPath: resolvedGrant.canonicalPath,
			files: scan.files,
		});
		expect(files).toHaveLength(3);
		for (const file of files) {
			expect(file.itemId).toMatch(/^file_[0-9a-f]{32}$/);
			expect(file.itemId).not.toContain(file.name);
		}

		const byName = new Map(
			files.map((file: { itemId: string; name: string }) => [file.name, file]),
		);
		const plan = {
			operations: [
				{
					itemId: byName.get("invoice.pdf").itemId,
					destination: { kind: "existing", name: "Documents" },
				},
				{
					itemId: byName.get("notes.txt").itemId,
					destination: { kind: "new", name: "Text" },
				},
				{
					itemId: byName.get("photo.jpg").itemId,
					destination: { kind: "new", name: "Images" },
				},
			],
		};
		const validationContext = {
			files,
			existingDestinations: [{ name: "Documents", entries: ["keep.md"] }],
		};

		// Model output cannot smuggle paths or non-issued identifiers into a plan.
		expect(
			validateSortPlan(
				{
					operations: [
						{
							itemId: path.join(grantedFolder, "notes.txt"),
							destination: { kind: "new", name: "Text" },
						},
					],
				},
				validationContext,
			),
		).toMatchObject({ ok: false, errors: [{ code: "UNKNOWN_FILE_ID" }] });
		expect(() =>
			authorizer.resolveItem(byName.get("notes.txt").itemId, "another-grant"),
		).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
		expect(
			validateSortPlan(
				{
					operations: [
						{
							itemId: byName.get("notes.txt").itemId,
							destination: { kind: "existing", name: "Documents" },
						},
					],
				},
				{
					files,
					existingDestinations: [{ name: "Documents", entries: ["notes.txt"] }],
				},
			),
		).toMatchObject({
			ok: false,
			errors: [{ code: "DESTINATION_FILE_COLLISION" }],
		});

		const reviewed = validateSortPlan(plan, validationContext);
		expect(reviewed).toMatchObject({ ok: true, operations: plan.operations });
		const preparedPlans = createPreparedPlanStore({
			directory: local.stores.preparedPlans.directory,
			authorizer,
		});
		const snapshot = preparedPlans.prepare({
			grantId,
			plan,
			validationContext,
			disclosureManifest: { filenames: files.length },
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(snapshot.operationCounts).toEqual({ createFolder: 2, move: 3 });
		const approval = preparedPlans.approve({
			snapshotId: snapshot.id,
			fingerprint: snapshot.fingerprint,
		});

		const engine = createJournaledApplyEngine({
			preparedPlanStore: preparedPlans,
			authorizer,
			journalDirectory: path.join(local.stores.journal.directory, "operations"),
		});
		const applied = engine.apply(approval);
		expect(applied.state).toBe("applied");
		for (const [name, destination] of [
			["invoice.pdf", "Documents"],
			["notes.txt", "Text"],
			["photo.jpg", "Images"],
		] as const) {
			expect(fs.existsSync(path.join(grantedFolder, name))).toBe(false);
			expect(
				fs.readFileSync(path.join(grantedFolder, destination, name)),
			).toEqual(originals.get(name));
		}
		expect(
			fs.readFileSync(path.join(grantedFolder, "Documents", "keep.md")),
		).toEqual(existingFile);
		expect(fs.readFileSync(path.join(grantedFolder, ".hidden"), "utf8")).toBe(
			"untouched",
		);
		expect(engine.readBatch(applied.batchId)).toMatchObject({
			state: "applied",
			grantId,
			snapshotId: snapshot.id,
		});

		const undone = engine.undo(applied.batchId);
		expect(undone).toMatchObject({ state: "rolled_back", outcome: "complete" });
		for (const [name, contents] of originals)
			expect(fs.readFileSync(path.join(grantedFolder, name))).toEqual(contents);
		expect(fs.existsSync(path.join(grantedFolder, "Text"))).toBe(false);
		expect(fs.existsSync(path.join(grantedFolder, "Images"))).toBe(false);
		expect(
			fs.statSync(path.join(grantedFolder, "Documents")).isDirectory(),
		).toBe(true);
		expect(
			fs.readFileSync(path.join(grantedFolder, "Documents", "keep.md")),
		).toEqual(existingFile);
		expect(engine.readBatch(applied.batchId).state).toBe("rolled_back");
	});
});
