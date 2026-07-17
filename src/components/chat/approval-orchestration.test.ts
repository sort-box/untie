import { describe, expect, it } from "vitest";

import {
	type ApprovalAction,
	type ApprovalEffect,
	type ApprovalState,
	approvalMutationCopy,
	initialApprovalState,
	planAcknowledgmentCopy,
	planFingerprint,
	planHasLowConfidenceMoves,
	planLowConfidenceCount,
	planLowConfidenceMoves,
	planRequiresAcknowledgment,
	reduceApproval,
} from "./approval-orchestration";
import {
	type PlanFolder,
	type PlanMessage,
	planApprovalCopy,
	planBlockReason,
	planCreatedFolderCount,
	planMoveCount,
} from "./message-model";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A plan whose every move the model was confident about — no ack required. */
const CONFIDENT_FOLDERS: readonly PlanFolder[] = [
	{ name: "Screenshots", isNew: true, files: ["a.png", "b.png"] },
	{ name: "Contracts", isNew: false, files: ["lease.pdf"] },
];

/** A plan that still carries a low-confidence move — approval must be gated. */
const FLAGGED_FOLDERS: readonly PlanFolder[] = [
	{
		name: "Invoices",
		isNew: false,
		files: ["inv-1.pdf", "inv-2.pdf"],
		lowConfidenceFiles: ["inv-2.pdf"],
	},
	{ name: "Photos", isNew: true, files: ["IMG_1.jpg"] },
];

/** Build a `PlanMessage` with denormalised counts kept in lock-step. */
function makePlan(overrides: Partial<PlanMessage> = {}): PlanMessage {
	const folders = overrides.folders ?? CONFIDENT_FOLDERS;
	return {
		kind: "plan",
		id: overrides.id ?? "plan-1",
		createdAt: overrides.createdAt ?? 0,
		summary: overrides.summary ?? "sample plan",
		fileCount: planMoveCount(folders),
		folderCount: folders.length,
		createdFolderCount: planCreatedFolderCount(folders),
		folders,
		status: overrides.status ?? "ready",
		...(overrides.statusReason ? { statusReason: overrides.statusReason } : {}),
	};
}

/** Thread a sequence of actions through the reducer, collecting the effects. */
function drive(
	actions: readonly ApprovalAction[],
	start: ApprovalState = initialApprovalState,
): { state: ApprovalState; effects: ApprovalEffect[] } {
	let state = start;
	const effects: ApprovalEffect[] = [];
	for (const action of actions) {
		const result = reduceApproval(state, action);
		state = result.state;
		effects.push(result.effect);
	}
	return { state, effects };
}

const submitEffects = (effects: readonly ApprovalEffect[]) =>
	effects.filter((effect) => effect.type === "submit");

// ── Behavior 1: exact mutation copy ──────────────────────────────────────────

describe("S6 · exact mutation copy", () => {
	it("has no mutation copy when nothing is bound", () => {
		expect(approvalMutationCopy(null)).toBeNull();
	});

	it("derives the mutation copy from the SAME snapshot that would be applied", () => {
		const snapshot = makePlan();
		const { state } = drive([{ type: "approve", snapshot, version: "v1" }]);

		// The bound snapshot is exactly what was approved, and its copy is the
		// card's exact-counts line for that snapshot — the two can never disagree.
		expect(state.pending?.snapshot).toBe(snapshot);
		expect(approvalMutationCopy(state.pending)).toBe(
			planApprovalCopy(snapshot.folders),
		);
		expect(approvalMutationCopy(state.pending)).toBe(
			"Create 1 folder and move 3 files. Nothing is renamed, overwritten, or deleted.",
		);
	});

	it("reflects a trimmed snapshot's counts, never the untrimmed plan's", () => {
		// The card hands off a trimmed snapshot (some files excluded). The copy must
		// track the trimmed folders, so an excluded file can never leak into it.
		const trimmed = makePlan({
			folders: [{ name: "Contracts", isNew: false, files: ["lease.pdf"] }],
		});
		const { state } = drive([
			{ type: "approve", snapshot: trimmed, version: "v1" },
		]);
		expect(approvalMutationCopy(state.pending)).toBe(
			"Move 1 file into existing folders. Nothing is renamed, overwritten, or deleted.",
		);
		expect(approvalMutationCopy(state.pending)).not.toBe(
			planApprovalCopy(CONFIDENT_FOLDERS),
		);
	});
});

// ── Behavior 2: risk-warning acknowledgment ──────────────────────────────────

