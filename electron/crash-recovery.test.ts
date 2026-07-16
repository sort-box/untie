import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
	createCrashRecoveryEngine,
}: typeof import("./crash-recovery.cjs") = require("./crash-recovery.cjs");
const {
	createJournalStore,
}: typeof import("./journaled-apply.cjs") = require("./journaled-apply.cjs");

const roots: string[] = [];
const batchId = "batch_00000000000000000000000000000001";

function fixture(state: string, itemState?: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-recovery-"));
	roots.push(root);
	const grant = path.join(root, "grant");
	const journalDirectory = path.join(root, "journal");
	const folder = path.join(grant, "Sorted");
	const source = path.join(grant, "one.txt");
	const target = path.join(folder, "one.txt");
	fs.mkdirSync(grant);
	fs.writeFileSync(source, "original-content");
	const original = fs.statSync(source);
	const sourceFingerprint = {
		canonicalPath: source,
		size: original.size,
		mtimeMs: original.mtimeMs,
		dev: original.dev,
		ino: original.ino,
	};
	const batch = {
		schemaVersion: 1,
		id: batchId,
		grantId: "grant-1",
		state,
		trigger: state === "rolling_back" ? "auto_failure" : null,
		createdAt: 1,
		updatedAt: 1,
		items: [
			{
				type: "folder",
				id: "folder_0",
				path: folder,
				existed: false,
				state: "pending",
			},
			{
				type: "move",
				id: "move_0",
				source,
				target,
				sourceFingerprint,
				state: itemState ?? "pending",
			},
		],
	};
	const journal = createJournalStore({ directory: journalDirectory });
	const engine = createCrashRecoveryEngine({
		journalDirectory,
		authorizer: { resolveGrant: () => ({ canonicalPath: grant }) },
		now: () => 2,
	});
	return { batch, engine, folder, journal, source, target };
}

function moveToTarget(context: ReturnType<typeof fixture>) {
	fs.mkdirSync(context.folder, { recursive: true });
	fs.linkSync(context.source, context.target);
	fs.unlinkSync(context.source);
	const stat = fs.statSync(context.target);
	const folderItem = context.batch.items[0];
	Object.assign(folderItem, { state: "created", createdByUs: true });
	const moveItem = context.batch.items[1];
	Object.assign(moveItem, {
		state: "moved",
		postMoveFingerprint: {
			canonicalPath: context.target,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			dev: stat.dev,
			ino: stat.ino,
		},
	});
}

