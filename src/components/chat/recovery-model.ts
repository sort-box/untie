// Crash-recovery + needs_attention presentation model (S9).
//
// When Untie is reopened after a crash, the recovery engine
// (electron/crash-recovery.cjs) replays every unfinished sort batch and leaves
// each one in a terminal outcome: it either rolled the batch FORWARD to
// `applied` (surfaced here as `recovered`), rolled it BACK to `rolled_back`, or
// — when it can't finish safely — parks it in `needs_attention`. The undo path
// in electron/journaled-apply.cjs uses the same vocabulary. This module is the
// pure renderer model that turns one of those recovered batches into a
// user-comprehensible presentation: a headline, a plain-language explanation of
// the CAUSE, a classification of every operation as completed / pending /
// conflicted, and a list of SAFE next actions appropriate to the cause.
//
// The engine's cause vocabulary is the source of truth. Every needs_attention
// cause it can produce has an explicit presentation below, wired through an
// exhaustive switch guarded by `assertNever`, so adding a cause without a
// user-comprehensible presentation is a compile error (mirroring the message
// model in message-model.ts). `RECOVERY_CAUSES` and `RECOVERY_OPERATION_OUTCOMES`
// are derived from `satisfies Record<…>` maps, so those lists can never fall out
// of step with the union types either.
//
// It is path-free by construction, exactly like the plan, apply, and disclosure
// models: a recovered batch is summarised into display NAMES and opaque IDs only
// (PRD §8 — filenames are sensitive; a filesystem path must never enter the
// renderer or a log). The pure functions let the whole presentation be asserted
// without React, and let real crash-recovery IPC replace the fixtures later
// without touching this model — the same way the other chat cards were built
// before their live data was wired.

import { assertNever } from "./message-model";

/** The v1 safety guarantee, restated honestly on every recovered batch. */
export const RECOVERY_SAFETY_GUARANTEE =
	"Nothing was renamed, overwritten, or deleted. Any item Untie couldn't finish was left exactly where it is.";

/**
 * The terminal outcome the recovery engine left a batch in, as the renderer sees
 * it. `recovered` is the engine's roll-forward `applied`; `rolled_back` is a
 * clean reverse; `needs_attention` is the one that asks something of the user.
 */
export type RecoveryBatchState =
	| "recovered"
	| "rolled_back"
	| "needs_attention";

/** Whether recovery ran automatically after a crash, or from a user's undo. */
export type RecoveryTrigger = "recovery" | "user_undo";

/**
 * Why a batch is in `needs_attention`, at the BATCH level. `grant_unavailable`
 * (crash recovery) and `unavailable` (user undo) mean Untie lost access to the
 * folder before it could finish; `revert_conflict` means the folder was reachable
 * but one or more operations couldn't be completed safely, so the per-operation
 * causes carry the detail. A `needs_attention` summary with no reason is treated
 * as `revert_conflict`.
 */
export type RecoveryBatchReason =
	| "grant_unavailable"
	| "unavailable"
	| "revert_conflict";

/**
 * Every distinct needs_attention CAUSE the engine can produce, normalised into
 * one canonical vocabulary. Two whole-batch blockers plus the per-operation
 * conflict causes. The engine's mixed-case tokens map here as:
 *   grant_unavailable   ← crash-recovery batch.reason "grant_unavailable"
 *   undo_unavailable    ← undo batch.reason "unavailable"
 *   in_doubt_conflict   ← item.reason "IN_DOUBT_CONFLICT"
 *   destination_changed ← item.reason "DESTINATION_CHANGED" / "destination_changed"
 *   origin_occupied     ← item.reason "origin_occupied"
 *   source_missing      ← item.reason "source_missing"
 *   destination_replaced← item.reason "destination_replaced"
 *   filesystem_error    ← item.reason "filesystem_error" / "FILESYSTEM_ERROR"
 * `describeRecoveryCause` maps each to a presentation through an exhaustive
 * switch, so a new cause is a compile error until it is handled.
 */
export type RecoveryCause =
	| "grant_unavailable"
	| "undo_unavailable"
	| "in_doubt_conflict"
	| "destination_changed"
	| "origin_occupied"
	| "source_missing"
	| "destination_replaced"
	| "filesystem_error";

/**
 * The subset of causes that attach to a single operation (everything except the
 * two whole-batch access blockers). Derived from `RecoveryCause`, so it stays in
 * lock-step: a conflicted operation always carries one of these.
 */
