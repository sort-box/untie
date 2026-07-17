import { describe, expect, it } from "vitest";

import {
	APPLY_SAFETY_GUARANTEE,
	type ApplyJournalState,
	applyOperationCompleted,
	applyProgressMessage,
	buildApplyJournalState,
	buildApplyResult,
	deriveApplyProgress,
	findInFlightApply,
	isInFlightApplyMessage,
} from "./apply-progress-model";
import type { ChatMessage, PlanFolder } from "./message-model";

// A 10-move plan across three destinations (2 of them new), used for the
// durability walk-through. Display names only — no filesystem paths anywhere.
const FOLDERS: readonly PlanFolder[] = [
	{
		name: "Invoices",
		isNew: false,
		files: ["acme.pdf", "aws.pdf", "phone.pdf", "power.pdf"],
	},
	{
		name: "Photos",
		isNew: true,
		files: ["IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg"],
	},
	{
		name: "Installers",
		isNew: true,
		files: ["node.pkg", "docker.dmg", "figma.dmg"],
	},
];

const TOTAL = 10;

const freshState = (): ApplyJournalState =>
	buildApplyJournalState({
		operationId: "op-1",
		locationLabel: "Downloads",
		folders: FOLDERS,
	});

/** Advance a journal state `count` operations, each a completed event. */
const advance = (
	state: ApplyJournalState,
	count: number,
): ApplyJournalState => {
	let next = state;
	for (let i = 0; i < count; i += 1) next = applyOperationCompleted(next);
	return next;
};

