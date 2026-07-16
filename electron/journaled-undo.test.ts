import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
	CapabilityReferenceStore,
	createCapabilityAuthorizer,
}: typeof import("./capabilities/authorization.cjs") = require("./capabilities/authorization.cjs");
const {
	InjectedApplyCrash,
	createJournaledApplyEngine,
}: typeof import("./journaled-apply.cjs") = require("./journaled-apply.cjs");
const {
	createPreparedPlanStore,
}: typeof import("./prepared-plan-store.cjs") = require("./prepared-plan-store.cjs");

const roots: string[] = [];

function setup(
	options: {
		existing?: boolean;
		fault?: (point: string, context: Record<string, unknown>) => void;
		fsApi?: typeof fs;
	} = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-undo-"));
	roots.push(root);
	const grant = path.join(root, "grant");
	const journal = path.join(root, "journal");
	fs.mkdirSync(grant);
	fs.mkdirSync(path.join(root, "prepared"));
	if (options.existing) fs.mkdirSync(path.join(grant, "Sorted"));
	const references = new CapabilityReferenceStore();
	references.setGrant({
		id: "grant-1",
		path: grant,
		status: "active",
		revision: 1,
	});
	const original = new Map<string, Buffer>();
	for (const [index, name] of ["one.txt", "two.txt"].entries()) {
		const contents = Buffer.from(`original-${index}-${"x".repeat(index + 1)}`);
		const source = path.join(grant, name);
		fs.writeFileSync(source, contents);
		original.set(name, contents);
		const canonicalPath = fs.realpathSync.native(source);
		const stat = fs.statSync(source);
		references.setItem({
			id: `file-${index + 1}`,
			path: canonicalPath,
			grantId: "grant-1",
			grantRevision: 1,
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
	const authorizer = createCapabilityAuthorizer({
		store: references,
		fsApi: options.fsApi,
	});
	const planStore = createPreparedPlanStore({
		directory: path.join(root, "prepared"),
		authorizer,
	});
	const destination = {
		kind: options.existing ? "existing" : "new",
		name: "Sorted",
	};
	const snapshot = planStore.prepare({
		grantId: "grant-1",
		plan: {
			operations: [
				{ itemId: "file-1", destination },
				{ itemId: "file-2", destination },
			],
		},
		validationContext: {
			files: [
				{ itemId: "file-1", name: "one.txt" },
				{ itemId: "file-2", name: "two.txt" },
			],
			existingDestinations: options.existing
				? [{ name: "Sorted", entries: [] }]
				: [],
		},
	});
	const binding = planStore.approve({
		snapshotId: snapshot.id,
		fingerprint: snapshot.fingerprint,
	});
	const engine = createJournaledApplyEngine({
		preparedPlanStore: planStore,
		authorizer,
		journalDirectory: journal,
		fsApi: options.fsApi,
		fault: options.fault,
	});
	const applied = engine.apply(binding);
	return {
		root,
		grant,
		journal,
		original,
		references,
		engine,
		batchId: applied.batchId,
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("minimal immediate undo", () => {
	it("restores every eligible file byte-identically and removes its empty created folder", () => {
		const context = setup();
		const result = context.engine.undo(context.batchId);

		expect(result).toMatchObject({
			state: "rolled_back",
			outcome: "complete",
			files: [
				{ itemId: "file-2", outcome: "restored" },
				{ itemId: "file-1", outcome: "restored" },
			],
			folders: [{ outcome: "removed" }],
		});
		for (const [name, contents] of context.original) {
			expect(fs.readFileSync(path.join(context.grant, name))).toEqual(contents);
		}
		expect(fs.existsSync(path.join(context.grant, "Sorted"))).toBe(false);
		expect(context.engine.readBatch(context.batchId)).toMatchObject({
			state: "rolled_back",
			trigger: "user_undo",
		});
	});

	it("surfaces an occupied-origin conflict without touching either safe file", () => {
		const context = setup();
		fs.writeFileSync(path.join(context.grant, "one.txt"), "occupant");

		const result = context.engine.undo(context.batchId);

		expect(result.state).toBe("needs_attention");
		expect(result.files).toContainEqual({
			itemId: "file-1",
			outcome: "conflict",
			reason: "origin_occupied",
		});
		expect(fs.readFileSync(path.join(context.grant, "one.txt"), "utf8")).toBe(
			"occupant",
		);
		expect(
			fs.readFileSync(path.join(context.grant, "Sorted", "one.txt")),
		).toEqual(context.original.get("one.txt"));
		expect(fs.existsSync(path.join(context.grant, "Sorted"))).toBe(true);
	});

	it("never removes a pre-existing folder or a created folder that became non-empty", () => {
		const preExisting = setup({ existing: true });
		const first = preExisting.engine.undo(preExisting.batchId);
		expect(first.folders).toEqual([
			{ folderId: "folder_0", outcome: "pre_existing" },
		]);
		expect(
			fs.statSync(path.join(preExisting.grant, "Sorted")).isDirectory(),
		).toBe(true);

		const nonEmpty = setup();
		fs.writeFileSync(
			path.join(nonEmpty.grant, "Sorted", "user-added.txt"),
			"keep",
		);
		const second = nonEmpty.engine.undo(nonEmpty.batchId);
		expect(second.state).toBe("rolled_back");
		expect(second.folders).toEqual([
			{ folderId: "folder_0", outcome: "non_empty" },
		]);
		expect(
			fs.readFileSync(
				path.join(nonEmpty.grant, "Sorted", "user-added.txt"),
				"utf8",
			),
		).toBe("keep");
	});

	it("reports missing, replaced, and modified destinations deterministically", () => {
		const missing = setup({ existing: true });
		fs.unlinkSync(path.join(missing.grant, "Sorted", "one.txt"));
		const missingResult = missing.engine.undo(missing.batchId);
		expect(missingResult.files).toContainEqual({
			itemId: "file-1",
			outcome: "already_moved_away",
			reason: "source_missing",
		});

		const replaced = setup({ existing: true });
		fs.unlinkSync(path.join(replaced.grant, "Sorted", "one.txt"));
		fs.writeFileSync(
			path.join(replaced.grant, "Sorted", "one.txt"),
			"replacement",
		);
		const replacedResult = replaced.engine.undo(replaced.batchId);
		expect(replacedResult.files).toContainEqual({
			itemId: "file-1",
			outcome: "conflict",
			reason: "destination_replaced",
		});
		expect(
			fs.readFileSync(path.join(replaced.grant, "Sorted", "one.txt"), "utf8"),
		).toBe("replacement");

		const modified = setup({ existing: true });
		fs.appendFileSync(
			path.join(modified.grant, "Sorted", "one.txt"),
			"-changed",
		);
		const modifiedResult = modified.engine.undo(modified.batchId);
		expect(modifiedResult.files).toContainEqual({
			itemId: "file-1",
			outcome: "restored_modified",
			reason: "modified_since_move",
		});
		expect(
			fs.readFileSync(path.join(modified.grant, "one.txt"), "utf8"),
		).toContain("-changed");
	});

	it("durably journals a fault between reverse link and unlink without losing data", () => {
		let undoing = false;
		const context = setup({
			fault(point) {
				if (undoing && point === "after_revert_link_before_unlink")
					throw new InjectedApplyCrash(point);
			},
		});
		undoing = true;
		expect(() => context.engine.undo(context.batchId)).toThrow(
			InjectedApplyCrash,
		);
		const batch = context.engine.readBatch(context.batchId);
		expect(batch.state).toBe("rolling_back");
		expect(
			batch.items.find((item: { id: string }) => item.id === "move_1")?.state,
		).toBe("reverting");
		expect(fs.readFileSync(path.join(context.grant, "two.txt"))).toEqual(
			context.original.get("two.txt"),
		);
		expect(
			fs.readFileSync(path.join(context.grant, "Sorted", "two.txt")),
		).toEqual(context.original.get("two.txt"));
	});

	it("records an unavailable grant with zero filesystem mutation", () => {
		const context = setup();
		context.references.setGrant({
			id: "grant-1",
			path: context.grant,
			status: "revoked",
			revision: 2,
		});
		const result = context.engine.undo(context.batchId);

		expect(result).toMatchObject({
			state: "needs_attention",
			outcome: "unavailable",
			files: [],
			folders: [],
		});
		expect(context.engine.readBatch(context.batchId)).toMatchObject({
			state: "needs_attention",
			trigger: "user_undo",
			reason: "unavailable",
		});
		expect(fs.existsSync(path.join(context.grant, "one.txt"))).toBe(false);
		expect(
			fs.readFileSync(path.join(context.grant, "Sorted", "one.txt")),
		).toEqual(context.original.get("one.txt"));
	});

	it("continues after a per-file filesystem fault and leaves the affected file safe", () => {
		let undoLinks = 0;
		const fsApi = Object.create(fs) as typeof fs;
		fsApi.linkSync = ((source: fs.PathLike, target: fs.PathLike) => {
			if (String(source).includes(`${path.sep}Sorted${path.sep}`)) {
				undoLinks += 1;
				if (undoLinks === 1) {
					const error = new Error("injected") as NodeJS.ErrnoException;
					error.code = "EIO";
					throw error;
				}
			}
			return fs.linkSync(source, target);
		}) as typeof fs.linkSync;
		const context = setup({ fsApi });
		const result = context.engine.undo(context.batchId);

		expect(result.state).toBe("needs_attention");
		expect(result.files).toContainEqual({
			itemId: "file-2",
			outcome: "conflict",
			reason: "filesystem_error",
		});
		expect(result.files).toContainEqual({
			itemId: "file-1",
			outcome: "restored",
			reason: undefined,
		});
		expect(fs.existsSync(path.join(context.grant, "Sorted", "two.txt"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(context.grant, "one.txt"))).toBe(true);
	});
});
