// Undo outcome presentation, derived from the journaled undo engine (S10).
//
// The main-process undo engine (electron/journaled-apply.cjs) replays a sort's
// write-ahead journal in reverse and returns an HONEST, per-item result: a
// batch-level verdict ("complete" | "partial" | "unavailable"), a per-file
// outcome for every move it tried to reverse, and a per-folder outcome for every
// folder the sort created. This module is the pure renderer model that turns
// that engine-shaped result into what the transcript shows — a headline, an
// honest summary, and a restored-vs-left-in-place breakdown — WITHOUT ever
// claiming a guarantee the engine did not actually make.
//
// Two invariants keep the UI honest:
//   1. Every count the card shows (restored / left in place / folders removed)
//      is DERIVED from the outcome data, so the summary can never disagree with,
//      or over-claim on, what the engine really did.
//   2. Every outcome the engine can return maps — through an assertNever-guarded
//      switch — to an explicit presentation, so a new engine outcome is a
//      compile error here until it is given honest wording.
//
// It is path-free by construction: a file result carries only an opaque engine
// `itemId` and a DISPLAY NAME, a folder result only an opaque `folderId` and a
// display name — never a filesystem path (PRD §8: filenames are sensitive, paths
// never enter the renderer). The real undo capability IPC (W14) returns the same
// engine shape, so it can replace the mock feeding this model without changing
// a line of the presentation.

import { assertNever } from "./message-model";

// ── Engine vocabulary ────────────────────────────────────────────────────────
// These unions mirror, exactly, what electron/journaled-apply.cjs `undo` can
// return. Keeping them as string-literal unions is what makes the presentation
// switches below exhaustive: extend the engine and TypeScript forces a decision
// here rather than letting an unhandled outcome render as blank.

/** Batch-level verdict for one undo attempt. */
export type UndoBatchOutcome = "complete" | "partial" | "unavailable";

/** Per-file outcome the engine records for a move it tried to reverse. */
export type UndoFileOutcome =
	| "restored"
	| "restored_modified"
	| "already_moved_away"
	| "conflict";

/** Why a `conflict` file was left where it is (the engine's `reason`). */
export type UndoConflictReason =
	| "origin_occupied"
	| "destination_changed"
	| "destination_replaced"
	| "filesystem_error";

/** Every `reason` the engine can attach to a per-file outcome. */
export type UndoFileReason =
	| UndoConflictReason
	| "modified_since_move"
	| "source_missing";

/** Per-folder outcome the engine records for a folder the sort created. */
export type UndoFolderOutcome =
	| "removed"
	| "pre_existing"
	| "non_empty"
	| "unavailable";

/**
 * The journal batch lifecycle states. Only an `applied` batch may be undone —
 * the engine rejects anything else — which is the duplicate-undo guard mirrored
 * by {@link isBatchUndoable}.
 */
export type UndoBatchState =
	| "prepared"
	| "applying"
	| "applied"
	| "rolling_back"
	| "rolled_back"
	| "needs_attention";

// ── Engine-shaped result (opaque ids) ────────────────────────────────────────
// The raw result exactly as the engine returns it: opaque ids only, NO display
// names. `buildUndoResult` is the single seam that resolves those ids to display
// names, so the mock and the real IPC feed the presentation identically.

/** One reversed-move result as the engine returns it (opaque `itemId`). */
export interface UndoEngineFileResult {
	readonly itemId: string;
	readonly outcome: UndoFileOutcome;
	readonly reason?: UndoFileReason;
}

/** One created-folder result as the engine returns it (opaque `folderId`). */
export interface UndoEngineFolderResult {
	readonly folderId: string;
	readonly outcome: UndoFolderOutcome;
}

/** The full undo result exactly as the engine returns it. */
export interface UndoEngineResult {
	readonly batchId: string;
	readonly state: UndoBatchState;
	readonly outcome: UndoBatchOutcome;
	readonly files: readonly UndoEngineFileResult[];
	readonly folders: readonly UndoEngineFolderResult[];
}

// ── Enriched result (display names) ───────────────────────────────────────────
// What the transcript carries and the card renders: the same outcomes, now with
// a display name resolved for each opaque id. Still path-free — a `name` is a
// filename or folder name only.

