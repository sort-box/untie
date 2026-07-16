import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	FolderIcon,
	FolderPlusIcon,
	Loader2Icon,
	SparklesIcon,
	Undo2Icon,
} from "lucide-react";

import { cn } from "#/lib/utils";
import {
	assertNever,
	type ChatMessage,
	messageAccessibleLabel,
	type PlanFolder,
	type PlanMessage,
} from "./message-model";

/**
 * Exhaustive renderer for the structured message model. Each `kind` gets a
 * visually distinct card; the `default` branch calls `assertNever`, so a new
 * kind fails to compile until it is handled here.
 */
export function MessageCard({ message }: { message: ChatMessage }) {
	switch (message.kind) {
		case "user":
			return <UserBubble text={message.text} />;
		case "pending":
			return (
				<StatusCard
					icon={
						<Loader2Icon className="animate-spin text-[color:var(--lagoon-deep)]" />
					}
					label={messageAccessibleLabel(message)}
				>
					<p className="text-sm text-muted-foreground">{message.label}</p>
				</StatusCard>
			);
		case "progress":
			return (
				<StatusCard
					icon={
						<Loader2Icon className="animate-spin text-[color:var(--lagoon-deep)]" />
					}
					label={messageAccessibleLabel(message)}
				>
					<div className="space-y-2">
						<p className="text-sm font-medium text-foreground">
							{message.label}
						</p>
						<ProgressBar current={message.current} total={message.total} />
					</div>
				</StatusCard>
			);
		case "plan":
			return <PlanCard message={message} />;
		case "result":
			return (
				<OutcomeCard
					tone="success"
					icon={<CheckCircle2Icon />}
					title="Sort complete"
					label={messageAccessibleLabel(message)}
				>
					<p className="text-sm text-foreground/80">{message.summary}</p>
					<OutcomeStats
						stats={[
							{ value: message.movedCount, label: "files moved" },
							{ value: message.createdFolderCount, label: "folders created" },
						]}
					/>
				</OutcomeCard>
			);
		case "undo":
			return (
				<OutcomeCard
					tone="neutral"
					icon={<Undo2Icon />}
					title="Sort undone"
					label={messageAccessibleLabel(message)}
				>
					<p className="text-sm text-foreground/80">{message.summary}</p>
					<OutcomeStats
						stats={[
							{ value: message.restoredCount, label: "files restored" },
							{ value: message.removedFolderCount, label: "folders removed" },
						]}
					/>
				</OutcomeCard>
			);
		case "failed":
			return (
				<OutcomeCard
					tone="danger"
					icon={<AlertTriangleIcon />}
					title={message.title}
					label={messageAccessibleLabel(message)}
				>
					<p className="text-sm text-foreground/80">{message.detail}</p>
					{message.retryable ? (
						<p className="text-xs text-muted-foreground">
							You can send the request again to retry.
						</p>
					) : null}
				</OutcomeCard>
			);
		default:
			return assertNever(message);
	}
}

function UserBubble({ text }: { text: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[color:var(--lagoon-deep)] px-4 py-2.5 text-sm text-white shadow-sm">
				{text}
			</div>
		</div>
	);
}

function AssistantAvatar() {
	return (
		<div
			className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--sand)] text-[color:var(--palm)]"
			aria-hidden="true"
		>
			<SparklesIcon className="size-4" />
		</div>
	);
}

/** Compact, low-emphasis card for the transient pending / progress states. */
function StatusCard({
	icon,
	label,
	children,
}: {
	icon: React.ReactNode;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<article className="flex gap-3" aria-label={label}>
			<AssistantAvatar />
			<div className="feature-card flex flex-1 items-center gap-3 rounded-xl border border-border px-4 py-3">
				<span
					className="flex size-5 items-center justify-center"
					aria-hidden="true"
				>
					{icon}
				</span>
				<div className="flex-1">{children}</div>
			</div>
		</article>
	);
}

