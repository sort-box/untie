import { useEffect, useState } from "react";

import { ChatPane } from "./chat-pane";
import {
	type ChatSessionSummary,
	deleteChatSession,
	listChatSessions,
	loadChatSession,
} from "./chat-persistence";
import { ChatSidebar } from "./chat-sidebar";
import { type ChatMessage, createMessageId } from "./message-model";

/** Identity of the chat currently held by the pane; persisted writes key off it. */
interface ActiveSession {
	readonly id: string;
	readonly createdAt: number;
}

/**
 * The active chat plus the transcript to seed the pane with. Kept as one piece
 * of state so switching chats swaps identity and messages in a single update —
 * the pane is remounted (via `key`) and reads the fresh transcript exactly once.
 */
interface ChatView {
	readonly session: ActiveSession;
	readonly messages: readonly ChatMessage[];
}

function newChatView(): ChatView {
	return {
		session: { id: createMessageId(), createdAt: Date.now() },
		messages: [],
	};
}

/**
 * Owns the local chat list and the active chat, wiring the recent-chats sidebar
 * (P5) to the chat pane (W12). On start it resumes the most recent persisted
 * chat; selecting one loads it, "New chat" opens a fresh (unpersisted) session,
 * and deleting the active chat falls back to the next most recent — or a fresh
 * empty chat. All persistence is local and degrades to no-ops outside Electron.
 */
export function ChatWorkspace() {
	const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
	const [view, setView] = useState<ChatView>(newChatView);

	async function refreshList(): Promise<ChatSessionSummary[]> {
		const list = await listChatSessions();
		setSessions(list);
		return list;
	}

	// Resume the most recent persisted chat on start.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const list = await listChatSessions();
			if (cancelled) return;
			setSessions(list);
			const latest = list[0];
			if (!latest) return;
			const resumed = await loadChatSession(latest.id);
			if (cancelled || !resumed) return;
			setView({
				session: { id: resumed.id, createdAt: resumed.createdAt },
				messages: resumed.messages,
			});
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const openSession = async (sessionId: string): Promise<boolean> => {
		const resumed = await loadChatSession(sessionId);
		if (!resumed) return false;
		setView({
			session: { id: resumed.id, createdAt: resumed.createdAt },
			messages: resumed.messages,
		});
		return true;
	};

	const handleSelect = (sessionId: string) => {
		if (sessionId === view.session.id) return;
		void (async () => {
			if (!(await openSession(sessionId))) {
				// The chat vanished (e.g. deleted elsewhere); reconcile the list.
				await refreshList();
			}
		})();
	};

	const handleNewChat = () => {
		// The prior chat stays persisted and resumable; only start a fresh session.
		setView(newChatView());
	};

	const handleDelete = (sessionId: string) => {
		void (async () => {
			await deleteChatSession(sessionId);
			const list = await refreshList();
			if (sessionId !== view.session.id) return;
			// The active chat was deleted: fall back to the next most recent, or a
			// fresh empty chat when none remain.
			const latest = list[0];
			if (latest && (await openSession(latest.id))) return;
			setView(newChatView());
		})();
	};

	// The store re-derives title/last-activity on every save, so refresh the list
	// whenever the active chat persists to keep ordering and titles current.
	const handlePersisted = () => {
		void refreshList();
	};

	return (
		<div className="flex min-h-0 w-full flex-1 gap-4">
			<ChatSidebar
				sessions={sessions}
				activeId={view.session.id}
				onSelect={handleSelect}
				onNewChat={handleNewChat}
				onDelete={handleDelete}
			/>
			<div className="flex min-h-0 flex-1 flex-col">
				<ChatPane
					key={view.session.id}
					session={view.session}
					initialMessages={view.messages}
					onPersisted={handlePersisted}
				/>
			</div>
		</div>
	);
}