/** A reversed-move result with its file display name resolved (never a path). */
export interface UndoFileResult {
	/** Opaque engine item id — never a path. */
	readonly itemId: string;
	/** File display name — never a filesystem path. */
	readonly name: string;
	readonly outcome: UndoFileOutcome;
	readonly reason?: UndoFileReason;
}

/** A created-folder result with its folder display name resolved (never a path). */
export interface UndoFolderResult {
	/** Opaque engine folder id — never a path. */
	readonly folderId: string;
	/** Folder display name — never a filesystem path. */
	readonly name: string;
	readonly outcome: UndoFolderOutcome;
}

/** The presentation-ready undo result the card renders (display names only). */
export interface UndoResult {
	readonly outcome: UndoBatchOutcome;
	readonly files: readonly UndoFileResult[];
	readonly folders: readonly UndoFolderResult[];
}

/** Resolves the engine's opaque ids to display names — never a path. */
export interface UndoNameResolver {
	/** Display name for a move's opaque `itemId`. */
	readonly fileName: (itemId: string) => string;
	/** Display name for a created folder's opaque `folderId`. */
	readonly folderName: (folderId: string) => string;
}

/**
 * Resolve an engine-shaped undo result to the display-named result the renderer
 * carries. This is the ONLY place opaque ids become display names, so swapping
 * the mock for the real undo IPC is a matter of feeding this the real result and
 * the renderer's own id → name map — the presentation below never changes.
 */
export function buildUndoResult(
	engine: UndoEngineResult,
	resolve: UndoNameResolver,
): UndoResult {
	return {
		outcome: engine.outcome,
		files: engine.files.map((file) => ({
			itemId: file.itemId,
			name: resolve.fileName(file.itemId),
			outcome: file.outcome,
			...(file.reason ? { reason: file.reason } : {}),
		})),
		folders: engine.folders.map((folder) => ({
			folderId: folder.folderId,
			name: resolve.folderName(folder.folderId),
			outcome: folder.outcome,
		})),
	};
}

// ── Derived counts ────────────────────────────────────────────────────────────

/** Pluralize `count` against `noun` (naive "+s"; enough for the undo copy). */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Whether a per-file outcome means the file is back where it started, or was
 * left where it is. Exhaustive so a new outcome must declare which side it falls
 * on before it can be counted — the split the whole summary is derived from.
 */
export function undoFileStatus(outcome: UndoFileOutcome): "restored" | "left" {
	switch (outcome) {
		case "restored":
		case "restored_modified":
			return "restored";
		case "already_moved_away":
		case "conflict":
			return "left";
		default:
			return assertNever(outcome);
	}
}

/** How many files the engine put back (restored or restored-with-your-edits). */
export function undoRestoredCount(files: readonly UndoFileResult[]): number {
	return files.reduce(
		(count, file) =>
			count + (undoFileStatus(file.outcome) === "restored" ? 1 : 0),
		0,
	);
}

/** How many files the engine left exactly where they are (nothing forced back). */
export function undoLeftInPlaceCount(files: readonly UndoFileResult[]): number {
	return files.reduce(
		(count, file) => count + (undoFileStatus(file.outcome) === "left" ? 1 : 0),
		0,
	);
}

/** How many empty folders the sort created that the engine removed on undo. */
export function undoRemovedFolderCount(
	folders: readonly UndoFolderResult[],
): number {
	return folders.reduce(
		(count, folder) => count + (folder.outcome === "removed" ? 1 : 0),
		0,
	);
}

// ── Per-file presentation ─────────────────────────────────────────────────────

/** The honest, path-free presentation of one file's undo outcome. */
export interface UndoFileLine {
	readonly itemId: string;
	readonly name: string;
	/** Restored to its origin, or left where it is now. */
	readonly status: "restored" | "left";
	/** A one-line, honest account of what happened to this file. */
	readonly explanation: string;
	/** A safe next step for a file left in place — never destructive, never a path. */
	readonly nextAction?: string;
}

/**
 * The engine only attaches a conflict reason to a `conflict` outcome; any other
 * reason belongs to a different outcome. Narrow to the conflict reasons, folding
 * the (unreachable in practice) leftovers into the most conservative, generic
 * conflict so the copy stays honest rather than guessing.
 */
