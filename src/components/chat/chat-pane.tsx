import { PlusIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import {
	listChatSessions,
	loadChatSession,
	saveChatSession,
} from "./chat-persistence";
import { MessageCard } from "./message-card";
import {
	type ChatMessage,
	createMessageId,
	upsertMessage,
} from "./message-model";
import {
	buildSortFailure,
	buildSortRoundTrip,
	buildUndoMessage,
	type DriverHandle,
	runDriverSteps,
} from "./mock-sort-driver";

const DEFAULT_REQUEST = "Sort my Downloads";

function newSession() {
	return { id: createMessageId(), createdAt: Date.now() };
}

/**
 * The main chat pane for the Untie shell. Holds the transcript in memory and
 * mirrors it to local, versioned storage through the capability IPC surface
 * (P2): on start it resumes the most recent persisted chat, and it re-saves the
 * session whenever the transcript changes so chats survive relaunch. Outside
 * Electron (dev:web, tests) persistence degrades to an in-memory no-op. A
 * clearly-labelled dev toolbar drives the mock sort simulation so the message
 * states can be round-tripped without a backend.
 */
export function ChatPane() {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [isRunning, setIsRunning] = useState(false);
	// Identity of the chat currently shown; persisted writes key off this.
	const sessionRef = useRef(newSession());
	// Gate persistence until the initial resume has run, so hydration never
	// overwrites a stored chat with the empty starting transcript.
	const [isHydrated, setIsHydrated] = useState(false);
	const driverRef = useRef<DriverHandle | null>(null);
	const listEndRef = useRef<HTMLDivElement | null>(null);

	// Cancel any in-flight mock driver when the pane unmounts.
	useEffect(() => () => driverRef.current?.cancel(), []);

	// Resume the most recent persisted chat on start.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const sessions = await listChatSessions();
			const latest = sessions[0];
			if (latest) {
				const resumed = await loadChatSession(latest.id);
				if (!cancelled && resumed) {
					sessionRef.current = {
						id: resumed.id,
						createdAt: resumed.createdAt,
					};
					setMessages([...resumed.messages]);
				}
			}
			if (!cancelled) setIsHydrated(true);
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Mirror the transcript to local storage as it evolves. Empty transcripts are
	// never persisted, so "New chat" leaves no empty session behind.
	useEffect(() => {
		if (!isHydrated || messages.length === 0) return;
		const { id, createdAt } = sessionRef.current;
		void saveChatSession({ id, createdAt, messages });
	}, [messages, isHydrated]);

	// Keep the newest message in view as the transcript grows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on transcript change.
	useEffect(() => {
		listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages]);

	const lastResult = useMemo(
		() => [...messages].reverse().find((message) => message.kind === "result"),
		[messages],
	);

	const apply = (message: ChatMessage) =>
		setMessages((prev) => upsertMessage(prev, message));

	const runSteps = (steps: Parameters<typeof runDriverSteps>[0]) => {
		driverRef.current?.cancel();
		setIsRunning(true);
		driverRef.current = runDriverSteps(steps, apply, () => setIsRunning(false));
	};

	const startSort = (request: string) => {
		const text = request.trim();
		if (!text || isRunning) return;
		apply({
			kind: "user",
			id: createMessageId(),
			createdAt: Date.now(),
			text,
		});
		setInput("");
		runSteps(
			buildSortRoundTrip({
				assistantId: createMessageId(),
				resultId: createMessageId(),
				now: Date.now(),
			}),
		);
	};

	const simulateFailure = () => {
		if (isRunning) return;
		apply({
			kind: "user",
			id: createMessageId(),
			createdAt: Date.now(),
			text: "Sort my Downloads",
		});
		runSteps(
			buildSortFailure({ assistantId: createMessageId(), now: Date.now() }),
		);
	};

	const simulateUndo = () => {
		if (isRunning || !lastResult) return;
		apply(
			buildUndoMessage({
				id: createMessageId(),
				now: Date.now(),
				restoredCount: lastResult.movedCount,
				removedFolderCount: lastResult.createdFolderCount,
			}),
		);
	};

	const newChat = () => {
		driverRef.current?.cancel();
		setIsRunning(false);
		setMessages([]);
		setInput("");
		// Start a fresh session; the prior chat stays persisted and resumable.
		sessionRef.current = newSession();
	};

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		startSort(input || DEFAULT_REQUEST);
	};

	const isEmpty = messages.length === 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between gap-3 pb-3">
				<h2 className="font-semibold text-foreground text-sm">Chat</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={newChat}
					disabled={isEmpty && !isRunning}
				>
					<PlusIcon />
					New chat
				</Button>
			</div>

			<div className="island-shell flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border">
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					{isEmpty ? (
						<EmptyState />
					) : (
						<ol
							className="space-y-4"
							aria-live="polite"
							aria-label="Conversation"
						>
							{messages.map((message) => (
								<li key={message.id}>
									<MessageCard message={message} />
								</li>
							))}
						</ol>
					)}
					<div ref={listEndRef} />
				</div>

				<form
					onSubmit={handleSubmit}
					className="flex items-end gap-2 border-border border-t bg-[color:var(--surface-strong)] p-3"
				>
					<label htmlFor="chat-composer" className="sr-only">
						Ask Untie to sort a folder
					</label>
					<textarea
						id="chat-composer"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								startSort(input || DEFAULT_REQUEST);
							}
						}}
						rows={1}
						placeholder="Ask Untie to sort a folder…"
						className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
					<Button
						type="submit"
						size="icon"
						disabled={isRunning}
						aria-label="Send message"
					>
						<SendIcon />
					</Button>
				</form>
			</div>

			<DevToolbar
				isRunning={isRunning}
				canUndo={Boolean(lastResult)}
				onSort={() => startSort(DEFAULT_REQUEST)}
				onFailure={simulateFailure}
				onUndo={simulateUndo}
			/>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="flex h-full flex-col items-center justify-center py-10 text-center">
			<h3 className="display-title text-foreground text-xl">
				What should Untie sort?
			</h3>
			<p className="mt-2 max-w-sm text-muted-foreground text-sm">
				Ask in plain language — like “Sort my Downloads”. Untie proposes a plan
				you review before anything moves.
			</p>
		</div>
	);
}

/**
 * DEV-ONLY controls. This whole block is scaffolding for W12 and is expected to
 * be removed once the real IPC-backed sort flow (W9+) and plan approval (W13)
 * land. It exists only so every message state can be exercised in `dev:web`.
 */
function DevToolbar({
	isRunning,
	canUndo,
	onSort,
	onFailure,
	onUndo,
}: {
	isRunning: boolean;
	canUndo: boolean;
	onSort: () => void;
	onFailure: () => void;
	onUndo: () => void;
}) {
	return (
		<section
			aria-label="Developer simulation controls"
			className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border border-dashed bg-[color:var(--chip-bg)] px-3 py-2"
		>
			<span className="island-kicker mr-1">Dev / mock</span>
			<Button
				type="button"
				variant="secondary"
				size="sm"
				onClick={onSort}
				disabled={isRunning}
			>
				Simulate sort
			</Button>
			<Button
				type="button"
				variant="secondary"
				size="sm"
				onClick={onFailure}
				disabled={isRunning}
			>
				Simulate failure
			</Button>
			<Button
				type="button"
				variant="secondary"
				size="sm"
				onClick={onUndo}
				disabled={isRunning || !canUndo}
			>
				Undo last sort
			</Button>
		</section>
	);
}
