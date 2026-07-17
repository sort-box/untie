// Structured chat message model for the Untie chat shell (W12).
//
// The transcript is a list of `ChatMessage`s, a discriminated union keyed by
// `kind`. Each kind renders as its own card in `message-card.tsx`; a single
// exhaustive switch (guarded by `assertNever`) keeps the renderer and this
// model in lock-step, so adding a kind is a compile error until it is handled.
//
// The shape mirrors the PRD sort pipeline (§7.3): a request goes `pending` →
// `progress` → `plan`, an approval yields a `result`, and a `result` can be
// followed by an `undo`. `failed` is the terminal error state for any step.

/** A destination folder in a proposed sort plan. */
export interface PlanFolder {
	/** Human-readable destination folder name (never a filesystem path). */
	readonly name: string;
	/** True when Untie would create the folder; false for an existing one. */
	readonly isNew: boolean;
	/**
	 * The COMPLETE set of files the plan routes into this destination — display
	 * names only, never filesystem paths. Every move is reviewable (W13), so this
	 * is the full list, not a sample; the count derives from `files.length`.
	 */
	readonly files: readonly string[];
	/**
	 * The subset of `files` the model was LESS certain about routing here (S4). A
	 * clear, accessible flag surfaces these so the user can scrutinise the shakier
	 * moves before approving. Optional; absent means every move here is confident.
	 * Entries must be members of `files`.
	 */
	readonly lowConfidenceFiles?: readonly string[];
}

/**
 * Whether a plan can be approved.
 *
 * Only a `ready` plan may be approved. The others mirror the states the
 * production prepared-plan store (W11) can put a snapshot in: `stale` when the
 * bound snapshot became unusable (edit, expiry, grant change, or a source file
 * changed), `invalid` when the deterministic validator rejected the plan, and
 * `approved` once the user has committed to it (terminal; prevents re-approval).
 */
export type PlanStatus = "ready" | "stale" | "invalid" | "approved";

interface BaseMessage {
	/** Stable id; assistant status messages keep one id as they evolve. */
	readonly id: string;
	/** Wall-clock creation time (ms) — supplied so builders stay pure. */
	readonly createdAt: number;
}

/** A message the person typed into the composer. */
export interface UserMessage extends BaseMessage {
	readonly kind: "user";
	readonly text: string;
}

/** Work has been requested but not yet started (e.g. scanning the folder). */
export interface PendingMessage extends BaseMessage {
	readonly kind: "pending";
	readonly label: string;
}

/** Work is underway with determinate progress. */
export interface ProgressMessage extends BaseMessage {
	readonly kind: "progress";
	readonly label: string;
	readonly current: number;
	readonly total: number;
}

/** A reviewable sort plan (summary → grouped destinations → full move set). */
export interface PlanMessage extends BaseMessage {
	readonly kind: "plan";
	readonly summary: string;
	readonly fileCount: number;
	readonly folderCount: number;
	readonly createdFolderCount: number;
	readonly folders: readonly PlanFolder[];
	/** Approval gate: only a `ready` plan may be approved. */
	readonly status: PlanStatus;
	/**
	 * Optional human-readable reason a non-`ready` plan can't be approved. When
	 * absent, `planBlockReason` supplies a sensible default for the status.
	 */
	readonly statusReason?: string;
}

/** A completed sort, summarised for the transcript. */
export interface ResultMessage extends BaseMessage {
	readonly kind: "result";
	readonly summary: string;
	readonly movedCount: number;
	readonly folderCount: number;
	readonly createdFolderCount: number;
}

/** A completed undo of a prior sort. */
export interface UndoMessage extends BaseMessage {
	readonly kind: "undo";
	readonly summary: string;
	readonly restoredCount: number;
	readonly removedFolderCount: number;
}

/** A step that could not complete (quota, offline, timeout, cancellation…). */
export interface FailedMessage extends BaseMessage {
	readonly kind: "failed";
	readonly title: string;
	readonly detail: string;
	/** Whether re-running the request is a sensible next action. */
	readonly retryable: boolean;
}

export type ChatMessage =
	| UserMessage
	| PendingMessage
	| ProgressMessage
	| PlanMessage
	| ResultMessage
	| UndoMessage
	| FailedMessage;

export type MessageKind = ChatMessage["kind"];

/**
 * Compile-time exhaustiveness guard. Reaching it at runtime means a new message
 * kind was added without a matching branch in the caller's switch.
 */
export function assertNever(value: never): never {
	throw new Error(
		`Unhandled chat message kind: ${JSON.stringify(value satisfies never)}`,
	);
}

/**
 * A short, human-readable label for a message, used for screen-reader
 * announcements. The exhaustive switch ties every kind to a description.
 */
export function messageAccessibleLabel(message: ChatMessage): string {
	switch (message.kind) {
		case "user":
			return `You said: ${message.text}`;
		case "pending":
			return message.label;
		case "progress":
			return `${message.label} (${message.current} of ${message.total})`;
		case "plan": {
			const state =
				message.status === "stale"
					? " (out of date)"
					: message.status === "invalid"
						? " (needs attention)"
						: message.status === "approved"
							? " (approved)"
							: "";
			return `Sort plan${state}: ${message.summary}`;
		}
		case "result":
			return `Sort complete: ${message.summary}`;
		case "undo":
			return `Undo complete: ${message.summary}`;
		case "failed":
			return `Failed: ${message.title}. ${message.detail}`;
		default:
			return assertNever(message);
	}
}