describe("S6 · risk-warning acknowledgment", () => {
	it("flags a plan with low-confidence moves and only that plan", () => {
		expect(planHasLowConfidenceMoves(FLAGGED_FOLDERS)).toBe(true);
		expect(planHasLowConfidenceMoves(CONFIDENT_FOLDERS)).toBe(false);
		expect(
			planRequiresAcknowledgment(makePlan({ folders: FLAGGED_FOLDERS })),
		).toBe(true);
		expect(planRequiresAcknowledgment(makePlan())).toBe(false);
	});

	it("summarises exactly the moves to double-check, by name and destination", () => {
		expect(planLowConfidenceCount(FLAGGED_FOLDERS)).toBe(1);
		expect(planLowConfidenceMoves(FLAGGED_FOLDERS)).toEqual([
			{ file: "inv-2.pdf", destination: "Invoices" },
		]);
		expect(planAcknowledgmentCopy(FLAGGED_FOLDERS)).toContain("1 move");
	});

	it("submits a confident plan directly, with no acknowledgment phase", () => {
		const snapshot = makePlan();
		const { state, effects } = drive([
			{ type: "approve", snapshot, version: "v1" },
		]);
		expect(state.phase).toBe("submitting");
		expect(effects).toEqual([{ type: "submit", snapshot }]);
	});

	it("gates a flagged plan behind an explicit acknowledgment before submitting", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });

		// Approving first enters the confirming-acknowledgment phase — nothing is
		// submitted yet — and binds the snapshot with its risk flag.
		const requested = reduceApproval(initialApprovalState, {
			type: "approve",
			snapshot,
			version: "v1",
		});
		expect(requested.state.phase).toBe("confirming-acknowledgment");
		expect(requested.state.pending?.requiresAcknowledgment).toBe(true);
		expect(requested.effect).toEqual({ type: "none" });

		// The explicit acknowledgment (with an in-date binding) proceeds to submit.
		const acknowledged = reduceApproval(requested.state, {
			type: "acknowledge",
			live: { status: "ready", version: "v1" },
		});
		expect(acknowledged.state.phase).toBe("submitting");
		expect(acknowledged.effect).toEqual({ type: "submit", snapshot });
	});

	it("dismisses the acknowledgment without submitting on cancel", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });
		const { state, effects } = drive([
			{ type: "approve", snapshot, version: "v1" },
			{ type: "cancel" },
		]);
		expect(state).toEqual(initialApprovalState);
		expect(submitEffects(effects)).toHaveLength(0);
	});
});

// ── Behavior 3: disabled states with reasons ─────────────────────────────────

describe("S6 · non-ready plans are refused with a reason", () => {
	for (const status of ["stale", "invalid", "approved"] as const) {
		it(`refuses a ${status} plan and surfaces planBlockReason`, () => {
			const snapshot = makePlan({ status });
			const { state, effects } = drive([
				{ type: "approve", snapshot, version: "v1" },
			]);

			// It never enters an approval phase and never submits.
			expect(state.phase).toBe("idle");
			expect(submitEffects(effects)).toHaveLength(0);
			expect(effects[0]).toEqual({
				type: "blocked",
				reason: planBlockReason(snapshot),
			});
			expect(state.blockedReason).toBe(planBlockReason(snapshot));
		});
	}
});

// ── Behavior 4: double-submit prevention ─────────────────────────────────────

describe("S6 · double-submit prevention", () => {
	it("submits once when a confident plan is approved twice in a row", () => {
		const snapshot = makePlan();
		const { state, effects } = drive([
			{ type: "approve", snapshot, version: "v1" },
			{ type: "approve", snapshot, version: "v1" },
		]);
		expect(state.phase).toBe("submitting");
		// Two rapid approves → exactly one submit; the second is a no-op.
		expect(submitEffects(effects)).toHaveLength(1);
		expect(effects[1]).toEqual({ type: "none" });
	});

	it("submits once when a flagged plan is acknowledged twice in a row", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });
		const live = { status: "ready" as const, version: "v1" };
		const { effects } = drive([
			{ type: "approve", snapshot, version: "v1" },
			{ type: "acknowledge", live },
			{ type: "acknowledge", live },
		]);
		expect(submitEffects(effects)).toHaveLength(1);
	});

	it("ignores an approve fired while already submitting", () => {
		const snapshot = makePlan();
		const submitting = reduceApproval(initialApprovalState, {
			type: "approve",
			snapshot,
			version: "v1",
		}).state;
		expect(submitting.phase).toBe("submitting");

		const again = reduceApproval(submitting, {
			type: "approve",
			snapshot,
			version: "v1",
		});
		expect(again.state).toBe(submitting);
		expect(again.effect).toEqual({ type: "none" });
	});
});

// ── Behavior 5: snapshot / version binding ───────────────────────────────────

