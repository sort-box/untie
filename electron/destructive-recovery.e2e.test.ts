import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { initializeLocalStores }: typeof import("./local-store.cjs") =
	require("./local-store.cjs");
const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
}: typeof import("./capabilities/authorization.cjs") = require("./capabilities/authorization.cjs");
const {
	createFolderGrantService,
	createGrantStore,
}: typeof import("./grant-store.cjs") = require("./grant-store.cjs");
const { createFolderScanner }: typeof import("./folder-scanner.cjs") =
	require("./folder-scanner.cjs");
const {
	createOpaqueFileRegistry,
}: typeof import("./opaque-file-registry.cjs") = require("./opaque-file-registry.cjs");
const { validateSortPlan }: typeof import("./sort-plan-validator.cjs") =
	require("./sort-plan-validator.cjs");
const {
	createPreparedPlanStore,
}: typeof import("./prepared-plan-store.cjs") = require("./prepared-plan-store.cjs");
const {
	InjectedApplyCrash,
	createJournaledApplyEngine,
}: typeof import("./journaled-apply.cjs") = require("./journaled-apply.cjs");
const {
	createCrashRecoveryEngine,
}: typeof import("./crash-recovery.cjs") = require("./crash-recovery.cjs");

const roots: string[] = [];

type Fault = (point: string, context: Record<string, unknown>) => void;

async function createHarness(fault?: Fault) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-s11-e2e-"));
	roots.push(root);
	const grantedFolder = path.join(root, "Downloads");
	const appData = path.join(root, "app-data");
	fs.mkdirSync(grantedFolder);
	fs.mkdirSync(appData);
	fs.mkdirSync(path.join(grantedFolder, "Sorted"));

	const originals = new Map([
		["alpha.txt", Buffer.from("alpha original\n")],
		["beta.txt", Buffer.from("beta original\n")],
	]);
	for (const [name, contents] of originals)
		fs.writeFileSync(path.join(grantedFolder, name), contents);

	const local = initializeLocalStores(appData);
	const references = new CapabilityReferenceStore();
	const grants = createFolderGrantService({
		store: createGrantStore(local.stores.grants.directory),
		referenceStore: references,
		showOpenDialog: vi.fn().mockResolvedValue({
			canceled: false,
			filePaths: [grantedFolder],
		}),
	});
	const { grantId } = await grants.selectFolder();
	const authorizer = createCapabilityAuthorizer({ store: references });
	const resolvedGrant = authorizer.resolveGrant(grantId);
	const scan = await createFolderScanner({
		appDataDirectory: appData,
	}).scanFolder(resolvedGrant.canonicalPath);
	const files = createOpaqueFileRegistry({
		referenceStore: references,
	}).registerScan({
		grant: resolvedGrant.grant,
		canonicalGrantPath: resolvedGrant.canonicalPath,
		files: scan.files,
	});
	for (const file of files) {
		expect(file.itemId).toMatch(/^file_[0-9a-f]{32}$/);
		expect(file.itemId).not.toContain(file.name);
	}
	const operations = files.map((file: { itemId: string }) => ({
		itemId: file.itemId,
		destination: { kind: "existing" as const, name: "Sorted" },
	}));
	const plan = { operations };
	const validationContext = {
		files,
		existingDestinations: [{ name: "Sorted", entries: [] }],
	};
	expect(validateSortPlan(plan, validationContext)).toMatchObject({ ok: true });
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
	const journalDirectory = path.join(
		local.stores.journal.directory,
		"operations",
	);
	const engine = createJournaledApplyEngine({
		preparedPlanStore: preparedPlans,
		authorizer,
		journalDirectory,
		...(fault ? { fault } : {}),
	});
	return {
		grantedFolder,
		originals,
		files,
		grantId,
		authorizer,
		preparedPlans,
		snapshot,
		journalDirectory,
		engine,
	};
}

function approve(context: Awaited<ReturnType<typeof createHarness>>) {
	return context.preparedPlans.approve({
		snapshotId: context.snapshot.id,
		fingerprint: context.snapshot.fingerprint,
	});
}

function batchIdIn(journalDirectory: string) {
	const entry = fs
		.readdirSync(journalDirectory)
		.find((name) => name.endsWith(".json"));
	expect(entry).toBeDefined();
	return (entry as string).slice(0, -5);
}

