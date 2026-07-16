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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "untie-apply-"));
	roots.push(root);
	const grant = path.join(root, "grant");
	const prepared = path.join(root, "prepared");
	const journal = path.join(root, "journal", "operations");
	fs.mkdirSync(grant);
	fs.mkdirSync(prepared);
	if (options.existing) fs.mkdirSync(path.join(grant, "Sorted"));
	const references = new CapabilityReferenceStore();
	references.setGrant({
		id: "grant-1",
		path: grant,
		status: "active",
		revision: 1,
	});
	for (const [index, name] of ["one.txt", "two.txt"].entries()) {
		const source = path.join(grant, name);
		fs.writeFileSync(source, `content-${index}`);
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
		directory: prepared,
		authorizer,
	});
	const destination = {
		kind: options.existing ? "existing" : "new",
		name: "Sorted",
	};
	const operations = [
		{ itemId: "file-1", destination },
		{ itemId: "file-2", destination },
	];
	const snapshot = planStore.prepare({
		grantId: "grant-1",
		plan: { operations },
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
	return { root, grant, journal, planStore, snapshot, binding, engine };
}

function onlyBatch(journal: string) {
	const file = fs.readdirSync(journal).find((name) => name.endsWith(".json"));
	expect(file).toBeDefined();
	return JSON.parse(
		fs.readFileSync(path.join(journal, file as string), "utf8"),
	);
}

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("minimal journaled apply state machine", () => {
	it("durably transitions prepared -> applying -> applied with folders before moves", () => {
		const transitions: Array<{ point: string; state: string; item?: string }> =
			[];
		const context = setup({
			fault(point, event) {
				if (
					point === "after_prepared" ||
					point === "after_intent" ||
					point === "after_result"
				) {
					const batch = onlyBatch(context.journal);
					transitions.push({
						point,
						state: batch.state,
						item: event.itemId as string | undefined,
					});
				}
			},
		});
		const result = context.engine.apply(context.binding);
		const batch = context.engine.readBatch(result.batchId);

		expect(result.state).toBe("applied");
		expect(batch.state).toBe("applied");
		expect(batch.items.map((item: { type: string }) => item.type)).toEqual([
			"folder",
			"move",
			"move",
		]);
		expect(batch.items.map((item: { state: string }) => item.state)).toEqual([
			"created",
			"moved",
			"moved",
		]);
		expect(fs.existsSync(path.join(context.grant, "one.txt"))).toBe(false);
		expect(
			fs.readFileSync(path.join(context.grant, "Sorted", "one.txt"), "utf8"),
		).toBe("content-0");
		expect(transitions[0]).toMatchObject({
			point: "after_prepared",
			state: "prepared",
		});
		expect(transitions.some((entry) => entry.state === "applying")).toBe(true);
	});

	it.each([
		"before_preflight",
		"after_preflight",
	])("a crash at %s leaves zero filesystem mutations and no apply record", (crashAt) => {
		const context = setup({
			fault(point) {
				if (point === crashAt) throw new InjectedApplyCrash(point);
			},
		});
		expect(() => context.engine.apply(context.binding)).toThrow(
			InjectedApplyCrash,
		);
		expect(fs.existsSync(path.join(context.grant, "one.txt"))).toBe(true);
		expect(fs.existsSync(path.join(context.grant, "Sorted"))).toBe(false);
		expect(
			fs.existsSync(context.journal) ? fs.readdirSync(context.journal) : [],
		).toEqual([]);
	});

	it.each([
		["after_prepared", "prepared", "pending", true, false],
		["after_intent", "applying", "attempting", true, false],
		["after_move_link_before_unlink", "applying", "attempting", true, true],
		["after_mutation_before_result", "applying", "attempting", false, true],
		["after_result", "applying", "moved", false, true],
	])("crash point %s leaves the exact recoverable write-ahead evidence", (crashAt, state, itemState, sourceExists, targetExists) => {
		const context = setup({
			existing: true,
			fault(point, event) {
				if (
					point === crashAt &&
					(point === "after_prepared" || event.type === "move")
				)
					throw new InjectedApplyCrash(point);
			},
		});
		expect(() => context.engine.apply(context.binding)).toThrow(
			InjectedApplyCrash,
		);
		const batch = onlyBatch(context.journal);
		const move = batch.items.find(
			(item: { type: string }) => item.type === "move",
		);
		expect(batch.state).toBe(state);
		expect(move.state).toBe(itemState);
		expect(fs.existsSync(path.join(context.grant, "one.txt"))).toBe(
			sourceExists,
		);
		expect(fs.existsSync(path.join(context.grant, "Sorted", "one.txt"))).toBe(
			targetExists,
		);
	});

	it("preflight rejects one late overwrite collision with zero moves or folder mutations", () => {
		const context = setup({ existing: true });
		fs.writeFileSync(
			path.join(context.grant, "Sorted", "two.txt"),
			"do-not-overwrite",
		);
		expect(() => context.engine.apply(context.binding)).toThrowError(
			expect.objectContaining({ code: "TARGET_EXISTS" }),
		);
		expect(
			fs.readFileSync(path.join(context.grant, "Sorted", "two.txt"), "utf8"),
		).toBe("do-not-overwrite");
		expect(fs.existsSync(path.join(context.grant, "one.txt"))).toBe(true);
		expect(fs.existsSync(path.join(context.grant, "two.txt"))).toBe(true);
		expect(
			fs.existsSync(context.journal) ? fs.readdirSync(context.journal) : [],
		).toEqual([]);
		expect(() => context.planStore.getApproved(context.binding)).toThrowError(
			expect.objectContaining({ code: "INVALIDATED" }),
		);
	});

	it("a crash after the final item result leaves a roll-forward-only applying record", () => {
		const context = setup({
			existing: true,
			fault(point) {
				if (point === "after_last_result") throw new InjectedApplyCrash(point);
			},
		});
		expect(() => context.engine.apply(context.binding)).toThrow(
			InjectedApplyCrash,
		);
		const batch = onlyBatch(context.journal);
		expect(batch.state).toBe("applying");
		expect(
			batch.items.every((item: { state: string }) =>
				["moved", "exists", "created"].includes(item.state),
			),
		).toBe(true);
		expect(fs.existsSync(path.join(context.grant, "one.txt"))).toBe(false);
		expect(fs.existsSync(path.join(context.grant, "two.txt"))).toBe(false);
	});

	it("an injected mid-batch move failure never clobbers and lands in durable rolling_back", () => {
		let links = 0;
		const fsApi = Object.create(fs) as typeof fs;
		fsApi.linkSync = ((source: fs.PathLike, target: fs.PathLike) => {
			links += 1;
			if (links === 2) {
				const error = new Error(
					"injected move failure",
				) as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return fs.linkSync(source, target);
		}) as typeof fs.linkSync;
		const context = setup({ existing: true, fsApi });
		expect(() => context.engine.apply(context.binding)).toThrowError(
			expect.objectContaining({ code: "APPLY_FAILED" }),
		);
		const batch = onlyBatch(context.journal);
		expect(batch).toMatchObject({
			state: "rolling_back",
			trigger: "auto_failure",
		});
		expect(
			batch.items
				.filter((item: { type: string }) => item.type === "move")
				.map((item: { state: string }) => item.state),
		).toEqual(["moved", "failed"]);
		expect(
			fs.readFileSync(path.join(context.grant, "Sorted", "one.txt"), "utf8"),
		).toBe("content-0");
		expect(fs.readFileSync(path.join(context.grant, "two.txt"), "utf8")).toBe(
			"content-1",
		);
	});

	it("the exclusive move fails rather than overwriting a target that appears after preflight", () => {
		const context = setup({
			existing: true,
			fault(point, event) {
				if (point === "after_intent" && event.type === "move")
					fs.writeFileSync(
						path.join(context.grant, "Sorted", "one.txt"),
						"racer",
					);
			},
		});
		expect(() => context.engine.apply(context.binding)).toThrowError(
			expect.objectContaining({ code: "APPLY_FAILED" }),
		);
		expect(
			fs.readFileSync(path.join(context.grant, "Sorted", "one.txt"), "utf8"),
		).toBe("racer");
		expect(fs.readFileSync(path.join(context.grant, "one.txt"), "utf8")).toBe(
			"content-0",
		);
		expect(onlyBatch(context.journal)).toMatchObject({
			state: "rolling_back",
			trigger: "auto_failure",
		});
	});
});