function toConflictReason(
	reason: UndoFileReason | undefined,
): UndoConflictReason {
	switch (reason) {
		case "origin_occupied":
		case "destination_changed":
		case "destination_replaced":
		case "filesystem_error":
			return reason;
		case "modified_since_move":
		case "source_missing":
		case undefined:
			return "filesystem_error";
		default:
			return assertNever(reason);
	}
}

/** Honest explanation + safe next step for each way a move can be left in place. */
function conflictLine(reason: UndoConflictReason): {
	explanation: string;
	nextAction: string;
} {
	switch (reason) {
		case "origin_occupied":
			return {
				explanation:
					"Left in place — another file now sits where this one came from, and Untie never overwrites.",
				nextAction:
					"It is safe in the folder the sort moved it to. Free up its original spot, then move it back yourself.",
			};
		case "destination_changed":
			return {
				explanation:
					"Left in place — the folder the sort moved it into is gone, so Untie could not find it to move back.",
				nextAction:
					"Nothing was deleted. Search for it by name to see where it is now.",
			};
		case "destination_replaced":
			return {
				explanation:
					"Left in place — the file at that spot was replaced since the sort, so it is no longer the one Untie moved.",
				nextAction:
					"Both files were left untouched. Open that folder to move the one you want back yourself.",
			};
		case "filesystem_error":
			return {
				explanation:
					"Left in place — a system error stopped Untie from moving it back.",
				nextAction:
					"It is safe where the sort left it, and nothing about it was changed.",
			};
		default:
			return assertNever(reason);
	}
}

/**
 * The honest one-line presentation of a single file's undo outcome, plus a safe
 * next step when it was left in place. Exhaustive over every per-file outcome
 * (and, for a conflict, every conflict reason) so a new engine outcome cannot
 * ship without wording.
 */
export function undoFileLine(file: UndoFileResult): UndoFileLine {
	const base = { itemId: file.itemId, name: file.name };
	switch (file.outcome) {
		case "restored":
			return {
				...base,
				status: "restored",
				explanation: "Restored to its original location.",
			};
		case "restored_modified":
			return {
				...base,
				status: "restored",
				explanation:
					"Restored to its original location — you had changed it since the sort, so your newer version is back in place.",
			};
		case "already_moved_away":
			return {
				...base,
				status: "left",
				explanation:
					"Left as it is — you had already moved it out of the sort yourself, so there was nothing to move back.",
			};
		case "conflict": {
			const conflict = conflictLine(toConflictReason(file.reason));
			return {
				...base,
				status: "left",
				explanation: conflict.explanation,
				nextAction: conflict.nextAction,
			};
		}
		default:
			return assertNever(file.outcome);
	}
}

// ── Per-folder presentation ───────────────────────────────────────────────────

/** The honest, path-free presentation of one created-folder's undo outcome. */
export interface UndoFolderLine {
	readonly folderId: string;
	readonly name: string;
	/** Removed (it was Untie's empty folder), or kept (something else claimed it). */
	readonly status: "removed" | "kept";
	readonly explanation: string;
}

/**
 * The honest one-line presentation of a single created folder's undo outcome.
 * Exhaustive over every folder outcome the engine can return.
 */
export function undoFolderLine(folder: UndoFolderResult): UndoFolderLine {
	const base = { folderId: folder.folderId, name: folder.name };
	switch (folder.outcome) {
		case "removed":
			return {
				...base,
				status: "removed",
				explanation: "Removed — Untie created this empty folder for the sort.",
			};
		case "pre_existing":
			return {
				...base,
				status: "kept",
				explanation: "Kept — this folder already existed before the sort.",
			};
		case "non_empty":
			return {
				...base,
				status: "kept",
				explanation:
					"Kept — you have added files here since the sort, so Untie left it in place.",
			};
		case "unavailable":
			return {
				...base,
				status: "kept",
				explanation: "Kept — Untie could not remove this folder.",
			};
		default:
			return assertNever(folder.outcome);
	}
}

// ── Batch presentation ────────────────────────────────────────────────────────

/** The v1 undo safety guarantee, restated (honestly) on every undo outcome. */
export const UNDO_SAFETY_GUARANTEE =
	"Nothing was renamed, overwritten, or deleted.";

/** The visual tone that matches how well the undo went. */
export type UndoTone = "success" | "warning" | "danger";