describe("S6 · snapshot/version binding blocks a stale submit", () => {
	it("fingerprints the identity, status, and exact move set of a plan", () => {
		const base = makePlan({ folders: FLAGGED_FOLDERS });
		// Same plan → same fingerprint (stable, deterministic).
		expect(planFingerprint(base)).toBe(
			planFingerprint(makePlan({ folders: FLAGGED_FOLDERS })),
		);
		// A status change or a changed move set → a different fingerprint.
		expect(planFingerprint({ ...base, status: "stale" })).not.toBe(
			planFingerprint(base),
		);
		expect(
			planFingerprint(
				makePlan({
					folders: [
						{ name: "Invoices", isNew: false, files: ["inv-1.pdf"] },
						{ name: "Photos", isNew: true, files: ["IMG_1.jpg"] },
					],
				}),
			),
		).not.toBe(planFingerprint(base));
	});

	it("blocks the submit when the bound plan went stale, and does NOT apply", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });

		// Bind an approval to the plan's version…
		const requested = reduceApproval(initialApprovalState, {
			type: "approve",
			snapshot,
			version: planFingerprint(snapshot),
		});
		expect(requested.state.phase).toBe("confirming-acknowledgment");

		// …then the plan is marked stale underneath the user. Acknowledging now must
		// refuse rather than apply the out-of-date plan.
		const acknowledged = reduceApproval(requested.state, {
			type: "acknowledge",
			live: { status: "stale", version: planFingerprint(snapshot) },
		});
		expect(acknowledged.effect.type).toBe("blocked");
		if (acknowledged.effect.type !== "blocked")
			throw new Error("expected block");
		expect(acknowledged.effect.reason).toBe(
			planBlockReason({
				...snapshot,
				status: "stale",
				statusReason: undefined,
			}),
		);
		expect(acknowledged.effect.reason).toMatch(/out of date/i);
		// Refused: back to idle, binding released, and no submit was emitted.
		expect(acknowledged.state.phase).toBe("idle");
		expect(acknowledged.state.pending).toBeNull();
	});

	it("surfaces an explicit stale reason from the live plan when present", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });
		const requested = reduceApproval(initialApprovalState, {
			type: "approve",
			snapshot,
			version: planFingerprint(snapshot),
		});
		const acknowledged = reduceApproval(requested.state, {
			type: "acknowledge",
			live: {
				status: "stale",
				version: planFingerprint(snapshot),
				statusReason: "A referenced file changed on disk.",
			},
		});
		if (acknowledged.effect.type !== "blocked")
			throw new Error("expected block");
		expect(acknowledged.effect.reason).toBe(
			"A referenced file changed on disk.",
		);
	});

	it("blocks the submit when the bound version no longer matches", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });
		const requested = reduceApproval(initialApprovalState, {
			type: "approve",
			snapshot,
			version: "bound-version",
		});

		// The plan is still ready, but its version drifted (e.g. regenerated to a
		// different ready plan under the same id) — the out-of-date snapshot is refused.
		const acknowledged = reduceApproval(requested.state, {
			type: "acknowledge",
			live: { status: "ready", version: "different-version" },
		});
		expect(acknowledged.effect.type).toBe("blocked");
		expect(acknowledged.state.phase).toBe("idle");
	});

	it("blocks the submit when the bound plan left the transcript entirely", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });
		const requested = reduceApproval(initialApprovalState, {
			type: "approve",
			snapshot,
			version: "v1",
		});
		const acknowledged = reduceApproval(requested.state, {
			type: "acknowledge",
			live: { status: "gone", version: "" },
		});
		expect(acknowledged.effect.type).toBe("blocked");
		expect(acknowledged.state.phase).toBe("idle");
	});

	it("applies when the bound version still matches an in-date plan", () => {
		const snapshot = makePlan({ folders: FLAGGED_FOLDERS });
		const version = planFingerprint(snapshot);
		const requested = reduceApproval(initialApprovalState, {
			type: "approve",
			snapshot,
			version,
		});
		const acknowledged = reduceApproval(requested.state, {
			type: "acknowledge",
			live: { status: "ready", version },
		});
		expect(acknowledged.effect).toEqual({ type: "submit", snapshot });
	});
});

// ── Lifecycle: settle returns the machine to idle ────────────────────────────

describe("S6 · submit settles back to idle", () => {
	it("returns to idle once the in-flight submit settles", () => {
		const snapshot = makePlan();
		const { state } = drive([
			{ type: "approve", snapshot, version: "v1" },
			{ type: "settle" },
		]);
		expect(state).toEqual(initialApprovalState);
	});

	it("ignores settle and cancel when nothing is in flight", () => {
		expect(reduceApproval(initialApprovalState, { type: "settle" })).toEqual({
			state: initialApprovalState,
			effect: { type: "none" },
		});
		expect(reduceApproval(initialApprovalState, { type: "cancel" })).toEqual({
			state: initialApprovalState,
			effect: { type: "none" },
		});
	});
});
