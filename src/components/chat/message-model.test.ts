import { describe, expect, it } from "vitest";

import {
	type ChatMessage,
	isPlanApprovable,
	type MessageKind,
	messageAccessibleLabel,
	type PlanFolder,
	type PlanMessage,
	planApprovalCopy,
	planBlockReason,
	planCreatedFolderCount,
	planMoveCount,
	upsertMessage,
} from "./message-model";
import {
	buildApplySteps,
	buildInvalidPlan,
	buildSortFailure,
	buildSortPlanSteps,
	buildStalePlan,
	buildUndoMessage,
	type DriverStep,
	runDriverSteps,
} from "./mock-sort-driver";

const ALL_KINDS: readonly MessageKind[] = [
	"user",
	"pending",
	"progress",
	"plan",
	"result",
	"undo",
	"failed",
];

const SAMPLE_FOLDERS: readonly PlanFolder[] = [
	{ name: "Photos", isNew: true, files: ["a.jpg", "b.jpg", "c.jpg"] },
	{ name: "Contracts", isNew: false, files: ["lease.pdf"] },
];

/** One sample message per kind, used to prove the exhaustive helpers cover all. */
const SAMPLES: Record<MessageKind, ChatMessage> = {
	user: { kind: "user", id: "u", createdAt: 0, text: "Sort my Downloads" },
	pending: { kind: "pending", id: "a", createdAt: 0, label: "Scanning…" },
	progress: {
		kind: "progress",
		id: "a",
		createdAt: 0,
		label: "Grouping",
		current: 1,
		total: 3,
	},
	plan: {
		kind: "plan",
		id: "a",
		createdAt: 0,
		summary: "4 files into 2 folders",
		fileCount: 4,
		folderCount: 2,
		createdFolderCount: 1,
		folders: SAMPLE_FOLDERS,
		status: "ready",
	},
	result: {
		kind: "result",
		id: "r",
		createdAt: 0,
		summary: "Moved 42 files.",
		movedCount: 42,
		folderCount: 6,
		createdFolderCount: 4,
	},
	undo: {
		kind: "undo",
		id: "z",
		createdAt: 0,
		summary: "Restored 42 files.",
		restoredCount: 42,
		removedFolderCount: 4,
	},
	failed: {
		kind: "failed",
		id: "a",
		createdAt: 0,
		title: "Timed out",
		detail: "No plan came back.",
		retryable: true,
	},
};

const kindsOf = (steps: readonly DriverStep[]): MessageKind[] =>
	steps.map((step) => step.message.kind);

const planStepOf = (steps: readonly DriverStep[]): PlanMessage => {
	const step = steps.find((s) => s.message.kind === "plan")?.message;
	if (step?.kind !== "plan") throw new Error("expected a plan step");
	return step;
};

describe("message model helpers", () => {
	it("produces a non-empty accessible label for every kind", () => {
		for (const kind of ALL_KINDS) {
			const label = messageAccessibleLabel(SAMPLES[kind]);
			expect(label.length).toBeGreaterThan(0);
		}
	});

	it("labels non-ready plans with their state for screen readers", () => {
		const stale: PlanMessage = {
			...SAMPLES.plan,
			status: "stale",
		} as PlanMessage;
		expect(messageAccessibleLabel(stale)).toContain("out of date");
		const invalid: PlanMessage = {
			...SAMPLES.plan,
			status: "invalid",
		} as PlanMessage;
		expect(messageAccessibleLabel(invalid)).toContain("needs attention");
	});

	it("appends a new message and replaces one with a matching id in place", () => {
		const pending = SAMPLES.pending;
		const withPending = upsertMessage([SAMPLES.user], pending);
		expect(withPending).toHaveLength(2);

		// Same id (assistant status evolving) → replace, not append.
		const evolved = upsertMessage(withPending, SAMPLES.progress);
		expect(evolved).toHaveLength(2);
		expect(evolved[1].kind).toBe("progress");

		// New id → append.
		const appended = upsertMessage(evolved, SAMPLES.result);
		expect(appended).toHaveLength(3);
	});
});