function persistAndRecover(context: ReturnType<typeof fixture>) {
	context.journal.persist(context.batch);
	const first = context.engine.recoverAll().batches[0];
	const firstDisk = JSON.stringify(first);
	const second = context.engine.recoverAll().batches[0];
	expect(JSON.stringify(second)).toBe(firstDisk);
	return second;
}

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("R4 crash recovery decision table", () => {
	it("has no action when there is no journal record", () => {
		const context = fixture("prepared");
		expect(context.engine.recoverAll()).toMatchObject({
			batches: [],
			recoveredCount: 0,
			needsAttention: [],
		});
	});

	it("abandons prepared with zero filesystem mutation", () => {
		const context = fixture("prepared");
		const recovered = persistAndRecover(context);
		expect(recovered).toMatchObject({
			state: "rolled_back",
			trigger: "recovery",
			note: "never_entered_applying",
		});
		expect(fs.readFileSync(context.source, "utf8")).toBe("original-content");
		expect(fs.existsSync(context.target)).toBe(false);
	});

	it("treats a prepared batch with item evidence as applying", () => {
		const context = fixture("prepared", "moved");
		moveToTarget(context);
		context.batch.state = "prepared";
		context.batch.items.push({
			type: "move",
			id: "move_1",
			state: "pending",
			source: path.join(path.dirname(context.source), "later.txt"),
			target: path.join(context.folder, "later.txt"),
			sourceFingerprint: {},
		});
		const recovered = persistAndRecover(context);
		expect(recovered).toMatchObject({
			state: "rolled_back",
			trigger: "recovery",
		});
		expect(recovered.note).not.toBe("never_entered_applying");
		expect(fs.readFileSync(context.source, "utf8")).toBe("original-content");
		expect(fs.existsSync(context.target)).toBe(false);
	});

	it("rolls an incomplete applying batch back without loss", () => {
		const context = fixture("applying", "moved");
		moveToTarget(context);
		context.batch.items.push({
			type: "move",
			id: "move_1",
			state: "pending",
			source: path.join(path.dirname(context.source), "later.txt"),
			target: path.join(context.folder, "later.txt"),
			sourceFingerprint: {},
		});
		const recovered = persistAndRecover(context);
		expect(recovered.state).toBe("rolled_back");
		expect(fs.readFileSync(context.source, "utf8")).toBe("original-content");
		expect(fs.existsSync(context.target)).toBe(false);
	});

	it("rolls applying forward when every item succeeded", () => {
		const context = fixture("applying", "moved");
		moveToTarget(context);
		const recovered = persistAndRecover(context);
		expect(recovered.state).toBe("applied");
		expect(fs.readFileSync(context.target, "utf8")).toBe("original-content");
		expect(fs.existsSync(context.source)).toBe(false);
	});

	it("resumes rolling_back and safely reverse-replays", () => {
		const context = fixture("rolling_back", "reverting");
		moveToTarget(context);
		context.batch.state = "rolling_back";
		context.batch.items[1].state = "reverting";
		const recovered = persistAndRecover(context);
		expect(recovered.state).toBe("rolled_back");
		expect(fs.readFileSync(context.source, "utf8")).toBe("original-content");
	});

	it.each([
		"applied",
		"rolled_back",
		"needs_attention",
	])("leaves terminal %s unchanged", (state) => {
		const context = fixture(state);
		if (state === "applied") moveToTarget(context);
		const before = JSON.stringify(context.batch);
		const recovered = persistAndRecover(context);
		expect(JSON.stringify(recovered)).toBe(before);
		const contentPath = state === "applied" ? context.target : context.source;
		expect(fs.readFileSync(contentPath, "utf8")).toBe("original-content");
	});

	it("never overwrites an occupied origin and surfaces needs_attention", () => {
		const context = fixture("rolling_back", "moved");
		moveToTarget(context);
		fs.writeFileSync(context.source, "new-user-file");
		const recovered = persistAndRecover(context);
		expect(recovered.state).toBe("needs_attention");
		expect(fs.readFileSync(context.source, "utf8")).toBe("new-user-file");
		expect(fs.readFileSync(context.target, "utf8")).toBe("original-content");
	});

	it("probes an attempting move that landed before the result journal", () => {
		const context = fixture("applying", "attempting");
		moveToTarget(context);
		context.batch.items[1].state = "attempting";
		const recovered = persistAndRecover(context);
		expect(recovered.state).toBe("rolled_back");
		expect(fs.readFileSync(context.source, "utf8")).toBe("original-content");
	});

	it("finishes the apply-side hard-link move before reverse replay", () => {
		const context = fixture("applying", "attempting");
		fs.mkdirSync(context.folder);
		fs.linkSync(context.source, context.target);
		Object.assign(context.batch.items[0], {
			state: "created",
			createdByUs: true,
		});
		context.journal.persist(context.batch);
		let injected = true;
		const probingEngine = createCrashRecoveryEngine({
			journalDirectory: path.join(
				path.dirname(context.folder),
				"..",
				"journal",
			),
			authorizer: { resolveGrant: () => ({}) },
			fault(point) {
				if (injected && point === "after_recovery_probe") {
					injected = false;
					throw new Error("stop after apply-side probe");
				}
			},
		});
		expect(() => probingEngine.recoverAll()).toThrow(
			"stop after apply-side probe",
		);
		expect(fs.existsSync(context.source)).toBe(false);
		expect(fs.readFileSync(context.target, "utf8")).toBe("original-content");

		const recovered = context.engine.recoverAll().batches[0];
		expect(recovered.state).toBe("rolled_back");
		expect(fs.readFileSync(context.source, "utf8")).toBe("original-content");
		expect(fs.existsSync(context.target)).toBe(false);
	});

	it("surfaces in-doubt attempting evidence without touching either file", () => {
		const context = fixture("applying", "attempting");
		fs.mkdirSync(context.folder);
		fs.writeFileSync(context.target, "external-target");
		fs.writeFileSync(context.source, "external-source");
		const recovered = persistAndRecover(context);
		expect(recovered).toMatchObject({ state: "needs_attention" });
		expect(recovered.items[1]).toMatchObject({
			state: "failed",
			reason: "IN_DOUBT_CONFLICT",
		});
		expect(fs.readFileSync(context.source, "utf8")).toBe("external-source");
		expect(fs.readFileSync(context.target, "utf8")).toBe("external-target");
	});

	it("converges after a crash between the reverse link and unlink", () => {
		const context = fixture("rolling_back", "moved");
		moveToTarget(context);
		context.batch.state = "rolling_back";
		context.journal.persist(context.batch);
		let crash = true;
		const crashingEngine = createCrashRecoveryEngine({
			journalDirectory: path.join(
				path.dirname(context.folder),
				"..",
				"journal",
			),
			authorizer: { resolveGrant: () => ({}) },
			fault(point) {
				if (crash && point === "after_revert_link_before_unlink") {
					crash = false;
					throw new Error("injected recovery crash");
				}
			},
		});
		expect(() => crashingEngine.recoverAll()).toThrow(
			"injected recovery crash",
		);
		expect(fs.statSync(context.source).ino).toBe(
			fs.statSync(context.target).ino,
		);
		const recovered = context.engine.recoverAll().batches[0];
		expect(recovered.state).toBe("rolled_back");
		expect(fs.readFileSync(context.source, "utf8")).toBe("original-content");
		expect(fs.existsSync(context.target)).toBe(false);
	});

	it("surfaces an unavailable grant without touching either location", () => {
		const context = fixture("rolling_back", "moved");
		moveToTarget(context);
		context.batch.state = "rolling_back";
		context.journal.persist(context.batch);
		const unavailable = createCrashRecoveryEngine({
			journalDirectory: path.join(
				path.dirname(context.folder),
				"..",
				"journal",
			),
			authorizer: {
				resolveGrant: () => {
					throw new Error("revoked");
				},
			},
		});
		const recovered = unavailable.recoverAll().batches[0];
		expect(recovered).toMatchObject({
			state: "needs_attention",
			reason: "grant_unavailable",
		});
		expect(fs.existsSync(context.source)).toBe(false);
		expect(fs.readFileSync(context.target, "utf8")).toBe("original-content");
	});
});
