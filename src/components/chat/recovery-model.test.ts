import { describe, expect, it } from "vitest";

import {
	describeOperation,
	describeRecoveryCause,
	type OperationDisposition,
	type OperationOutcome,
	operationDisposition,
	RECOVERY_CAUSES,
	RECOVERY_OPERATION_OUTCOMES,
	RECOVERY_SAFETY_GUARANTEE,
	type RecoveryBatchSummary,
	type RecoveryCause,
	recoveryAccessibleLabel,
	recoveryNeedsAttention,
	recoveryPresentation,
} from "./recovery-model";

// Any forward slash or backslash is treated as a path leak — the model must
// carry display names only, never a filesystem path (PRD §8).
const PATH_CHARS = /[/\\]/;

/** Assert a string carries no filesystem-path separator of any kind. */
function expectNoPath(text: string): void {
	expect(PATH_CHARS.test(text)).toBe(false);
}

/**
 * The complete needs_attention cause vocabulary, enumerated by hand. This is the
 * guard the DoD asks for: if the engine grows a new cause, the union (and
 * `RECOVERY_CAUSES`) changes, and this equality check fails until the new cause
 * is enumerated here AND given a presentation.
 */
const EXPECTED_CAUSES: readonly RecoveryCause[] = [
	"grant_unavailable",
	"undo_unavailable",
	"in_doubt_conflict",
	"destination_changed",
	"origin_occupied",
	"source_missing",
	"destination_replaced",
	"filesystem_error",
];

/**
 * The disposition every outcome must classify into. Declared as an exhaustive
 * `Record`, so a new `OperationOutcome` is a compile error here too.
 */
const EXPECTED_DISPOSITION: Record<OperationOutcome, OperationDisposition> = {
	moved: "completed",
	folder_created: "completed",
	folder_existed: "completed",
	restored: "completed",
	restored_modified: "completed",
	folder_removed: "completed",
	folder_kept: "completed",
	pending: "pending",
	in_doubt_conflict: "conflicted",
	destination_changed: "conflicted",
	origin_occupied: "conflicted",
	source_missing: "conflicted",
	destination_replaced: "conflicted",
	filesystem_error: "conflicted",
};

describe("recovery cause presentations (S9 definition of done)", () => {
	it("enumerates exactly the engine's needs_attention causes (guard)", () => {
		expect([...RECOVERY_CAUSES].sort()).toEqual([...EXPECTED_CAUSES].sort());
	});

	it("gives every cause a non-empty, distinct, path-free presentation", () => {
		const headlines = new Set<string>();
		const explanations = new Set<string>();

		for (const cause of RECOVERY_CAUSES) {
			const presentation = describeRecoveryCause(cause);
			// Headline, explanation, and at least one safe next action.
			expect(presentation.headline.length).toBeGreaterThan(0);
			expect(presentation.explanation.length).toBeGreaterThan(0);
			expect(presentation.nextActions.length).toBeGreaterThanOrEqual(1);
			for (const action of presentation.nextActions) {
				expect(action.length).toBeGreaterThan(0);
				expectNoPath(action);
			}
			expectNoPath(presentation.headline);
			expectNoPath(presentation.explanation);

			headlines.add(presentation.headline);
			explanations.add(presentation.explanation);
		}

		// Distinct: no two causes share a headline or an explanation.
		expect(headlines.size).toBe(RECOVERY_CAUSES.length);
		expect(explanations.size).toBe(RECOVERY_CAUSES.length);
	});

	it("never suggests a destructive action for any cause", () => {
		for (const cause of RECOVERY_CAUSES) {
			for (const action of describeRecoveryCause(cause).nextActions) {
				// Only the instruction (before any "— nothing was …" reassurance) is
				// an imperative aimed at the user; the reassurance clause legitimately
				// says nothing was overwritten or deleted, so scan the instruction only.
				const instruction = action.split("—")[0];
				expect(instruction.toLowerCase()).not.toMatch(
					/\b(delete|remove|trash|erase|overwrite|discard|replace)\b/,
				);
			}
		}
	});
});

describe("operation disposition + wording", () => {
	it("classifies every outcome as completed / pending / conflicted", () => {
		for (const outcome of RECOVERY_OPERATION_OUTCOMES) {
			expect(operationDisposition(outcome)).toBe(EXPECTED_DISPOSITION[outcome]);
		}
	});

	it("words every outcome with a non-empty, path-free status and detail", () => {
		for (const outcome of RECOVERY_OPERATION_OUTCOMES) {
			const presentation = describeOperation({
				id: `op_${outcome}`,
				name: "quarterly-report.pdf",
				kind: "file",
				outcome,
			});
			expect(presentation.status.length).toBeGreaterThan(0);
			expect(presentation.detail.length).toBeGreaterThan(0);
			expect(presentation.name).toBe("quarterly-report.pdf");
			expectNoPath(presentation.status);
			expectNoPath(presentation.detail);
		}
	});

	it("attaches a safe next action + cause to conflicted operations only", () => {
		for (const outcome of RECOVERY_OPERATION_OUTCOMES) {
			const presentation = describeOperation({
				id: `op_${outcome}`,
				name: "notes.txt",
				kind: "file",
				outcome,
			});
			if (presentation.disposition === "conflicted") {
				expect(presentation.safeNextAction?.length ?? 0).toBeGreaterThan(0);
				expect(presentation.conflictCause).toBe(outcome);
				expectNoPath(presentation.safeNextAction ?? "");
			} else {
				expect(presentation.safeNextAction).toBeUndefined();
				expect(presentation.conflictCause).toBeUndefined();
			}
		}
	});
});