describe("plan counts + approval copy", () => {
	it("derives move and created-folder counts from the folders", () => {
		expect(planMoveCount(SAMPLE_FOLDERS)).toBe(4);
		expect(planCreatedFolderCount(SAMPLE_FOLDERS)).toBe(1);
	});

	it("states exact counts and the safety guarantee", () => {
		const copy = planApprovalCopy(SAMPLE_FOLDERS);
		expect(copy).toBe(
			"Create 1 folder and move 4 files. Nothing is renamed, overwritten, or deleted.",
		);
	});

	it("phrases the copy for existing-only destinations without a create clause", () => {
		const existingOnly: PlanFolder[] = [
			{ name: "Contracts", isNew: false, files: ["lease.pdf", "nda.pdf"] },
		];
		expect(planApprovalCopy(existingOnly)).toBe(
			"Move 2 files into existing folders. Nothing is renamed, overwritten, or deleted.",
		);
	});

	it("only allows a ready plan to be approved", () => {
		expect(isPlanApprovable("ready")).toBe(true);
		for (const status of ["stale", "invalid", "approved"] as const) {
			expect(isPlanApprovable(status)).toBe(false);
		}
	});

	it("gives a null block reason for ready and a message for the rest", () => {
		expect(planBlockReason(SAMPLES.plan as PlanMessage)).toBeNull();
		for (const status of ["stale", "invalid", "approved"] as const) {
			const reason = planBlockReason({
				...(SAMPLES.plan as PlanMessage),
				status,
			});
			expect(reason?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it("prefers an explicit statusReason over the default", () => {
		const reason = planBlockReason({
			...(SAMPLES.plan as PlanMessage),
			status: "stale",
			statusReason: "Custom reason.",
		});
		expect(reason).toBe("Custom reason.");
	});
});

describe("mock sort driver", () => {
	it("walks a sort request through pending → progress → plan and stops (no auto-apply)", () => {
		const steps = buildSortPlanSteps({ assistantId: "assistant-1", now: 1000 });

		const distinct = kindsOf(steps).filter(
			(kind, index, all) => all.indexOf(kind) === index,
		);
		expect(distinct).toEqual(["pending", "progress", "plan"]);

		// Every step shares one evolving assistant id, ending at a ready plan.
		expect(steps.every((s) => s.message.id === "assistant-1")).toBe(true);
		expect(steps.at(-1)?.message.kind).toBe("plan");
		expect(planStepOf(steps).status).toBe("ready");

		// No result is emitted — approval is the user's job now (W13).
		expect(kindsOf(steps)).not.toContain("result");

		// Delays are non-negative so the runner schedules monotonically.
		expect(steps.every((s) => s.delayMs >= 0)).toBe(true);
	});

	it("keeps a plan's denormalised summary counts consistent with its folders", () => {
		const plan = planStepOf(buildSortPlanSteps({ assistantId: "a", now: 0 }));
		const summed = plan.folders.reduce((t, f) => t + f.files.length, 0);
		expect(summed).toBe(plan.fileCount);
		expect(plan.folderCount).toBe(plan.folders.length);
		expect(plan.createdFolderCount).toBe(
			plan.folders.filter((f) => f.isNew).length,
		);
		// A believably long group so the card's expandable full list matters.
		expect(
			Math.max(...plan.folders.map((f) => f.files.length)),
		).toBeGreaterThan(5);
	});

	it("applies an approved plan one operation at a time, ending in a result", () => {
		const plan = planStepOf(buildSortPlanSteps({ assistantId: "a", now: 0 }));
		const steps = buildApplySteps({
			applyId: "apply-1",
			now: 0,
			folders: plan.folders,
		});

		// Per-operation determinate progress, then a single terminal result.
		const kinds = kindsOf(steps);
		expect(new Set(kinds)).toEqual(new Set(["progress", "result"]));
		expect(kinds.at(-1)).toBe("result");
		expect(kinds.slice(0, -1).every((kind) => kind === "progress")).toBe(true);

		// One progress step per completed operation: the completed count advances
		// 0, 1, 2, … and is derived from the journal (never exceeds the total).
		const total = planMoveCount(plan.folders);
		const progressCurrents = steps
			.map((step) => step.message)
			.filter((message) => message.kind === "progress")
			.map((message) => message.current);
		expect(progressCurrents).toEqual(
			Array.from({ length: total }, (_, index) => index),
		);
		expect(kinds.filter((kind) => kind === "progress")).toHaveLength(total);

		// Every step shares the evolving apply id, and the counts on the terminal
		// result derive from the plan's own move set.
		expect(steps.every((step) => step.message.id === "apply-1")).toBe(true);
		const result = steps.at(-1)?.message;
		if (result?.kind !== "result") throw new Error("expected a result");
		expect(result.movedCount).toBe(total);
		expect(result.createdFolderCount).toBe(
			planCreatedFolderCount(plan.folders),
		);
		expect(result.folderCount).toBe(plan.folders.length);
	});

	it("builds stale and invalid plans that cannot be approved", () => {
		const stale = buildStalePlan({ id: "s", now: 0 });
		expect(stale.status).toBe("stale");
		expect(isPlanApprovable(stale.status)).toBe(false);
		expect(stale.statusReason).toBeTruthy();

		const invalid = buildInvalidPlan({ id: "i", now: 0 });
		expect(invalid.status).toBe("invalid");
		expect(isPlanApprovable(invalid.status)).toBe(false);
		expect(invalid.statusReason).toBeTruthy();

		// Both still carry the full move set so the card can render every move.
		expect(planMoveCount(stale.folders)).toBeGreaterThan(0);
		expect(planMoveCount(invalid.folders)).toBeGreaterThan(0);
	});

	it("walks a failed request through pending → progress → failed", () => {
		const steps = buildSortFailure({ assistantId: "a", now: 0 });
		expect(kindsOf(steps)).toEqual(["pending", "progress", "failed"]);
		expect(steps.every((s) => s.message.id === "a")).toBe(true);
	});

	it("builds an undo message that mirrors the sorted counts", () => {
		const undo = buildUndoMessage({
			id: "z",
			now: 0,
			restoredCount: 42,
			removedFolderCount: 4,
		});
		expect(undo.kind).toBe("undo");
		if (undo.kind !== "undo") throw new Error("expected undo");
		expect(undo.restoredCount).toBe(42);
		expect(undo.removedFolderCount).toBe(4);
	});

	it("replays every step in order and reports completion", async () => {
		const steps = buildSortPlanSteps({ assistantId: "a", now: 0 });
		const seen: MessageKind[] = [];
		let done = false;

		await new Promise<void>((resolve) => {
			runDriverSteps(
				// Collapse delays so the test runs fast.
				steps.map((s) => ({ ...s, delayMs: 0 })),
				(message) => seen.push(message.kind),
				() => {
					done = true;
					resolve();
				},
			);
		});

		expect(done).toBe(true);
		expect(seen).toEqual(kindsOf(steps));
	});

	it("cancels pending steps so nothing is applied after cancel", async () => {
		const applied: MessageKind[] = [];
		const handle = runDriverSteps(
			[
				{ delayMs: 5, message: SAMPLES.pending },
				{ delayMs: 5, message: SAMPLES.progress },
			],
			(message) => applied.push(message.kind),
		);
		handle.cancel();

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(applied).toEqual([]);
	});
});
