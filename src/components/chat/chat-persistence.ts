// Renderer-side client for local chat persistence (P2).
//
// The chat pane never touches the filesystem: it reads and writes sessions
// through the typed capability IPC surface exposed on `window.untie` by the
// Electron preload bridge. This module is the thin, guarded adapter over those
// capabilities. It is import-safe for the web/SSR bundle — the only electron
// reference is a type-only import (erased at build time), and the bridge is read
// lazily from the global scope, so when Untie runs outside Electron (dev:web,
// tests, SSR) every call degrades to an in-memory no-op instead of throwing.

import type {
	PersistedChatSession as CapabilityChatSession,
	CapabilityClient,
	CapabilityResult,
	ChatSessionSummary,
} from "../../../electron/capabilities/contracts.cjs";
import type { ChatMessage } from "./message-model";

export type { ChatSessionSummary } from "../../../electron/capabilities/contracts.cjs";

/** A chat session as the renderer works with it: fully-typed message union. */
export interface ChatSession {
	readonly id: string;
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly messages: readonly ChatMessage[];
}

/** The write payload: the renderer owns id + creation time; the store the rest. */
export interface ChatSessionWrite {
	readonly id: string;
	readonly createdAt: number;
	readonly messages: readonly ChatMessage[];
}

function getBridge(): CapabilityClient | undefined {
	if (typeof globalThis === "undefined") return undefined;
	return (globalThis as { untie?: CapabilityClient }).untie;
}

/** True when the capability bridge is present (i.e. running inside Electron). */
export function isChatPersistenceAvailable(): boolean {
	return getBridge() !== undefined;
}

function toChatSession(session: CapabilityChatSession): ChatSession {
	return {
		id: session.id,
		title: session.title,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		// The store round-trips exactly the ChatMessage documents the renderer
		// wrote, so the base-field capability payload is safe to narrow back to the
		// concrete union here (the one place that widening is reversed).
		messages: session.messages as unknown as readonly ChatMessage[],
	};
}

async function unwrap<T>(
	promise: Promise<CapabilityResult<T>>,
): Promise<T | undefined> {
	try {
		const result = await promise;
		return result.ok ? result.value : undefined;
	} catch {
		// A rejected IPC call must not crash the transcript; treat it as absent.
		return undefined;
	}
}

/** List persisted sessions, newest activity first. Empty outside Electron. */
export async function listChatSessions(): Promise<ChatSessionSummary[]> {
	const bridge = getBridge();
	if (!bridge) return [];
	const value = await unwrap(bridge.listChatSessions({}));
	return value?.sessions ?? [];
}

/** Load one session's messages, or null when missing / outside Electron. */
export async function loadChatSession(
	sessionId: string,
): Promise<ChatSession | null> {
	const bridge = getBridge();
	if (!bridge) return null;
	const value = await unwrap(bridge.loadChatSession({ sessionId }));
	return value?.session ? toChatSession(value.session) : null;
}

/** Create-or-replace a session document. No-op (returns null) outside Electron. */
export async function saveChatSession(
	session: ChatSessionWrite,
): Promise<ChatSession | null> {
	const bridge = getBridge();
	if (!bridge) return null;
	const value = await unwrap(bridge.saveChatSession({ session }));
	return value ? toChatSession(value.session) : null;
}

/** Delete a single session. Returns whether a session was removed. */
export async function deleteChatSession(sessionId: string): Promise<boolean> {
	const bridge = getBridge();
	if (!bridge) return false;
	const value = await unwrap(bridge.deleteChatSession({ sessionId }));
	return value?.deleted ?? false;
}

/**
 * Delete every persisted chat, wiring toward the PRD's "Delete my local data".
 * Returns how many sessions were removed.
 */
export async function deleteAllChatData(): Promise<number> {
	const bridge = getBridge();
	if (!bridge) return 0;
	const value = await unwrap(bridge.deleteAllChatData({}));
	return value?.deletedCount ?? 0;
}
