import { describe, expect, it } from "vitest";

import {
	type ChatMessage,
	type MessageKind,
	messageAccessibleLabel,
	upsertMessage,
} from "./message-model";
import {
	buildSortFailure,
	buildSortRoundTrip,
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
		summary: "42 files into 6 folders",
		fileCount: 42,
		folderCount: 6,
		createdFolderCount: 4,
		folders: [{ name: "Photos", fileCount: 7, isNew: true, examples: [] }],
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

describe("message model helpers", () => {
	it("produces a non-empty accessible label for every kind", () => {
		for (const kind of ALL_KINDS) {
			const label = messageAccessibleLabel(SAMPLES[kind]);
			expect(label.length).toBeGreaterThan(0);
		}
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

describe("mock sort driver", () => {
	it("walks a sort request through pending → progress → plan → result", () => {
		const steps = buildSortRoundTrip({
			assistantId: "assistant-1",
			resultId: "result-1",
			now: 1000,
		});

		const distinct = kindsOf(steps).filter(
			(kind, index, all) => all.indexOf(kind) === index,
		);
		expect(distinct).toEqual(["pending", "progress", "plan", "result"]);

		// Every non-terminal state shares one evolving assistant id; the result
		// is a distinct, appended message.
		const beforeResult = steps.slice(0, -1);
		expect(beforeResult.every((s) => s.message.id === "assistant-1")).toBe(
			true,
		);
		expect(steps.at(-1)?.message.id).toBe("result-1");

		// Delays are non-negative so the runner schedules monotonically.
		expect(steps.every((s) => s.delayMs >= 0)).toBe(true);
	});

	it("keeps plan and result totals internally consistent", () => {
		const steps = buildSortRoundTrip({
			assistantId: "a",
			resultId: "r",
			now: 0,
		});
		const plan = steps.find((s) => s.message.kind === "plan")?.message;
		const result = steps.find((s) => s.message.kind === "result")?.message;
		if (plan?.kind !== "plan" || result?.kind !== "result") {
			throw new Error("expected a plan and a result step");
		}

		const summed = plan.folders.reduce((total, f) => total + f.fileCount, 0);
		expect(summed).toBe(plan.fileCount);
		expect(plan.folderCount).toBe(plan.folders.length);
		expect(plan.createdFolderCount).toBe(
			plan.folders.filter((f) => f.isNew).length,
		);
		expect(result.movedCount).toBe(plan.fileCount);
		expect(result.createdFolderCount).toBe(plan.createdFolderCount);
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
		const steps = buildSortRoundTrip({
			assistantId: "a",
			resultId: "r",
			now: 0,
		});
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
