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
	/** How many files the plan routes into this folder. */
	readonly fileCount: number;
	/** True when Untie would create the folder; false for an existing one. */
	readonly isNew: boolean;
	/** A few representative filenames, shown before the full list expands. */
	readonly examples: readonly string[];
}

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

/** A reviewable sort plan (summary → grouped destinations). */
export interface PlanMessage extends BaseMessage {
	readonly kind: "plan";
	readonly summary: string;
	readonly fileCount: number;
	readonly folderCount: number;
	readonly createdFolderCount: number;
	readonly folders: readonly PlanFolder[];
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
		case "plan":
			return `Sort plan: ${message.summary}`;
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