/** The whole-card presentation for one undo outcome, with counts derived from it. */
export interface UndoPresentation {
	readonly outcome: UndoBatchOutcome;
	readonly tone: UndoTone;
	/** Card title. */
	readonly title: string;
	/** Screen-reader headline (also the card's accessible label). */
	readonly headline: string;
	/** The honest human summary of what the undo did. */
	readonly summary: string;
	/** The honest safety guarantee for THIS outcome (never over-claims). */
	readonly guarantee: string;
	readonly restoredCount: number;
	readonly leftInPlaceCount: number;
	readonly removedFolderCount: number;
}

/**
 * The whole-card presentation for one undo result. COMPLETE, PARTIAL, and
 * UNAVAILABLE each get a distinct, honest headline and summary through an
 * exhaustive switch, and every count is derived from the result's own data so
 * the words and the numbers can never disagree.
 */
export function undoPresentation(result: UndoResult): UndoPresentation {
	const restoredCount = undoRestoredCount(result.files);
	const leftInPlaceCount = undoLeftInPlaceCount(result.files);
	const removedFolderCount = undoRemovedFolderCount(result.folders);
	const counts = { restoredCount, leftInPlaceCount, removedFolderCount };

	switch (result.outcome) {
		case "complete": {
			const folderNote =
				removedFolderCount > 0
					? ` Removed ${plural(removedFolderCount, "empty folder")} Untie had created.`
					: "";
			return {
				outcome: "complete",
				tone: "success",
				title: "Sort undone",
				headline: `Undo complete: ${plural(restoredCount, "file")} restored.`,
				summary: `Restored ${plural(restoredCount, "file")} to ${
					restoredCount === 1
						? "its original location"
						: "their original locations"
				}.${folderNote}`,
				guarantee: UNDO_SAFETY_GUARANTEE,
				...counts,
			};
		}
		case "partial": {
			const total = restoredCount + leftInPlaceCount;
			return {
				outcome: "partial",
				tone: "warning",
				title: "Sort partly undone",
				headline: `Undo partly complete: restored ${restoredCount} of ${total} files.`,
				summary: `Restored ${plural(restoredCount, "file")}. ${plural(
					leftInPlaceCount,
					"file",
				)} ${leftInPlaceCount === 1 ? "was" : "were"} left exactly where ${
					leftInPlaceCount === 1 ? "it is" : "they are"
				} — see what happened to each below.`,
				guarantee: `${UNDO_SAFETY_GUARANTEE} A file Untie could not restore was left exactly where it is.`,
				...counts,
			};
		}
		case "unavailable":
			return {
				outcome: "unavailable",
				tone: "danger",
				title: "Couldn't undo this sort",
				headline: "Undo unavailable: nothing could be restored.",
				summary:
					"Untie could not undo this sort — the folder it needs is no longer available. Your files are exactly where the sort left them.",
				guarantee: `${UNDO_SAFETY_GUARANTEE} Every file was left exactly where it is.`,
				...counts,
			};
		default:
			return assertNever(result.outcome);
	}
}

// ── Duplicate-undo guard ──────────────────────────────────────────────────────

/**
 * Whether a batch can still be undone. The engine only reverses a batch whose
 * state is still `applied`; once undone (or attempted) it is `rolled_back` or
 * `needs_attention` and a second undo is rejected. The UI mirrors this so it can
 * never offer an undo the engine would refuse.
 */
export function isBatchUndoable(state: UndoBatchState): boolean {
	return state === "applied";
}

/** The reason the undo control is disabled once a sort has been undone. */
export const UNDO_ALREADY_DONE_REASON =
	"This sort has already been undone — there is nothing left to undo.";

/** How the undo control on a completed sort should render. */
export interface UndoControlPresentation {
	readonly label: string;
	readonly disabled: boolean;
	/** Why the control is disabled, or `null` when it is available. */
	readonly reason: string | null;
}

/**
 * The undo control for a completed sort, mirroring how the plan card disables
 * approval once a plan is approved: available while the sort is still undoable,
 * and a disabled, reason-bearing terminal state once it has been undone. This is
 * the UI half of the engine's duplicate-undo guard.
 */
export function undoControlPresentation(input: {
	readonly undone: boolean;
}): UndoControlPresentation {
	if (input.undone) {
		return {
			label: "Undone",
			disabled: true,
			reason: UNDO_ALREADY_DONE_REASON,
		};
	}
	return { label: "Undo this sort", disabled: false, reason: null };
}
