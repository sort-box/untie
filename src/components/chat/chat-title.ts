// Renderer-side chat title + timestamp policy for the recent-chats list (P5).
//
// The persisted store (P2, `electron/chat-store.cjs`) is the source of truth for
// the title of a *saved* chat: it derives one from the first user message and
// falls back to `NEW_CHAT_TITLE` when a chat has no user text yet. This module
// mirrors that exact policy so the renderer can label a chat *before* it is
// persisted — a brand-new session shown in the pane header, or the live title of
// the chat currently being typed — without diverging from what the store writes.
// Keep the two in lock-step: any change here must match `deriveTitle` there.

import type { ChatMessage } from "./message-model";

/** Placeholder title for a chat with no user message yet. */
export const NEW_CHAT_TITLE = "New chat";

/** Longest title we render before eliding; matches the store's cap. */
const MAX_TITLE_LENGTH = 60;

function firstUserText(messages: readonly ChatMessage[]): string | undefined {
	for (const message of messages) {
		if (message.kind === "user") return message.text;
	}
	return undefined;
}

/**
 * Derive a chat's display title from its transcript, mirroring the P2 store:
 * the first user message (whitespace-collapsed, trimmed, elided at 60 chars) or
 * `NEW_CHAT_TITLE` when there is no user text.
 */
export function deriveChatTitle(messages: readonly ChatMessage[]): string {
	const text = firstUserText(messages);
	if (text === undefined) return NEW_CHAT_TITLE;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return NEW_CHAT_TITLE;
	return normalized.length > MAX_TITLE_LENGTH
		? `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}…`
		: normalized;
}

/**
 * Compact, human-readable "time since" label for a chat's last activity. Kept
 * deterministic (no locale-dependent buckets) so the recent-chats list reads
 * consistently; falls back to a short absolute date for older chats.
 */
export function formatRelativeTime(
	timestamp: number,
	now: number = Date.now(),
): string {
	const seconds = Math.round((now - timestamp) / 1000);
	if (!Number.isFinite(seconds) || seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	if (days < 7) return `${days} d ago`;
	const weeks = Math.floor(days / 7);
	if (weeks < 5) return `${weeks} w ago`;
	return new Date(timestamp).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}
