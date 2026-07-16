import { SendIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { saveChatSession } from "./chat-persistence";
import { deriveChatTitle } from "./chat-title";
import { MessageCard } from "./message-card";
import {
	type ChatMessage,
	createMessageId,
	type PlanMessage,
	upsertMessage,
} from "./message-model";
import {
	buildApplySteps,
	buildInvalidPlan,
	buildMockSortRequest,
	buildSortFailure,
	buildSortPlanSteps,
	buildStalePlan,
	buildUndoMessage,
	type DriverHandle,
	runDriverSteps,
} from "./mock-sort-driver";
import { SortDisclosure } from "./sort-disclosure";
import type {
	GenerateSortPlanInput,
	SortDisclosureRequest,
} from "./sort-disclosure-model";

const DEFAULT_REQUEST = "Sort my Downloads";

/** The chat currently shown: identity plus its persisted transcript to seed. */
export interface ChatPaneProps {
	/** Identity of the active chat; persisted writes key off this. */
	readonly session: { readonly id: string; readonly createdAt: number };
	/** Transcript to seed the pane with (a resumed chat, or empty for a new one). */
	readonly initialMessages: readonly ChatMessage[];
	/** Called after the transcript is persisted, so the recent-chats list refreshes. */
	readonly onPersisted?: () => void;
}

/**
 * The main chat pane for the Untie shell. Holds the transcript in memory and
 * mirrors it to local, versioned storage through the capability IPC surface
 * (P2): it is seeded with the active chat's transcript and re-saves the session
 * whenever the transcript changes so chats survive relaunch. The recent-chats
 * sidebar (P5) owns which chat is active and remounts this pane on switch, so
 * each mount starts from a single, clean transcript. Outside Electron (dev:web,
 * tests) persistence degrades to an in-memory no-op. A clearly-labelled dev
 * toolbar drives the mock sort simulation so the message states can be
 * round-tripped without a backend.
 */
export function ChatPane({
	session,
	initialMessages,
	onPersisted,
}: ChatPaneProps) {
	const [messages, setMessages] = useState<ChatMessage[]>(() => [
		...initialMessages,
	]);
	const [input, setInput] = useState("");
	const [isRunning, setIsRunning] = useState(false);
	// S3 pre-send gate: while set, the disclosure panel is shown and NOTHING has
	// been transmitted yet. Confirm sends the payload; cancel clears it.
	const [pendingDisclosure, setPendingDisclosure] =
		useState<SortDisclosureRequest | null>(null);
	const driverRef = useRef<DriverHandle | null>(null);
	const listEndRef = useRef<HTMLDivElement | null>(null);
	// Keep the latest callback without making it a persist-effect dependency.
	const onPersistedRef = useRef(onPersisted);
	onPersistedRef.current = onPersisted;
	// Don't re-persist the transcript we were seeded with (a resumed chat); only
	// genuine edits made after mount should hit the store.
	const skipInitialPersistRef = useRef(initialMessages.length > 0);

	// Cancel any in-flight mock driver when the pane unmounts.
	useEffect(() => () => driverRef.current?.cancel(), []);

	// Mirror the transcript to local storage as it evolves. Empty transcripts are
	// never persisted, so a brand-new chat leaves no session behind until it has
	// content. `session` is stable for the pane's lifetime (it is remounted on
	// switch), so this effect only re-runs as the transcript changes.
	useEffect(() => {
		if (messages.length === 0) return;
		if (skipInitialPersistRef.current) {
			skipInitialPersistRef.current = false;
			return;
		}
		let cancelled = false;
		void saveChatSession({
			id: session.id,
			createdAt: session.createdAt,
			messages,
		}).then((saved) => {
			if (!cancelled && saved) onPersistedRef.current?.();
		});
		return () => {
			cancelled = true;
		};
	}, [messages, session.id, session.createdAt]);

	// Keep the newest message (or the pending disclosure gate) in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on transcript/gate change.
	useEffect(() => {
		listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages, pendingDisclosure]);

	const lastResult = useMemo(
		() => [...messages].reverse().find((message) => message.kind === "result"),
		[messages],
	);

	// The most recent plan card still awaiting approval — drives the dev-only
	// "mark stale" affordance (mirroring W11 invalidating a prepared snapshot).
	const latestReadyPlan = useMemo(
		() =>
			[...messages]
				.reverse()
				.find(
					(message): message is PlanMessage =>
						message.kind === "plan" && message.status === "ready",
				),
		[messages],
	);

	// Nothing may be sent or simulated while the disclosure gate is open.
	const isBusy = isRunning || pendingDisclosure !== null;

	const apply = (message: ChatMessage) =>
		setMessages((prev) => upsertMessage(prev, message));

	const runSteps = (steps: Parameters<typeof runDriverSteps>[0]) => {
		driverRef.current?.cancel();
		setIsRunning(true);
		driverRef.current = runDriverSteps(steps, apply, () => setIsRunning(false));
	};

	const startSort = (request: string) => {
		const text = request.trim();
		if (!text || isBusy) return;
		apply({
			kind: "user",
			id: createMessageId(),
			createdAt: Date.now(),
			text,
		});
		setInput("");
		// S3: gate the request behind a per-request disclosure. Nothing leaves the
		// device until the user confirms exactly what would be sent.
		setPendingDisclosure(buildMockSortRequest());
	};

	// Confirm transmission: the disclosed payload (`input`) is what leaves the
	// device. In production this vetted payload goes to the sort-plan endpoint
	// (S2/W9); the mock stops at a `ready` plan the card owns approval of (W13).
	const confirmDisclosure = (input: GenerateSortPlanInput) => {
		// Defence in depth: never transmit an empty request.
		if (isRunning || input.files.length === 0) return;
		setPendingDisclosure(null);
		runSteps(
			buildSortPlanSteps({ assistantId: createMessageId(), now: Date.now() }),
		);
	};

	// Cancel: close the gate. Nothing was transmitted.
	const cancelDisclosure = () => {
		setPendingDisclosure(null);
	};

	// Approve a reviewed plan. Only a `ready` plan can be approved; the plan card
	// disables the control otherwise, and this guard is the defence in depth. The
	// card is locked to `approved` first (preventing a double-submit) and then the
	// apply simulation runs, standing in for the journaled apply engine (W14).
	const approvePlan = (plan: PlanMessage) => {
		if (isBusy || plan.status !== "ready") return;
		apply({ ...plan, status: "approved" });
		runSteps(
			buildApplySteps({
				applyId: createMessageId(),
				now: Date.now(),
				folders: plan.folders,
			}),
		);
	};

	const simulateFailure = () => {
		if (isBusy) return;
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

	// Invalidate the pending plan in place, as W11 marks a prepared snapshot
	// unusable when the folder changes underneath it. Approval is now blocked.
	const markPlanStale = () => {
		if (isBusy || !latestReadyPlan) return;
		apply(
			buildStalePlan({
				id: latestReadyPlan.id,
				now: latestReadyPlan.createdAt,
				folders: latestReadyPlan.folders,
			}),
		);
	};

	const simulateInvalidPlan = () => {
		if (isBusy) return;
		apply({
			kind: "user",
			id: createMessageId(),
			createdAt: Date.now(),
			text: "Sort my Downloads",
		});
		apply(buildInvalidPlan({ id: createMessageId(), now: Date.now() }));
	};

	const simulateUndo = () => {
		if (isBusy || !lastResult) return;
		apply(
			buildUndoMessage({
				id: createMessageId(),
				now: Date.now(),
				restoredCount: lastResult.movedCount,
				removedFolderCount: lastResult.createdFolderCount,
			}),
		);
	};

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		startSort(input || DEFAULT_REQUEST);
	};

	const isEmpty = messages.length === 0;
	const title = deriveChatTitle(messages);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-3 pb-3">
				<h2
					className="min-w-0 truncate font-semibold text-foreground text-sm"
					title={title}
				>
					{title}
				</h2>
			</header>

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
									<MessageCard message={message} onApprovePlan={approvePlan} />
								</li>
							))}
						</ol>
					)}
					{pendingDisclosure ? (
						<div className="mt-4">
							<SortDisclosure
								request={pendingDisclosure}
								onConfirm={confirmDisclosure}
								onCancel={cancelDisclosure}
							/>
						</div>
					) : null}
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
						disabled={isBusy}
						aria-label="Send message"
					>
						<SendIcon />
					</Button>
				</form>
			</div>

			<DevToolbar
				isRunning={isBusy}
				canUndo={Boolean(lastResult)}
				canMarkStale={Boolean(latestReadyPlan)}
				onSort={() => startSort(DEFAULT_REQUEST)}
				onMarkStale={markPlanStale}
				onInvalidPlan={simulateInvalidPlan}
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
 * DEV-ONLY controls. This whole block is scaffolding and is expected to be
 * removed once the real IPC-backed sort flow (W9+) and journaled apply (W14)
 * land. It exists only so every message state — including the W13 plan review
 * states (ready / stale / invalid) — can be exercised in `dev:web`. Approval
 * itself is driven from the plan card, not here.
 */
function DevToolbar({
	isRunning,
	canUndo,
	canMarkStale,
	onSort,
	onMarkStale,
	onInvalidPlan,
	onFailure,
	onUndo,
}: {
	isRunning: boolean;
	canUndo: boolean;
	canMarkStale: boolean;
	onSort: () => void;
	onMarkStale: () => void;
	onInvalidPlan: () => void;
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
				onClick={onMarkStale}
				disabled={isRunning || !canMarkStale}
			>
				Mark plan stale
			</Button>
			<Button
				type="button"
				variant="secondary"
				size="sm"
				onClick={onInvalidPlan}
				disabled={isRunning}
			>
				Simulate invalid plan
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