export type OperationConflictCause = Exclude<
	RecoveryCause,
	"grant_unavailable" | "undo_unavailable"
>;

/**
 * The outcome one operation ended in, in the renderer's path-free vocabulary.
 * The completed and pending tokens mirror the engine's item states (moved,
 * created, exists, reverted/restored, removed, remove_skipped, pending); the
 * conflicted tokens ARE the per-operation causes, so the conflict wording stays
 * consistent between an operation and its cause.
 */
export type OperationOutcome =
	// Completed — the step finished (some with an honest caveat).
	| "moved"
	| "folder_created"
	| "folder_existed"
	| "restored"
	| "restored_modified"
	| "folder_removed"
	| "folder_kept"
	// Pending — the step never ran, so nothing was done.
	| "pending"
	// Conflicted — the step was left untouched; one cause per outcome.
	| OperationConflictCause;

/** How the user should read an operation: done, never-ran, or left-for-you. */
export type OperationDisposition = "completed" | "pending" | "conflicted";

/** Visual/severity tone for the whole card. */
export type RecoveryTone = "positive" | "neutral" | "attention";

/**
 * One operation in a recovered batch, stripped to display-safe fields. `id` is an
 * opaque journal item id (e.g. "move_0"); `name` is a display name — NEVER a
 * filesystem path.
 */
export interface RecoveryOperationSummary {
	readonly id: string;
	readonly name: string;
	readonly kind: "file" | "folder";
	readonly outcome: OperationOutcome;
}

/**
 * A recovered batch, summarised for the renderer. Everything here is display-safe:
 * opaque ids and display names only, never a filesystem path. This is the shape a
 * future path-stripping IPC adapter would emit; until then the fixtures match it.
 */
export interface RecoveryBatchSummary {
	/** Opaque journal batch id (e.g. "batch_…"). Never a path. */
	readonly batchId: string;
	/** The location's display label (e.g. "Downloads"). Never a path. */
	readonly locationLabel: string;
	readonly state: RecoveryBatchState;
	readonly trigger: RecoveryTrigger;
	/** The batch-level reason — set when `state` is `needs_attention`. */
	readonly reason?: RecoveryBatchReason;
	readonly operations: readonly RecoveryOperationSummary[];
}

/** The user-comprehensible presentation of one recovery cause. */
export interface RecoveryCausePresentation {
	readonly cause: RecoveryCause;
	/** Short, plain-language title of what happened. */
	readonly headline: string;
	/** A plain-language explanation of the cause — honest, never alarming. */
	readonly explanation: string;
	/** At least one SAFE next action; never destructive, never a path. */
	readonly nextActions: readonly string[];
}

/** The presentation of a single operation within a recovered batch. */
export interface OperationPresentation {
	readonly id: string;
	readonly name: string;
	readonly kind: "file" | "folder";
	readonly disposition: OperationDisposition;
	/** Short status label (e.g. "Moved", "Put back", or the conflict headline). */
	readonly status: string;
	/** One honest line stating what happened to this operation. */
	readonly detail: string;
	/** The safe next action for a conflicted operation; absent otherwise. */
	readonly safeNextAction?: string;
	/** The conflict cause, when this operation is conflicted; absent otherwise. */
	readonly conflictCause?: OperationConflictCause;
}

/** The full presentation the recovery card renders. */
export interface RecoveryPresentation {
	readonly tone: RecoveryTone;
	readonly headline: string;
	readonly explanation: string;
	/** The honest safety guarantee, restated on every recovered batch. */
	readonly guarantee: string;
	readonly operations: readonly OperationPresentation[];
	readonly counts: {
		readonly completed: number;
		readonly pending: number;
		readonly conflicted: number;
	};
	/** Safe next actions appropriate to the batch's cause; always non-empty. */
	readonly nextActions: readonly string[];
}

/** Pluralize `count` against `noun` (naive "+s"; enough for the recovery copy). */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The user-comprehensible presentation for one needs_attention cause. The switch
 * is exhaustive and guarded by `assertNever`, so EVERY cause the engine can
 * produce is handled — adding a `RecoveryCause` without a branch here fails to
 * compile. Every branch returns a non-empty headline, a plain-language
 * explanation, and at least one safe next action.
 */