function ProgressBar({ current, total }: { current: number; total: number }) {
	const percent = total > 0 ? Math.round((current / total) * 100) : 0;
	return (
		<div
			className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--sand)]"
			role="progressbar"
			aria-valuenow={current}
			aria-valuemin={0}
			aria-valuemax={total}
		>
			<div
				className="h-full rounded-full bg-[color:var(--lagoon-deep)] transition-[width] duration-500 ease-out"
				style={{ width: `${percent}%` }}
			/>
		</div>
	);
}

/** The hero card: a reviewable sort plan. */
function PlanCard({ message }: { message: PlanMessage }) {
	return (
		<article
			className="flex gap-3"
			aria-label={messageAccessibleLabel(message)}
		>
			<AssistantAvatar />
			<section className="island-shell flex-1 rounded-2xl border border-border p-4">
				<header className="mb-3">
					<p className="island-kicker">Proposed sort</p>
					<h3 className="display-title mt-1 text-lg font-semibold text-foreground">
						{message.summary}
					</h3>
					<p className="mt-1 text-xs text-muted-foreground">
						{message.createdFolderCount} new{" "}
						{message.createdFolderCount === 1 ? "folder" : "folders"},{" "}
						{message.folderCount - message.createdFolderCount} existing · in
						Downloads
					</p>
				</header>
				<ul className="space-y-1.5">
					{message.folders.map((folder) => (
						<PlanFolderRow key={folder.name} folder={folder} />
					))}
				</ul>
				<footer className="mt-3 border-border border-t pt-3 text-xs text-muted-foreground">
					Mock preview — plan review, exclusions, and approval arrive in W13.
					Nothing is renamed, overwritten, or deleted.
				</footer>
			</section>
		</article>
	);
}

function PlanFolderRow({ folder }: { folder: PlanFolder }) {
	return (
		<li className="flex items-start gap-3 rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2">
			<span
				className="mt-0.5 text-[color:var(--palm)]"
				aria-hidden="true"
				title={folder.isNew ? "New folder" : "Existing folder"}
			>
				{folder.isNew ? (
					<FolderPlusIcon className="size-4" />
				) : (
					<FolderIcon className="size-4" />
				)}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline justify-between gap-2">
					<p className="truncate font-medium text-foreground text-sm">
						{folder.name}
						<span className="ml-2 font-normal text-[10px] text-muted-foreground uppercase tracking-wide">
							{folder.isNew ? "new" : "existing"}
						</span>
					</p>
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{folder.fileCount} {folder.fileCount === 1 ? "file" : "files"}
					</span>
				</div>
				<p className="truncate text-muted-foreground text-xs">
					{folder.examples.join(" · ")}
					{folder.fileCount > folder.examples.length ? " · …" : ""}
				</p>
			</div>
		</li>
	);
}

type OutcomeTone = "success" | "danger" | "neutral";

const OUTCOME_TONES: Record<OutcomeTone, string> = {
	success: "text-[color:var(--palm)]",
	danger: "text-destructive",
	neutral: "text-[color:var(--lagoon-deep)]",
};

/** Persisted result / undo / failure cards. */
function OutcomeCard({
	tone,
	icon,
	title,
	label,
	children,
}: {
	tone: OutcomeTone;
	icon: React.ReactNode;
	title: string;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<article className="flex gap-3" aria-label={label}>
			<AssistantAvatar />
			<section className="feature-card flex-1 rounded-2xl border border-border p-4">
				<header className="flex items-center gap-2">
					<span
						className={cn(
							"flex size-5 items-center justify-center",
							OUTCOME_TONES[tone],
						)}
						aria-hidden="true"
					>
						{icon}
					</span>
					<h3 className="font-semibold text-foreground text-sm">{title}</h3>
				</header>
				<div className="mt-2 space-y-3">{children}</div>
			</section>
		</article>
	);
}

function OutcomeStats({
	stats,
}: {
	stats: ReadonlyArray<{ value: number; label: string }>;
}) {
	return (
		<dl className="flex gap-6">
			{stats.map((stat) => (
				<div key={stat.label}>
					<dt className="text-muted-foreground text-xs">{stat.label}</dt>
					<dd className="font-semibold text-foreground text-lg tabular-nums">
						{stat.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
