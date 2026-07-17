// Apply progress derived from journal state (S7).
//
// When the user approves a plan, the apply engine (W14) moves files one
// operation at a time and journals each transition. This module is the pure
// model that mirrors that journal in the renderer: an in-flight apply is a
// single `ApplyJournalState` value — the SINGLE SOURCE OF TRUTH — and every
// number the transcript shows (the live progress and the final summary) is
// DERIVED from it, so the displayed progress can never disagree with what the
// journal recorded.
//
// Durability rides on this: the journal state is embedded in the in-flight
// `ProgressMessage` (`ProgressMessage.apply`), so it persists with the
// transcript (P2). A mid-apply renderer reload re-seeds the pane from that
// message and `findInFlightApply` recovers the exact journal state to resume —
// the progress is rebuilt, never reset or lost.
//
// It is path-free by construction: an operation records only a destination
// folder DISPLAY NAME and a file DISPLAY NAME (PRD §8 — filenames are
// sensitive, filesystem paths never enter the renderer). The pure functions let
// the whole lifecycle be asserted without React, and let the real journal IPC
// (W14) replace the mock engine without changing this model.

import type {
	ChatMessage,
	PlanFolder,
	ProgressMessage,
	ResultMessage,
} from "./message-model";

/** The v1 safety guarantee restated on every completed apply (PRD §8). */
export const APPLY_SAFETY_GUARANTEE =
	"Nothing was renamed, overwritten, or deleted.";

/** Per-operation durable status within an apply, mirroring the journal (R4). */
export type ApplyOperationStatus = "pending" | "done" | "failed";

/**
 * One journaled file-move operation. Display names only — a destination folder
 * name and a file name — never a filesystem path.
 */
export interface ApplyOperationRecord {
	/** Human-readable destination folder name (never a filesystem path). */
	readonly destination: string;
	/** Human-readable file display name (never a filesystem path). */
	readonly file: string;
	/** Whether applying this move would create its destination folder. */
	readonly isNewFolder: boolean;
	/** Durable per-operation status; advances pending → done (or failed). */
	readonly status: ApplyOperationStatus;
}

/** Overall durable lifecycle of an apply, mirroring the journal's states (R4). */
export type ApplyStatus = "applying" | "done" | "failed";

/**
 * The durable journal state of one apply — the single source of truth the live
 * progress and the final summary both derive from. Persisted inside the
 * in-flight `ProgressMessage` so a mid-apply reload can rebuild and resume it.
 */
export interface ApplyJournalState {
	/** Opaque operation id from the apply engine (W14's `applyPlan`) — no path. */
	readonly operationId: string;
	/** Location label for the summary copy (e.g. "Downloads"). Display only. */
	readonly locationLabel: string;
	/** The ordered per-operation records; `operations.length` is the total. */
	readonly operations: readonly ApplyOperationRecord[];
	/** Overall status, derived from the operation records so it can't drift. */
	readonly status: ApplyStatus;
}

/** Live progress derived from a journal state — every field comes from it. */
export interface ApplyProgress {
	/** Operations the journal has recorded as moved. */
	readonly completed: number;
	/** Total operations in the apply. */
	readonly total: number;
	/** A human, path-free "current" label for the operation in flight. */
	readonly current: string;
	/** The overall lifecycle status. */
	readonly status: ApplyStatus;
}

/** Pluralize `count` against `noun` (naive "+s"; enough for the apply copy). */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Derive the overall status from the operation records (never stored raw). */
function deriveApplyStatus(
	operations: readonly ApplyOperationRecord[],
): ApplyStatus {
	if (operations.some((operation) => operation.status === "pending")) {
		return "applying";
	}
	if (operations.some((operation) => operation.status === "failed")) {
		return "failed";
	}
	return "done";
}

/**
 * The initial journal state for applying `folders`: one pending operation per
 * move, in the plan's own order. Display names are copied straight from the
 * plan snapshot (which is already path-free), so no path can enter here.
 */