export function describeRecoveryCause(
	cause: RecoveryCause,
): RecoveryCausePresentation {
	switch (cause) {
		case "grant_unavailable":
			return {
				cause,
				headline: "Untie can't reach that folder",
				explanation:
					"The sort was interrupted, and Untie no longer has permission to open the folder it was working in — so it paused instead of guessing. Nothing was moved while access is unavailable.",
				nextActions: [
					"Reconnect the folder so Untie can finish checking this sort.",
					"Leave everything as it is for now — nothing has been changed.",
				],
			};
		case "undo_unavailable":
			return {
				cause,
				headline: "Untie can't reach that folder to undo",
				explanation:
					"The undo was interrupted, and Untie no longer has permission to open the folder — so it stopped rather than guess. Nothing was put back or changed while access is unavailable.",
				nextActions: [
					"Reconnect the folder, then try the undo again.",
					"Leave everything as it is for now — nothing has been changed.",
				],
			};
		case "in_doubt_conflict":
			return {
				cause,
				headline: "One move couldn't be confirmed",
				explanation:
					"The sort stopped partway through this move, and Untie couldn't tell for certain where the item ended up — so it left it untouched rather than risk the wrong thing.",
				nextActions: [
					"Reveal the item to see where it is now.",
					"Re-run the sort once you've checked it.",
					"Leave it as it is — nothing was renamed, overwritten, or deleted.",
				],
			};
		case "destination_changed":
			return {
				cause,
				headline: "A destination folder changed",
				explanation:
					"The folder this item was headed for isn't the one Untie prepared — it was renamed, replaced, or removed after the sort began — so Untie left the item where it is.",
				nextActions: [
					"Re-run the sort to build a fresh plan for the current folders.",
					"Reveal the item to see where it is now.",
					"Leave it as it is.",
				],
			};
		case "origin_occupied":
			return {
				cause,
				headline: "The original spot is taken",
				explanation:
					"Untie went to put this item back where it started, but something else is sitting there now — so it left the item in place instead of overwriting anything.",
				nextActions: [
					"Reveal the item to compare it with what's in its original spot.",
					"Leave it as it is — nothing was overwritten.",
				],
			};
		case "source_missing":
			return {
				cause,
				headline: "The item was already moved",
				explanation:
					"This item is no longer where Untie left it — it looks like it was already moved somewhere else — so there was nothing to put back and nothing was changed.",
				nextActions: [
					"Reveal the item to confirm where it is now.",
					"Leave it as it is — nothing was changed.",
				],
			};
		case "destination_replaced":
			return {
				cause,
				headline: "The moved item was replaced",
				explanation:
					"The item Untie moved has since been swapped for a different one, so Untie couldn't safely put the original back — it left everything exactly as it found it.",
				nextActions: [
					"Reveal the item to see what's there now.",
					"Leave it as it is — nothing was overwritten or deleted.",
				],
			};
		case "filesystem_error":
			return {
				cause,
				headline: "The system stopped Untie partway",
				explanation:
					"The operating system reported an unexpected problem while Untie was finishing this item, so Untie stopped and left it untouched rather than continue in doubt.",
				nextActions: [
					"Try the sort again in a moment.",
					"Reveal the item to check on it.",
					"Leave it as it is — nothing was renamed, overwritten, or deleted.",
				],
			};
		default:
			return assertNever(cause);
	}
}

/**
 * Which of the three dispositions an outcome falls into. Exhaustive and guarded
 * by `assertNever`, so a new outcome must declare how it should be read.
 */
export function operationDisposition(
	outcome: OperationOutcome,
): OperationDisposition {
	switch (outcome) {
		case "moved":
		case "folder_created":
		case "folder_existed":
		case "restored":
		case "restored_modified":
		case "folder_removed":
		case "folder_kept":
			return "completed";
		case "pending":
			return "pending";
		case "in_doubt_conflict":
		case "destination_changed":
		case "origin_occupied":
		case "source_missing":
		case "destination_replaced":
		case "filesystem_error":
			return "conflicted";
		default:
			return assertNever(outcome);
	}
}

/** Build a conflicted operation's presentation from its cause. */
function conflictedOperation(
	base: Pick<OperationPresentation, "id" | "name" | "kind" | "disposition">,
	cause: OperationConflictCause,
): OperationPresentation {
	const described = describeRecoveryCause(cause);
	return {
		...base,
		status: described.headline,
		detail: described.explanation,
		safeNextAction: described.nextActions[0],
		conflictCause: cause,
	};
}