const RECOVERED: RecoveryBatchSummary = {
	batchId: "batch_recovered",
	locationLabel: "Downloads",
	state: "recovered",
	trigger: "recovery",
	operations: [
		{
			id: "folder_0",
			name: "Invoices",
			kind: "folder",
			outcome: "folder_created",
		},
		{ id: "move_0", name: "march-invoice.pdf", kind: "file", outcome: "moved" },
		{ id: "move_1", name: "april-invoice.pdf", kind: "file", outcome: "moved" },
	],
};

const ROLLED_BACK: RecoveryBatchSummary = {
	batchId: "batch_rolled_back",
	locationLabel: "Downloads",
	state: "rolled_back",
	trigger: "recovery",
	operations: [
		{ id: "move_0", name: "photo.jpg", kind: "file", outcome: "restored" },
		{
			id: "folder_0",
			name: "Photos",
			kind: "folder",
			outcome: "folder_removed",
		},
	],
};

const GRANT_UNAVAILABLE: RecoveryBatchSummary = {
	batchId: "batch_grant",
	locationLabel: "Downloads",
	state: "needs_attention",
	trigger: "recovery",
	reason: "grant_unavailable",
	operations: [
		{ id: "move_0", name: "resume.docx", kind: "file", outcome: "pending" },
	],
};

const UNDO_UNAVAILABLE: RecoveryBatchSummary = {
	batchId: "batch_undo_unavailable",
	locationLabel: "Documents",
	state: "needs_attention",
	trigger: "user_undo",
	reason: "unavailable",
	operations: [
		{ id: "move_0", name: "contract.pdf", kind: "file", outcome: "pending" },
	],
};

const CONFLICT: RecoveryBatchSummary = {
	batchId: "batch_conflict",
	locationLabel: "Downloads",
	state: "needs_attention",
	trigger: "recovery",
	reason: "revert_conflict",
	operations: [
		{ id: "move_0", name: "budget.xlsx", kind: "file", outcome: "restored" },
		{
			id: "move_1",
			name: "screenshot.png",
			kind: "file",
			outcome: "in_doubt_conflict",
		},
		{
			id: "move_2",
			name: "logo.svg",
			kind: "file",
			outcome: "origin_occupied",
		},
		{ id: "move_3", name: "draft.md", kind: "file", outcome: "pending" },
	],
};

const ALL_FIXTURES: readonly RecoveryBatchSummary[] = [
	RECOVERED,
	ROLLED_BACK,
	GRANT_UNAVAILABLE,
	UNDO_UNAVAILABLE,
	CONFLICT,
];

describe("recovery presentation", () => {
	it("derives per-disposition counts from the operations", () => {
		const presentation = recoveryPresentation(CONFLICT);
		expect(presentation.counts).toEqual({
			completed: 1,
			pending: 1,
			conflicted: 2,
		});
	});

	it("marks only needs_attention batches as needing attention", () => {
		expect(recoveryNeedsAttention(RECOVERED)).toBe(false);
		expect(recoveryNeedsAttention(ROLLED_BACK)).toBe(false);
		expect(recoveryNeedsAttention(CONFLICT)).toBe(true);
		expect(recoveryNeedsAttention(GRANT_UNAVAILABLE)).toBe(true);
	});

	it("tones each terminal outcome distinctly and always restates the guarantee", () => {
		expect(recoveryPresentation(RECOVERED).tone).toBe("positive");
		expect(recoveryPresentation(ROLLED_BACK).tone).toBe("neutral");
		expect(recoveryPresentation(CONFLICT).tone).toBe("attention");
		for (const fixture of ALL_FIXTURES) {
			expect(recoveryPresentation(fixture).guarantee).toBe(
				RECOVERY_SAFETY_GUARANTEE,
			);
		}
	});

	it("uses the whole-batch cause presentation when access is unavailable", () => {
		const grant = recoveryPresentation(GRANT_UNAVAILABLE);
		expect(grant.headline).toBe(
			describeRecoveryCause("grant_unavailable").headline,
		);
		expect(grant.nextActions).toEqual(
			describeRecoveryCause("grant_unavailable").nextActions,
		);

		const undo = recoveryPresentation(UNDO_UNAVAILABLE);
		expect(undo.headline).toBe(
			describeRecoveryCause("undo_unavailable").headline,
		);
	});

	it("aggregates the distinct safe actions of the conflicts that occurred", () => {
		const presentation = recoveryPresentation(CONFLICT);
		// The batch actions are exactly the union of its two conflict causes'
		// actions, in first-seen order, with no duplicates.
		const expected: string[] = [];
		for (const cause of ["in_doubt_conflict", "origin_occupied"] as const) {
			for (const action of describeRecoveryCause(cause).nextActions) {
				if (!expected.includes(action)) expected.push(action);
			}
		}
		expect(presentation.nextActions).toEqual(expected);
		expect(presentation.nextActions.length).toBeGreaterThanOrEqual(1);
	});

	it("defaults a reasonless needs_attention batch to the conflict narrative", () => {
		const presentation = recoveryPresentation({
			...CONFLICT,
			reason: undefined,
		});
		expect(presentation.tone).toBe("attention");
		expect(presentation.headline).toMatch(/attention/i);
	});

	it("never emits a path in any presentation string", () => {
		for (const fixture of ALL_FIXTURES) {
			const presentation = recoveryPresentation(fixture);
			expectNoPath(presentation.headline);
			expectNoPath(presentation.explanation);
			expectNoPath(presentation.guarantee);
			for (const action of presentation.nextActions) expectNoPath(action);
			for (const operation of presentation.operations) {
				expectNoPath(operation.name);
				expectNoPath(operation.status);
				expectNoPath(operation.detail);
				if (operation.safeNextAction) expectNoPath(operation.safeNextAction);
			}
			expectNoPath(recoveryAccessibleLabel(fixture));
		}
	});
});
