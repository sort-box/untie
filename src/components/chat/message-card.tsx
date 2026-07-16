import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	ClockAlertIcon,
	FolderIcon,
	FolderPlusIcon,
	Loader2Icon,
	SparklesIcon,
	Undo2Icon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import {
	assertNever,
	type ChatMessage,
	isPlanApprovable,
	messageAccessibleLabel,
	type PlanFolder,
	type PlanMessage,
	planApprovalCopy,
	planBlockReason,
	planCreatedFolderCount,
	planMoveCount,
} from "./message-model";

/** Callback invoked when the user approves a `ready` plan from its card. */
export type ApprovePlanHandler = (plan: PlanMessage) => void;

/**
 * Exhaustive renderer for the structured message model. Each `kind` gets a
 * visually distinct card; the `default` branch calls `assertNever`, so a new
 * kind fails to compile until it is handled here.
 */
export function MessageCard({
	message,
	onApprovePlan,
}: {
	message: ChatMessage;
	/** Approve handler threaded to the plan card; omitted for read-only renders. */
	onApprovePlan?: ApprovePlanHandler;
}) {
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
			return <PlanCard message={message} onApprove={onApprovePlan} />;
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

/**
 * The hero card: a reviewable sort plan with exact-counts approval (W13).
 *
 * The card is safety-first: it shows the grouped destinations up front and the
 * COMPLETE move set (every file → its destination) one expand away, so nothing
 * moves that the user hasn't been able to inspect. The approval line states the
 * exact counts and the v1 guarantee, derived from the plan's own data — and the
 * Approve button is only enabled for a `ready` plan. A `stale`/`invalid` plan
 * shows why it can't be approved and disables the control.
 */
function PlanCard({
	message,
	onApprove,
}: {
	message: PlanMessage;
	onApprove?: ApprovePlanHandler;
}) {
	const [showAllMoves, setShowAllMoves] = useState(false);

	// Every count derives from the plan's own move set — never hardcoded — so the
	// review, the approval copy, and the eventual apply can never disagree.
	const moveCount = planMoveCount(message.folders);
	const createdCount = planCreatedFolderCount(message.folders);
	const existingCount = message.folders.length - createdCount;
	const approvable = isPlanApprovable(message.status);
	const blockReason = planBlockReason(message);
	const isApproved = message.status === "approved";
	// Narrows away "ready" so the status banner gets a concrete blocked status.
	const blockedStatus = message.status === "ready" ? null : message.status;

	const movesRegionId = `plan-moves-${message.id}`;
	const approvalCopyId = `plan-approval-${message.id}`;
	const reasonId = `plan-reason-${message.id}`;

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
					<p className="mt-1 text-muted-foreground text-xs">
						{createdCount} new · {existingCount} existing · in Downloads
					</p>
				</header>

				{blockedStatus && blockReason ? (
					<PlanStatusBanner
						id={reasonId}
						status={blockedStatus}
						reason={blockReason}
					/>
				) : null}

				<ul className="space-y-1.5" aria-label="Proposed destinations">
					{message.folders.map((folder) => (
						<PlanFolderRow key={folder.name} folder={folder} />
					))}
				</ul>

				<div className="mt-3">
					<button
						type="button"
						onClick={() => setShowAllMoves((open) => !open)}
						aria-expanded={showAllMoves}
						aria-controls={movesRegionId}
						className="inline-flex items-center gap-1.5 rounded-md text-[color:var(--lagoon-deep)] text-xs font-medium hover:text-[color:var(--sea-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<ChevronDownIcon
							className={cn(
								"size-3.5 transition-transform",
								showAllMoves && "rotate-180",
							)}
							aria-hidden="true"
						/>
						{showAllMoves ? "Hide" : "Review"} all {moveCount} moves
					</button>
					{showAllMoves ? (
						<section
							id={movesRegionId}
							aria-label="All proposed moves"
							className="mt-2 space-y-3"
						>
							{message.folders.map((folder) => (
								<FullMoveGroup key={folder.name} folder={folder} />
							))}
						</section>
					) : null}
				</div>

				<footer className="mt-4 border-border border-t pt-3">
					<p
						id={approvalCopyId}
						className="font-medium text-foreground text-sm"
					>
						{planApprovalCopy(message.folders)}
					</p>
					<div className="mt-3">
						<Button
							type="button"
							onClick={() => onApprove?.(message)}
							disabled={!approvable}
							aria-describedby={approvable ? approvalCopyId : reasonId}
						>
							{isApproved ? (
								<CheckCircle2Icon aria-hidden="true" />
							) : (
								<CheckIcon aria-hidden="true" />
							)}
							{isApproved ? "Approved" : "Approve & sort"}
						</Button>
					</div>
				</footer>
			</section>
		</article>
	);
}