export function buildApplyJournalState(input: {
	operationId: string;
	locationLabel: string;
	folders: readonly PlanFolder[];
}): ApplyJournalState {
	const { operationId, locationLabel, folders } = input;
	const operations: ApplyOperationRecord[] = [];
	for (const folder of folders) {
		for (const file of folder.files) {
			operations.push({
				destination: folder.name,
				file,
				isNewFolder: folder.isNew,
				status: "pending",
			});
		}
	}
	return {
		operationId,
		locationLabel,
		operations,
		status: deriveApplyStatus(operations),
	};
}

/**
 * The live progress for a journal state. The completed count and total are
 * counted from the records, and the "current" label names the operation now in
 * flight (the next pending move) — so the progress can never disagree with the
 * journal. Display names only.
 */
export function deriveApplyProgress(state: ApplyJournalState): ApplyProgress {
	const total = state.operations.length;
	const completed = state.operations.reduce(
		(count, operation) => count + (operation.status === "done" ? 1 : 0),
		0,
	);
	const inFlight = state.operations.find(
		(operation) => operation.status === "pending",
	);
	const current = inFlight
		? `Moving ${inFlight.file} into ${inFlight.destination}`
		: `Moved ${plural(completed, "file")}`;
	return { completed, total, current, status: state.status };
}

/**
 * Apply one operation-completed event: mark the next pending operation `done`
 * and recompute the overall status. Pure — it returns a new state, so the same
 * event applied to the same journal always advances it identically. When no
 * operation is pending the state is returned unchanged.
 */
export function applyOperationCompleted(
	state: ApplyJournalState,
): ApplyJournalState {
	const index = state.operations.findIndex(
		(operation) => operation.status === "pending",
	);
	if (index === -1) return state;
	const operations = state.operations.map((operation, i) =>
		i === index ? { ...operation, status: "done" as const } : operation,
	);
	return { ...state, operations, status: deriveApplyStatus(operations) };
}

/**
 * A `ProgressMessage` for an in-flight apply, with `label`/`current`/`total`
 * DERIVED from the journal state and the state itself embedded as `apply` so it
 * persists and can be recovered on reload. Nothing is hand-set, so the card can
 * never disagree with the journal.
 */
export function applyProgressMessage(
	state: ApplyJournalState,
	meta: { id: string; createdAt: number },
): ProgressMessage {
	const progress = deriveApplyProgress(state);
	return {
		kind: "progress",
		id: meta.id,
		createdAt: meta.createdAt,
		label: progress.current,
		current: progress.completed,
		total: progress.total,
		apply: state,
	};
}

/**
 * The final `ResultMessage` for a completed apply, with every count derived
 * from the journal's `done` operations so the summary can never claim a move or
 * a folder the journal didn't record. Restates the v1 safety guarantee.
 */
export function buildApplyResult(
	state: ApplyJournalState,
	meta: { id: string; createdAt: number },
): ResultMessage {
	const done = state.operations.filter(
		(operation) => operation.status === "done",
	);
	const movedCount = done.length;
	const destinations = new Set(done.map((operation) => operation.destination));
	const createdDestinations = new Set(
		done
			.filter((operation) => operation.isNewFolder)
			.map((operation) => operation.destination),
	);
	const folderCount = destinations.size;
	const createdFolderCount = createdDestinations.size;
	return {
		kind: "result",
		id: meta.id,
		createdAt: meta.createdAt,
		summary: `Moved ${plural(movedCount, "file")} into ${plural(
			folderCount,
			"folder",
		)} in ${state.locationLabel}. ${APPLY_SAFETY_GUARANTEE}`,
		movedCount,
		folderCount,
		createdFolderCount,
	};
}

/** A progress message that still carries an in-flight apply journal state. */
export type InFlightApplyMessage = ProgressMessage & {
	readonly apply: ApplyJournalState;
};

/** Whether `message` is a progress card tracking an apply that is still running. */
export function isInFlightApplyMessage(
	message: ChatMessage,
): message is InFlightApplyMessage {
	return message.kind === "progress" && message.apply?.status === "applying";
}

/**
 * The apply that was in flight when the transcript was persisted, if any. A
 * fresh mount calls this against its seeded messages to recover and resume the
 * journal state — this is the seam durability rides on.
 */
export function findInFlightApply(
	messages: readonly ChatMessage[],
): InFlightApplyMessage | undefined {
	return messages.find(isInFlightApplyMessage);
}
