import { MessagesSquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import type { ChatSessionSummary } from "./chat-persistence";
import { formatRelativeTime } from "./chat-title";

/**
 * The recent-chats sidebar (P5, PRD B3). Lists every locally-persisted chat,
 * most-recent activity first, and lets the person resume one, start a fresh
 * chat, or delete a chat (with an inline confirm so a click can't destroy
 * history by accident). Only persisted chats appear here; a brand-new chat that
 * has no content yet is represented by the pane's empty state, not a list row,
 * so the "no chats yet" empty state stays honest.
 */
export function ChatSidebar({
	sessions,
	activeId,
	onSelect,
	onNewChat,
	onDelete,
}: {
	sessions: readonly ChatSessionSummary[];
	activeId: string;
	onSelect: (sessionId: string) => void;
	onNewChat: () => void;
	onDelete: (sessionId: string) => void;
}) {
	return (
		<aside
			aria-label="Chats"
			className="island-shell flex w-64 shrink-0 flex-col overflow-hidden rounded-2xl border border-border"
		>
			<div className="flex items-center justify-between gap-2 border-border border-b px-3 py-3">
				<h2 className="font-semibold text-foreground text-sm">Chats</h2>
				<Button type="button" variant="outline" size="sm" onClick={onNewChat}>
					<PlusIcon />
					New chat
				</Button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{sessions.length === 0 ? (
					<SidebarEmptyState />
				) : (
					<ul className="space-y-1" aria-label="Recent chats">
						{sessions.map((session) => (
							<ChatRow
								key={session.id}
								session={session}
								isActive={session.id === activeId}
								onSelect={onSelect}
								onDelete={onDelete}
							/>
						))}
					</ul>
				)}
			</div>
		</aside>
	);
}

function ChatRow({
	session,
	isActive,
	onSelect,
	onDelete,
}: {
	session: ChatSessionSummary;
	isActive: boolean;
	onSelect: (sessionId: string) => void;
	onDelete: (sessionId: string) => void;
}) {
	const [isConfirming, setIsConfirming] = useState(false);

	return (
		<li>
			<div
				className={cn(
					"group flex items-center gap-1 rounded-lg pr-1 transition-colors",
					isActive
						? "bg-[color:var(--chip-bg)] ring-1 ring-[color:var(--chip-line)]"
						: "hover:bg-[color:var(--link-bg-hover)]",
				)}
			>
				<button
					type="button"
					onClick={() => onSelect(session.id)}
					aria-current={isActive ? "true" : undefined}
					className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="w-full truncate font-medium text-foreground text-sm">
						{session.title}
					</span>
					<span className="text-muted-foreground text-xs">
						{formatRelativeTime(session.updatedAt)}
					</span>
				</button>

				{isConfirming ? (
					<div className="flex items-center gap-1">
						<Button
							type="button"
							size="sm"
							variant="destructive"
							onClick={() => onDelete(session.id)}
							aria-label={`Confirm delete chat: ${session.title}`}
						>
							Delete
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setIsConfirming(false)}
							aria-label="Cancel delete"
						>
							Cancel
						</Button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setIsConfirming(true)}
						aria-label={`Delete chat: ${session.title}`}
						className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
					>
						<Trash2Icon className="size-4" />
					</button>
				)}
			</div>
		</li>
	);
}

function SidebarEmptyState() {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-10 text-center">
			<MessagesSquareIcon
				className="size-6 text-muted-foreground"
				aria-hidden="true"
			/>
			<p className="font-medium text-foreground text-sm">No chats yet</p>
			<p className="text-muted-foreground text-xs">
				Ask Untie to sort a folder and your chats will show up here.
			</p>
		</div>
	);
}