const PLAN_BLOCK_TONES: Record<
	"stale" | "invalid" | "approved",
	{ className: string; icon: React.ReactNode; label: string }
> = {
	stale: {
		className:
			"border-[color:var(--chip-line)] bg-[color:var(--chip-bg)] text-foreground/80",
		icon: <ClockAlertIcon className="size-4 text-[color:var(--lagoon-deep)]" />,
		label: "Plan out of date",
	},
	invalid: {
		className: "border-destructive/40 bg-destructive/5 text-foreground/80",
		icon: <AlertTriangleIcon className="size-4 text-destructive" />,
		label: "Plan can't be approved",
	},
	approved: {
		className:
			"border-[color:var(--chip-line)] bg-[color:var(--chip-bg)] text-foreground/80",
		icon: <CheckCircle2Icon className="size-4 text-[color:var(--palm)]" />,
		label: "Plan approved",
	},
};

/** Explains why a non-`ready` plan can't be approved; `id` links the button. */
function PlanStatusBanner({
	id,
	status,
	reason,
}: {
	id: string;
	status: "stale" | "invalid" | "approved";
	reason: string;
}) {
	const tone = PLAN_BLOCK_TONES[status];
	return (
		// Live region so an in-place ready → stale/invalid transition is announced.
		<div
			id={id}
			aria-live="polite"
			className={cn(
				"mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
				tone.className,
			)}
		>
			<span className="mt-0.5 shrink-0" aria-hidden="true">
				{tone.icon}
			</span>
			<span>
				<span className="font-semibold">{tone.label}.</span> {reason}
			</span>
		</div>
	);
}

/** A single grouped-destination summary row: name, new/existing, count, preview. */
function PlanFolderRow({ folder }: { folder: PlanFolder }) {
	const count = folder.files.length;
	const preview = folder.files.slice(0, 2);
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
						{count} {count === 1 ? "file" : "files"}
					</span>
				</div>
				<p className="truncate text-muted-foreground text-xs">
					{preview.join(" · ")}
					{count > preview.length ? " · …" : ""}
				</p>
			</div>
		</li>
	);
}

/** The full move set for one destination: heading + every file as a list item. */
function FullMoveGroup({ folder }: { folder: PlanFolder }) {
	const count = folder.files.length;
	return (
		<section
			aria-label={`${folder.name}: ${count} ${count === 1 ? "file" : "files"}`}
		>
			<h4 className="flex items-center gap-1.5 font-semibold text-foreground text-xs">
				<span aria-hidden="true" className="text-[color:var(--palm)]">
					{folder.isNew ? (
						<FolderPlusIcon className="size-3.5" />
					) : (
						<FolderIcon className="size-3.5" />
					)}
				</span>
				<span className="truncate">{folder.name}</span>
				<span className="font-normal text-[10px] text-muted-foreground uppercase tracking-wide">
					{folder.isNew ? "new" : "existing"}
				</span>
				<span className="ml-auto shrink-0 font-normal text-muted-foreground tabular-nums">
					{count}
				</span>
			</h4>
			<ul className="mt-1 space-y-0.5 border-[color:var(--chip-line)] border-l pl-3">
				{folder.files.map((file) => (
					<li
						key={file}
						className="truncate text-muted-foreground text-xs"
						title={file}
					>
						{file}
					</li>
				))}
			</ul>
		</section>
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