/**
 * The presentation of one operation: its disposition, a short status, an honest
 * one-line detail, and — for a conflict — the safe next action. The switch is
 * exhaustive and guarded by `assertNever`, so every outcome is worded explicitly
 * using the engine's own vocabulary. Display names only; no path is ever built.
 */
export function describeOperation(
	operation: RecoveryOperationSummary,
): OperationPresentation {
	const base = {
		id: operation.id,
		name: operation.name,
		kind: operation.kind,
		disposition: operationDisposition(operation.outcome),
	} as const;
	switch (operation.outcome) {
		case "moved":
			return {
				...base,
				status: "Moved",
				detail: "Moved into place as planned.",
			};
		case "folder_created":
			return { ...base, status: "Created", detail: "Created for this sort." };
		case "folder_existed":
			return {
				...base,
				status: "Already there",
				detail: "Was already there and left as it is.",
			};
		case "restored":
			return {
				...base,
				status: "Put back",
				detail: "Put back where it started.",
			};
		case "restored_modified":
			return {
				...base,
				status: "Put back",
				detail:
					"Put back where it started. It had changed since the sort, so your latest version was kept.",
			};
		case "folder_removed":
			return {
				...base,
				status: "Removed",
				detail: "This empty folder Untie added was removed.",
			};
		case "folder_kept":
			return {
				...base,
				status: "Kept",
				detail: "Left in place — it wasn't empty, or Untie didn't create it.",
			};
		case "pending":
			return {
				...base,
				status: "Not started",
				detail:
					"Hadn't started when the sort was interrupted, so nothing was done.",
			};
		case "in_doubt_conflict":
		case "destination_changed":
		case "origin_occupied":
		case "source_missing":
		case "destination_replaced":
		case "filesystem_error":
			return conflictedOperation(base, operation.outcome);
		default:
			return assertNever(operation.outcome);
	}
}

/** The batch-level headline, explanation, tone, and safe next actions. */
interface BatchNarrative {
	readonly tone: RecoveryTone;
	readonly headline: string;
	readonly explanation: string;
	readonly nextActions: readonly string[];
}

/** The narrative for a needs_attention batch driven by per-operation conflicts. */
function conflictNarrative(
	operations: readonly OperationPresentation[],
): BatchNarrative {
	const conflicted = operations.filter(
		(operation) => operation.disposition === "conflicted",
	);
	const completedCount = operations.filter(
		(operation) => operation.disposition === "completed",
	).length;
	const count = conflicted.length;

	// Gather the distinct safe actions across the conflict causes that are present,
	// in first-seen order, so the batch offers exactly the actions its causes call
	// for — derived from the causes, never hardcoded.
	const seen = new Set<OperationConflictCause>();
	const nextActions: string[] = [];
	for (const operation of conflicted) {
		if (!operation.conflictCause || seen.has(operation.conflictCause)) continue;
		seen.add(operation.conflictCause);
		for (const action of describeRecoveryCause(operation.conflictCause)
			.nextActions) {
			if (!nextActions.includes(action)) nextActions.push(action);
		}
	}
	if (nextActions.length === 0) {
		nextActions.push(
			"Leave everything as it is — nothing was renamed, overwritten, or deleted.",
		);
	}

	const finished =
		completedCount > 0
			? `It finished ${plural(completedCount, "step")}, but `
			: "";
	const explanation =
		count === 0
			? "Untie recovered this sort after it was interrupted and left everything exactly where it is."
			: `Untie recovered this sort after it was interrupted. ${finished}${plural(
					count,
					"item",
				)} couldn't be completed safely, so ${
					count === 1 ? "it was" : "they were"
				} left exactly where ${count === 1 ? "it is" : "they are"} for you to check.`;

	return {
		tone: "attention",
		headline:
			count === 1
				? "One item needs your attention"
				: "A few items need your attention",
		explanation,
		nextActions,
	};
}

/** The narrative for a needs_attention batch, by its batch-level reason. */
function needsAttentionNarrative(
	reason: RecoveryBatchReason,
	operations: readonly OperationPresentation[],
): BatchNarrative {
	switch (reason) {
		case "grant_unavailable": {
			const cause = describeRecoveryCause("grant_unavailable");
			return {
				tone: "attention",
				headline: cause.headline,
				explanation: cause.explanation,
				nextActions: cause.nextActions,
			};
		}
		case "unavailable": {
			const cause = describeRecoveryCause("undo_unavailable");
			return {
				tone: "attention",
				headline: cause.headline,
				explanation: cause.explanation,
				nextActions: cause.nextActions,
			};
		}
		case "revert_conflict":
			return conflictNarrative(operations);
		default:
			return assertNever(reason);
	}
}