/** The persistence boundary: what a save/reload round-trips is exactly JSON. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("apply journal state", () => {
	it("builds one pending operation per move, in plan order", () => {
		const state = freshState();
		expect(state.status).toBe("applying");
		expect(state.operations).toHaveLength(TOTAL);
		expect(state.operations.every((op) => op.status === "pending")).toBe(true);
		// Ordered by folder, then file, carrying display names + new/existing.
		expect(state.operations[0]).toEqual({
			destination: "Invoices",
			file: "acme.pdf",
			isNewFolder: false,
			status: "pending",
		});
		expect(state.operations[4].destination).toBe("Photos");
		expect(state.operations[4].isNewFolder).toBe(true);
	});
});

describe("live progress derived from the journal", () => {
	it("starts at 0 of total and names the first move", () => {
		const progress = deriveApplyProgress(freshState());
		expect(progress).toMatchObject({
			completed: 0,
			total: TOTAL,
			status: "applying",
		});
		expect(progress.current).toBe("Moving acme.pdf into Invoices");
	});

	it("advances the completed count per operation-completed event", () => {
		let state = freshState();
		for (let done = 1; done <= TOTAL; done += 1) {
			state = applyOperationCompleted(state);
			const progress = deriveApplyProgress(state);
			// The count is COUNTED from the journal, never incremented ad hoc.
			expect(progress.completed).toBe(done);
			expect(progress.total).toBe(TOTAL);
			expect(progress.completed).toBe(
				state.operations.filter((op) => op.status === "done").length,
			);
		}
		expect(deriveApplyProgress(state).status).toBe("done");
	});

	it("labels the operation currently in flight, path-free", () => {
		const progress = deriveApplyProgress(advance(freshState(), 4));
		// 4 done → the 5th (first Photos file) is the one in flight.
		expect(progress.completed).toBe(4);
		expect(progress.current).toBe("Moving IMG_1.jpg into Photos");
	});

	it("never lets a completed event overrun the total", () => {
		const state = advance(freshState(), TOTAL + 5);
		expect(deriveApplyProgress(state).completed).toBe(TOTAL);
		expect(deriveApplyProgress(state).status).toBe("done");
	});
});

describe("progress message derivation", () => {
	it("derives label/current/total from the journal and embeds it", () => {
		const state = advance(freshState(), 3);
		const message = applyProgressMessage(state, {
			id: "apply-1",
			createdAt: 5,
		});
		const progress = deriveApplyProgress(state);
		expect(message).toMatchObject({
			kind: "progress",
			id: "apply-1",
			createdAt: 5,
			label: progress.current,
			current: progress.completed,
			total: progress.total,
		});
		// The journal state is embedded so it persists and can be recovered.
		expect(message.apply).toEqual(state);
		expect(isInFlightApplyMessage(message)).toBe(true);
	});
});

describe("final result summary from the completed journal", () => {
	it("derives moved/created counts and restates the safety guarantee", () => {
		const done = advance(freshState(), TOTAL);
		const result = buildApplyResult(done, { id: "apply-1", createdAt: 9 });
		expect(result).toMatchObject({
			kind: "result",
			id: "apply-1",
			createdAt: 9,
			movedCount: TOTAL,
			folderCount: 3,
			createdFolderCount: 2,
		});
		expect(result.summary).toBe(
			`Moved 10 files into 3 folders in Downloads. ${APPLY_SAFETY_GUARANTEE}`,
		);
		// The exact v1 safety wording already used across the codebase.
		expect(result.summary).toContain(
			"Nothing was renamed, overwritten, or deleted.",
		);
	});
});

describe("durability across a renderer reload", () => {
	it("recovers 3 of 10 from persisted state, then finishes correctly", () => {
		// Apply 3 of 10 operations, then persist exactly what a save would store.
		const midApply = advance(freshState(), 3);
		const seededMessage = applyProgressMessage(midApply, {
			id: "apply-1",
			createdAt: 100,
		});
		const transcript: ChatMessage[] = [
			{ kind: "user", id: "u1", createdAt: 1, text: "Sort my Downloads" },
			seededMessage,
		];

		// Simulate the reload: reconstruct the transcript the way a fresh mount
		// would, straight from the persisted (JSON) bytes.
		const reloaded = roundTrip(transcript);
		const recovered = findInFlightApply(reloaded);
		expect(recovered).toBeDefined();
		if (!recovered) throw new Error("expected an in-flight apply");

		// Not a reset (0) and not a stale/lost value — the journal's 3 of 10.
		const recoveredProgress = deriveApplyProgress(recovered.apply);
		expect(recoveredProgress.completed).toBe(3);
		expect(recoveredProgress.total).toBe(10);
		expect(recoveredProgress.status).toBe("applying");
		// The right operations survived: first three done, fourth still pending.
		expect(recovered.apply.operations.map((op) => op.status)).toEqual([
			"done",
			"done",
			"done",
			"pending",
			"pending",
			"pending",
			"pending",
			"pending",
			"pending",
			"pending",
		]);
		expect(recoveredProgress.current).toBe("Moving power.pdf into Invoices");

		// Advancing the remaining 7 operations still reaches the correct summary.
		const finished = advance(recovered.apply, 7);
		expect(deriveApplyProgress(finished).status).toBe("done");
		const result = buildApplyResult(finished, {
			id: recovered.id,
			createdAt: 200,
		});
		expect(result.movedCount).toBe(10);
		expect(result.folderCount).toBe(3);
		expect(result.createdFolderCount).toBe(2);
	});

	it("finds nothing to resume once the apply has completed", () => {
		const done = advance(freshState(), TOTAL);
		const result = buildApplyResult(done, { id: "apply-1", createdAt: 9 });
		// A finished apply leaves a `result` (no in-flight journal) — nothing resumes.
		expect(findInFlightApply([result])).toBeUndefined();
		expect(isInFlightApplyMessage(result)).toBe(false);
	});
});

describe("no filesystem path ever appears in the model", () => {
	it("keeps journal state, progress, and summary path-free", () => {
		const state = advance(freshState(), 4);
		const message = applyProgressMessage(state, { id: "a", createdAt: 0 });
		const result = buildApplyResult(advance(state, 6), {
			id: "a",
			createdAt: 0,
		});

		// A path separator would betray a filesystem path leaking into the renderer.
		const hasPathSeparator = (text: string) =>
			text.includes("/") || text.includes("\\");

		expect(hasPathSeparator(JSON.stringify(state))).toBe(false);
		expect(hasPathSeparator(deriveApplyProgress(state).current)).toBe(false);
		expect(hasPathSeparator(message.label)).toBe(false);
		expect(hasPathSeparator(result.summary)).toBe(false);
		// Each record exposes only display names, never a path-shaped field.
		for (const op of state.operations) {
			expect(hasPathSeparator(op.file)).toBe(false);
			expect(hasPathSeparator(op.destination)).toBe(false);
		}
	});
});