/** Pluralize `noun` against `count` (naive "+s"; enough for the plan copy). */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Total number of file moves across every destination in a plan. */
export function planMoveCount(folders: readonly PlanFolder[]): number {
	return folders.reduce((total, folder) => total + folder.files.length, 0);
}

/** How many destinations the plan would create (new folders only). */
export function planCreatedFolderCount(folders: readonly PlanFolder[]): number {
	return folders.reduce((count, folder) => count + (folder.isNew ? 1 : 0), 0);
}

/** Whether `file` is one of the destination's low-confidence moves (S4). */
export function isLowConfidenceMove(folder: PlanFolder, file: string): boolean {
	return folder.lowConfidenceFiles?.includes(file) ?? false;
}

/**
 * A stable identifier for one proposed move — a single file within a specific
 * destination. The plan is an immutable snapshot for the lifetime of its card,
 * so positional `(folder, file)` indices are a safe, collision-free key even
 * when two destinations share a filename. Drives the S4 exclusion set.
 */
export function planMoveKey(folderIndex: number, fileIndex: number): string {
	return `${folderIndex}:${fileIndex}`;
}

/** Every move key for one destination — used to toggle a whole group at once. */
export function planGroupMoveKeys(
	folderIndex: number,
	folder: PlanFolder,
): string[] {
	return folder.files.map((_, fileIndex) =>
		planMoveKey(folderIndex, fileIndex),
	);
}

/**
 * The destinations that would actually be applied given an exclusion set (S4):
 * every excluded move (keyed by `planMoveKey`) is dropped, and any destination
 * left with no files disappears entirely. `lowConfidenceFiles` is trimmed to the
 * survivors. Deriving the review counts, the approval copy, and the approved
 * snapshot from this keeps them all in lock-step with what the user chose to keep.
 */
export function planFoldersExcluding(
	folders: readonly PlanFolder[],
	excluded: ReadonlySet<string>,
): PlanFolder[] {
	const kept: PlanFolder[] = [];
	folders.forEach((folder, folderIndex) => {
		const files = folder.files.filter(
			(_, fileIndex) => !excluded.has(planMoveKey(folderIndex, fileIndex)),
		);
		if (files.length === 0) return;
		if (folder.lowConfidenceFiles) {
			kept.push({
				...folder,
				files,
				lowConfidenceFiles: folder.lowConfidenceFiles.filter((name) =>
					files.includes(name),
				),
			});
		} else {
			kept.push({ ...folder, files });
		}
	});
	return kept;
}

/**
 * A copy of `message` bound to a new (post-exclusion) destination set, with the
 * denormalised counts recomputed so they can never disagree with the folders.
 * The model's human `summary` text is preserved. This is the exact snapshot that
 * gets approved and sent to apply, so an excluded file can never slip through.
 */
export function planWithFolders(
	message: PlanMessage,
	folders: readonly PlanFolder[],
): PlanMessage {
	return {
		...message,
		folders,
		fileCount: planMoveCount(folders),
		folderCount: folders.length,
		createdFolderCount: planCreatedFolderCount(folders),
	};
}

/** Only a `ready` plan may be approved. */
export function isPlanApprovable(status: PlanStatus): boolean {
	return status === "ready";
}

/**
 * The exact-counts approval line (PRD §8, S3). Counts are derived from the
 * plan's own move set — never hardcoded — so the copy can never disagree with
 * what would actually happen. It always restates the v1 safety guarantee.
 */
export function planApprovalCopy(folders: readonly PlanFolder[]): string {
	const moves = plural(planMoveCount(folders), "file");
	const created = planCreatedFolderCount(folders);
	const guarantee = "Nothing is renamed, overwritten, or deleted.";
	if (created === 0) {
		return `Move ${moves} into existing folders. ${guarantee}`;
	}
	return `Create ${plural(created, "folder")} and move ${moves}. ${guarantee}`;
}

/**
 * Why a plan can't be approved, or `null` when it is `ready`. Falls back to a
 * status-specific default when the message carries no explicit `statusReason`.
 */
export function planBlockReason(message: PlanMessage): string | null {
	switch (message.status) {
		case "ready":
			return null;
		case "stale":
			return (
				message.statusReason ??
				"This plan is out of date — the folder changed after it was prepared. Regenerate to review the current files."
			);
		case "invalid":
			return (
				message.statusReason ??
				"This plan didn't pass Untie's safety checks, so it can't be approved."
			);
		case "approved":
			return (
				message.statusReason ??
				"This plan has already been approved — there's nothing left to review."
			);
		default:
			return assertNever(message.status);
	}
}

/**
 * Insert `message` into `messages`, replacing any existing entry with the same
 * id. Assistant status messages evolve in place (pending → progress → plan) by
 * keeping their id; genuinely new messages are appended.
 */
export function upsertMessage(
	messages: readonly ChatMessage[],
	message: ChatMessage,
): ChatMessage[] {
	const index = messages.findIndex((existing) => existing.id === message.id);
	if (index === -1) return [...messages, message];
	const next = messages.slice();
	next[index] = message;
	return next;
}

let localIdCounter = 0;

/** Generate a locally-unique message id (client-side only). */
export function createMessageId(): string {
	const globalCrypto = globalThis.crypto;
	if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
		return globalCrypto.randomUUID();
	}
	localIdCounter += 1;
	return `msg_${Date.now().toString(36)}_${localIdCounter}`;
}