/** The batch-level narrative for any recovered batch. Exhaustive by state. */
function batchNarrative(
	summary: RecoveryBatchSummary,
	operations: readonly OperationPresentation[],
): BatchNarrative {
	switch (summary.state) {
		case "recovered":
			return {
				tone: "positive",
				headline: "Untie finished this sort after a restart",
				explanation:
					"This sort was interrupted, and Untie safely completed it when the app reopened. Every step finished.",
				nextActions: [
					"Undo this sort if it isn't what you wanted.",
					"Otherwise there's nothing you need to do.",
				],
			};
		case "rolled_back":
			return {
				tone: "neutral",
				headline: "Untie safely undid an interrupted sort",
				explanation:
					"This sort was interrupted, so Untie put everything back the way it was before it started. Nothing was left half-done.",
				nextActions: [
					"Re-run the sort whenever you're ready.",
					"Otherwise there's nothing you need to do.",
				],
			};
		case "needs_attention":
			// A needs_attention batch always has a cause; default to the conflict
			// reason when none was recorded, so per-operation causes still drive it.
			return needsAttentionNarrative(
				summary.reason ?? "revert_conflict",
				operations,
			);
		default:
			return assertNever(summary.state);
	}
}

/**
 * The full presentation for a recovered batch: a headline, a plain-language
 * explanation of the cause, every operation classified and worded, the counts,
 * the honest guarantee, and the safe next actions. All strings are display-safe
 * — no filesystem path is ever built here.
 */
export function recoveryPresentation(
	summary: RecoveryBatchSummary,
): RecoveryPresentation {
	const operations = summary.operations.map(describeOperation);
	const counts = {
		completed: operations.filter((o) => o.disposition === "completed").length,
		pending: operations.filter((o) => o.disposition === "pending").length,
		conflicted: operations.filter((o) => o.disposition === "conflicted").length,
	};
	const narrative = batchNarrative(summary, operations);
	return {
		tone: narrative.tone,
		headline: narrative.headline,
		explanation: narrative.explanation,
		guarantee: RECOVERY_SAFETY_GUARANTEE,
		operations,
		counts,
		nextActions: narrative.nextActions,
	};
}

/** Whether this recovered batch is asking the user to do something. */
export function recoveryNeedsAttention(summary: RecoveryBatchSummary): boolean {
	return summary.state === "needs_attention";
}

/**
 * A short, path-free accessible label for a recovered batch card, used for the
 * screen-reader announcement (mirrors `messageAccessibleLabel`).
 */
export function recoveryAccessibleLabel(summary: RecoveryBatchSummary): string {
	const presentation = recoveryPresentation(summary);
	const { completed, pending, conflicted } = presentation.counts;
	return `${presentation.headline} in ${summary.locationLabel}. ${completed} completed, ${pending} not started, ${conflicted} need attention.`;
}

/**
 * Every needs_attention cause, derived from a `satisfies Record<RecoveryCause, …>`
 * map so the list can never drift from the union: adding or removing a cause is a
 * compile error here. Iterated by the tests to prove each cause has a
 * user-comprehensible presentation.
 */
export const RECOVERY_CAUSES: readonly RecoveryCause[] = Object.keys({
	grant_unavailable: true,
	undo_unavailable: true,
	in_doubt_conflict: true,
	destination_changed: true,
	origin_occupied: true,
	source_missing: true,
	destination_replaced: true,
	filesystem_error: true,
} satisfies Record<RecoveryCause, true>) as RecoveryCause[];

/**
 * Every operation outcome, derived the same exhaustive way as `RECOVERY_CAUSES`.
 * Iterated by the tests to prove each outcome classifies and words correctly.
 */
export const RECOVERY_OPERATION_OUTCOMES: readonly OperationOutcome[] =
	Object.keys({
		moved: true,
		folder_created: true,
		folder_existed: true,
		restored: true,
		restored_modified: true,
		folder_removed: true,
		folder_kept: true,
		pending: true,
		in_doubt_conflict: true,
		destination_changed: true,
		origin_occupied: true,
		source_missing: true,
		destination_replaced: true,
		filesystem_error: true,
	} satisfies Record<OperationOutcome, true>) as OperationOutcome[];