function expectOriginalsAtOrigin(
	context: Awaited<ReturnType<typeof createHarness>>,
) {
	for (const [name, contents] of context.originals) {
		expect(fs.readFileSync(path.join(context.grantedFolder, name))).toEqual(
			contents,
		);
	}
}

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("destructive and recovery filesystem pipeline", () => {
	it("blocks a prepared snapshot after its source becomes stale", async () => {
		const context = await createHarness();
		const changed = path.join(context.grantedFolder, "alpha.txt");
		fs.appendFileSync(changed, "external change\n");
		const changedContents = fs.readFileSync(changed);

		expect(() => approve(context)).toThrowError(
			expect.objectContaining({ code: "SOURCE_CHANGED" }),
		);
		expect(fs.readFileSync(changed)).toEqual(changedContents);
		expect(
			fs.readFileSync(path.join(context.grantedFolder, "beta.txt")),
		).toEqual(context.originals.get("beta.txt"));
		expect(fs.readdirSync(path.join(context.grantedFolder, "Sorted"))).toEqual(
			[],
		);
		expect(fs.readdirSync(context.journalDirectory)).toEqual([]);
	});

	it("rejects a late destination collision without overwriting or moving anything", async () => {
		const context = await createHarness();
		const binding = approve(context);
		const collision = path.join(context.grantedFolder, "Sorted", "beta.txt");
		const occupant = Buffer.from("pre-existing user destination\n");
		fs.writeFileSync(collision, occupant);

		expect(() => context.engine.apply(binding)).toThrowError(
			expect.objectContaining({ code: "TARGET_EXISTS" }),
		);
		expect(fs.readFileSync(collision)).toEqual(occupant);
		expectOriginalsAtOrigin(context);
		expect(fs.readdirSync(path.join(context.grantedFolder, "Sorted"))).toEqual([
			"beta.txt",
		]);
		expect(fs.readdirSync(context.journalDirectory)).toEqual([]);
		expect(() => context.preparedPlans.getApproved(binding)).toThrowError(
			expect.objectContaining({ code: "INVALIDATED" }),
		);
	});

	it("durably rolls back an injected mid-apply move failure", async () => {
		let moveIntents = 0;
		const context = await createHarness((point, event) => {
			if (point === "after_intent" && event.type === "move") {
				moveIntents += 1;
				if (moveIntents === 2) throw new Error("injected move failure");
			}
		});
		const binding = approve(context);

		expect(() => context.engine.apply(binding)).toThrow(
			"injected move failure",
		);
		const batchId = batchIdIn(context.journalDirectory);
		expect(context.engine.readBatch(batchId).state).toBe("applying");
		const recovered = createCrashRecoveryEngine({
			journalDirectory: context.journalDirectory,
			authorizer: context.authorizer,
		}).recoverAll();

		expect(recovered.batches[0]).toMatchObject({
			id: batchId,
			state: "rolled_back",
		});
		expectOriginalsAtOrigin(context);
		expect(fs.readdirSync(path.join(context.grantedFolder, "Sorted"))).toEqual(
			[],
		);
	});

	it("recovers a non-terminal hard-link move after a simulated relaunch", async () => {
		let crashed = false;
		const context = await createHarness((point, event) => {
			if (!crashed && point === "after_move_link_before_unlink") {
				crashed = true;
				expect(event.type).toBe("move");
				throw new InjectedApplyCrash(point);
			}
		});
		const binding = approve(context);

		expect(() => context.engine.apply(binding)).toThrow(InjectedApplyCrash);
		const batchId = batchIdIn(context.journalDirectory);
		expect(context.engine.readBatch(batchId).state).toBe("applying");
		const relaunchedRecovery = createCrashRecoveryEngine({
			journalDirectory: context.journalDirectory,
			authorizer: context.authorizer,
		});
		const summary = relaunchedRecovery.recoverAll();

		expect(summary).toMatchObject({
			recoveredCount: 1,
			needsAttention: [],
		});
		expect(summary.batches[0]).toMatchObject({
			id: batchId,
			state: "rolled_back",
			trigger: "recovery",
		});
		expect(relaunchedRecovery.readBatch(batchId).state).toBe("rolled_back");
		expectOriginalsAtOrigin(context);
		expect(fs.readdirSync(path.join(context.grantedFolder, "Sorted"))).toEqual(
			[],
		);
	});

	it("partially undoes safe files while preserving an occupied origin conflict", async () => {
		const context = await createHarness();
		const applied = context.engine.apply(approve(context));
		expect(applied.state).toBe("applied");
		const occupiedOrigin = path.join(context.grantedFolder, "alpha.txt");
		const occupant = Buffer.from("external file at original location\n");
		fs.writeFileSync(occupiedOrigin, occupant);

		const undone = context.engine.undo(applied.batchId);

		expect(undone).toMatchObject({
			state: "needs_attention",
			outcome: "partial",
		});
		const alpha = context.files.find(
			(file: { name: string }) => file.name === "alpha.txt",
		);
		const beta = context.files.find(
			(file: { name: string }) => file.name === "beta.txt",
		);
		expect(undone.files).toContainEqual({
			itemId: alpha.itemId,
			outcome: "conflict",
			reason: "origin_occupied",
		});
		expect(undone.files).toContainEqual({
			itemId: beta.itemId,
			outcome: "restored",
			reason: undefined,
		});
		expect(fs.readFileSync(occupiedOrigin)).toEqual(occupant);
		expect(
			fs.readFileSync(path.join(context.grantedFolder, "Sorted", "alpha.txt")),
		).toEqual(context.originals.get("alpha.txt"));
		expect(
			fs.readFileSync(path.join(context.grantedFolder, "beta.txt")),
		).toEqual(context.originals.get("beta.txt"));
		expect(
			fs.existsSync(path.join(context.grantedFolder, "Sorted", "beta.txt")),
		).toBe(false);
	});
});
