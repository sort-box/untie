import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	CircleHelpIcon,
	ClockAlertIcon,
	FileIcon,
	FolderIcon,
	FolderPlusIcon,
	Loader2Icon,
	ShieldCheckIcon,
	SparklesIcon,
	Undo2Icon,
	XCircleIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import {
	assertNever,
	type ChatMessage,
	isLowConfidenceMove,
	isPlanApprovable,
	messageAccessibleLabel,
	type PlanFolder,
	type PlanMessage,
	planApprovalCopy,
	planBlockReason,
	planCreatedFolderCount,
	planFoldersExcluding,
	planGroupMoveKeys,
	planMoveCount,
	planMoveKey,
	planWithFolders,
	type ResultMessage,
	type UndoMessage,
} from "./message-model";
import {
	type UndoFileLine,
	type UndoFolderLine,
	type UndoTone,
	undoControlPresentation,
	undoFileLine,
	undoFolderLine,
	undoPresentation,
} from "./undo-outcome-model";

/** Callback invoked when the user approves a `ready` plan from its card. */
export type ApprovePlanHandler = (plan: PlanMessage) => void;

/** Callback invoked when the user undoes a completed sort from its result card. */
export type UndoResultHandler = (result: ResultMessage) => void;

/**
 * Exhaustive renderer for the structured message model. Each `kind` gets a
 * visually distinct card; the `default` branch calls `assertNever`, so a new
 * kind fails to compile until it is handled here.
 */
export function MessageCard({
	message,
	onApprovePlan,
	onUndo,
	undone,
}: {
	message: ChatMessage;
	/** Approve handler threaded to the plan card; omitted for read-only renders. */
	onApprovePlan?: ApprovePlanHandler;
	/** Undo handler threaded to a result card; omitted for a non-undoable render. */
	onUndo?: UndoResultHandler;
	/** Whether this (result) sort has already been undone — disables its control. */
	undone?: boolean;
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
			return <ResultCard message={message} onUndo={onUndo} undone={undone} />;
		case "undo":
			return <UndoCard message={message} />;
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
 * The hero card: a reviewable sort plan with exact-counts approval (W13) and
 * per-file / per-destination exclusions (S4).
 *
 * The card is safety-first and progressive: it shows the grouped destinations
 * up front and the COMPLETE move set (every file → its destination) one expand
 * away, so nothing moves that the user hasn't been able to inspect. Moves the
 * model was less certain about are flagged. The user can untick any file — or a
 * whole destination — to leave it where it is; excluded files are visibly marked
 * and drop out of every count, the exact-counts approval line, and the snapshot
 * that would be approved and sent. The approval line and counts derive from the
 * plan's own data — never hardcoded — so the review and the eventual apply can
 * never disagree. Approve is only enabled for a `ready` plan with at least one
 * file kept; a `stale`/`invalid` plan shows why it can't be approved.
 */
function PlanCard({
	message,
	onApprove,
}: {
	message: PlanMessage;
	onApprove?: ApprovePlanHandler;
}) {
	const [showAllMoves, setShowAllMoves] = useState(false);
	// Files the user has chosen to leave out of this plan, keyed by `planMoveKey`.
	// Exclusion is UI state: it trims what is displayed, counted, and approved —
	// it never mutates the immutable plan snapshot the card was handed.
	const [excluded, setExcluded] = useState<ReadonlySet<string>>(
		() => new Set<string>(),
	);

	// Only a `ready` plan can be edited; stale/invalid/approved are terminal, so
	// the exclusion controls are rendered read-only (disabled) for those.
	const editable = isPlanApprovable(message.status);

	// The destinations that would actually be applied once exclusions are removed.
	// Every count, the approval copy, and the approved snapshot derive from THIS —
	// never the raw folders — so nothing the user excluded can slip through.
	const includedFolders = useMemo(
		() => planFoldersExcluding(message.folders, excluded),
		[message.folders, excluded],
	);

	const totalMoveCount = planMoveCount(message.folders);
	const moveCount = planMoveCount(includedFolders);
	const excludedCount = totalMoveCount - moveCount;
	const createdCount = planCreatedFolderCount(includedFolders);
	const existingCount = includedFolders.length - createdCount;

	const nothingToMove = moveCount === 0;
	const approvable = editable && !nothingToMove;
	const blockReason = planBlockReason(message);
	const isApproved = message.status === "approved";
	// Narrows away "ready" so the status banner gets a concrete blocked status.
	const blockedStatus = message.status === "ready" ? null : message.status;

	const movesRegionId = `plan-moves-${message.id}`;
	const approvalCopyId = `plan-approval-${message.id}`;
	const reasonId = `plan-reason-${message.id}`;
	const emptyNoteId = `plan-empty-${message.id}`;
	const exclusionStatusId = `plan-excluded-${message.id}`;

	// What the Approve button points assistive tech at: the exact-counts copy when
	// it can be approved, the blocked-status reason when a non-ready plan can't be,
	// otherwise the note explaining that everything has been excluded.
	const describedBy = approvable
		? approvalCopyId
		: blockedStatus && blockReason
			? reasonId
			: emptyNoteId;

	const toggleFile = (key: string, isExcluded: boolean) => {
		setExcluded((prev) => {
			const next = new Set(prev);
			if (isExcluded) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const toggleGroup = (
		folderIndex: number,
		folder: PlanFolder,
		allExcluded: boolean,
	) => {
		const keys = planGroupMoveKeys(folderIndex, folder);
		setExcluded((prev) => {
			const next = new Set(prev);
			for (const key of keys) {
				if (allExcluded) next.delete(key);
				else next.add(key);
			}
			return next;
		});
	};

	const approve = () => {
		if (!approvable) return;
		// Approve the trimmed snapshot so excluded files never reach apply; when
		// nothing is excluded the original plan is forwarded unchanged.
		onApprove?.(
			excluded.size === 0 ? message : planWithFolders(message, includedFolders),
		);
	};

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
						{excludedCount > 0 ? ` · ${excludedCount} excluded` : ""}
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
					{message.folders.map((folder, folderIndex) => (
						<PlanFolderRow
							key={folder.name}
							folder={folder}
							folderIndex={folderIndex}
							excluded={excluded}
							editable={editable}
							onToggleGroup={toggleGroup}
						/>
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
						{showAllMoves ? "Hide" : "Review"} all {totalMoveCount} moves
					</button>
					{showAllMoves ? (
						<section
							id={movesRegionId}
							aria-label="All proposed moves"
							className="mt-2 space-y-3"
						>
							<p className="text-muted-foreground text-xs">
								Untick any file — or a whole destination — to leave it where it
								is. Excluded files stay put and drop out of the counts below.
							</p>
							{message.folders.map((folder, folderIndex) => (
								<FullMoveGroup
									key={folder.name}
									folder={folder}
									folderIndex={folderIndex}
									excluded={excluded}
									editable={editable}
									onToggleFile={toggleFile}
								/>
							))}
						</section>
					) : null}
				</div>

				<footer className="mt-4 border-border border-t pt-3">
					{/* Announce exclusion changes to assistive tech without a visual echo. */}
					<p id={exclusionStatusId} aria-live="polite" className="sr-only">
						{excludedCount === 0
							? "No files excluded."
							: `${excludedCount} of ${totalMoveCount} files excluded.`}
					</p>
					{nothingToMove && !blockedStatus ? (
						<p id={emptyNoteId} className="font-medium text-foreground text-sm">
							Every file is excluded. Keep at least one to approve.
						</p>
					) : (
						<p
							id={approvalCopyId}
							className="font-medium text-foreground text-sm"
						>
							{planApprovalCopy(includedFolders)}
						</p>
					)}
					<div className="mt-3">
						<Button
							type="button"
							onClick={approve}
							disabled={!approvable}
							aria-describedby={describedBy}
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

/**
 * A single grouped-destination summary row: a group exclusion checkbox, name,
 * new/existing, the (kept) count, a preview, and a low-confidence hint. The
 * checkbox excludes/re-includes the WHOLE destination at once and shows an
 * indeterminate state when only some of its files are excluded.
 */
function PlanFolderRow({
	folder,
	folderIndex,
	excluded,
	editable,
	onToggleGroup,
}: {
	folder: PlanFolder;
	folderIndex: number;
	excluded: ReadonlySet<string>;
	editable: boolean;
	onToggleGroup: (
		folderIndex: number,
		folder: PlanFolder,
		allExcluded: boolean,
	) => void;
}) {
	const groupKeys = planGroupMoveKeys(folderIndex, folder);
	const excludedInGroup = groupKeys.reduce(
		(sum, key) => sum + (excluded.has(key) ? 1 : 0),
		0,
	);
	const allExcluded = excludedInGroup === groupKeys.length;
	const someExcluded = excludedInGroup > 0 && !allExcluded;
	const keptCount = groupKeys.length - excludedInGroup;
	const lowConfidenceCount = folder.lowConfidenceFiles?.length ?? 0;
	const preview = folder.files.slice(0, 2);
	const noun = folder.files.length === 1 ? "file" : "files";

	return (
		<li
			className={cn(
				"flex items-start gap-3 rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2",
				allExcluded && "opacity-60",
			)}
		>
			<input
				type="checkbox"
				checked={!allExcluded}
				disabled={!editable}
				ref={(el) => {
					if (el) el.indeterminate = someExcluded;
				}}
				onChange={() => onToggleGroup(folderIndex, folder, allExcluded)}
				aria-label={`Include the ${folder.files.length} ${noun} for ${folder.name}`}
				className="mt-0.5 size-4 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
				style={{ accentColor: "var(--lagoon-deep)" }}
			/>
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
						<span className={cn(allExcluded && "line-through")}>
							{folder.name}
						</span>
						<span className="ml-2 font-normal text-[10px] text-muted-foreground uppercase tracking-wide">
							{folder.isNew ? "new" : "existing"}
						</span>
					</p>
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{allExcluded
							? "excluded"
							: `${keptCount} ${keptCount === 1 ? "file" : "files"}`}
					</span>
				</div>
				<p className="truncate text-muted-foreground text-xs">
					{preview.join(" · ")}
					{folder.files.length > preview.length ? " · …" : ""}
				</p>
				{lowConfidenceCount > 0 ? (
					<p className="mt-1 inline-flex items-center gap-1 font-medium text-[11px] text-[color:var(--lagoon-deep)]">
						<CircleHelpIcon className="size-3" aria-hidden="true" />
						{lowConfidenceCount} to double-check
					</p>
				) : null}
			</div>
		</li>
	);
}

/** A clear, accessible flag for a move the model was less certain about (S4). */
function LowConfidenceFlag() {
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--chip-line)] bg-[color:var(--chip-bg)] px-1.5 py-0.5 font-medium text-[10px] text-[color:var(--lagoon-deep)]">
			<CircleHelpIcon className="size-3" aria-hidden="true" />
			Less certain
		</span>
	);
}

/**
 * The full move set for one destination: heading + every file as its own row
 * with a checkbox to exclude it, a low-confidence flag where the model was less
 * sure, and a clear "excluded" mark once it is left out.
 */
function FullMoveGroup({
	folder,
	folderIndex,
	excluded,
	editable,
	onToggleFile,
}: {
	folder: PlanFolder;
	folderIndex: number;
	excluded: ReadonlySet<string>;
	editable: boolean;
	onToggleFile: (key: string, isExcluded: boolean) => void;
}) {
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
				{folder.files.map((file, fileIndex) => {
					const key = planMoveKey(folderIndex, fileIndex);
					const isExcluded = excluded.has(key);
					const lowConfidence = isLowConfidenceMove(folder, file);
					return (
						<li key={key}>
							<label
								className={cn(
									"flex items-center gap-2 rounded px-1 py-0.5 text-xs",
									editable && "cursor-pointer hover:bg-[color:var(--chip-bg)]",
								)}
							>
								<input
									type="checkbox"
									checked={!isExcluded}
									disabled={!editable}
									onChange={() => onToggleFile(key, isExcluded)}
									aria-label={`Include ${file}`}
									className="size-3.5 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
									style={{ accentColor: "var(--lagoon-deep)" }}
								/>
								<span
									className={cn(
										"min-w-0 flex-1 truncate text-muted-foreground",
										isExcluded && "line-through",
									)}
									title={file}
								>
									{file}
								</span>
								{lowConfidence ? <LowConfidenceFlag /> : null}
								{isExcluded ? (
									<span className="shrink-0 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
										excluded
									</span>
								) : null}
							</label>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

type OutcomeTone = "success" | "danger" | "neutral" | "warning";

const OUTCOME_TONES: Record<OutcomeTone, string> = {
	success: "text-[color:var(--palm)]",
	danger: "text-destructive",
	neutral: "text-[color:var(--lagoon-deep)]",
	warning: "text-amber-600",
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

/**
 * A completed sort, with an undo control. The control is the UI half of the
 * engine's duplicate-undo guard (`undoControlPresentation`): available while the
 * sort is still undoable, and a disabled, reason-bearing terminal state once it
 * has been undone. Clicking it hands the whole result back to `onUndo`, which
 * builds and applies the honest undo outcome; a second undo is refused both here
 * (the disabled control) and in the handler.
 */
function ResultCard({
	message,
	onUndo,
	undone,
}: {
	message: ResultMessage;
	onUndo?: UndoResultHandler;
	undone?: boolean;
}) {
	const control = undoControlPresentation({ undone: Boolean(undone) });
	const reasonId = `result-undo-reason-${message.id}`;

	const runUndo = () => {
		// Mirror the engine's guard: a sort already undone can't be undone again.
		if (control.disabled) return;
		onUndo?.(message);
	};

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
			<div>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={runUndo}
					disabled={control.disabled}
					aria-describedby={control.reason ? reasonId : undefined}
				>
					<Undo2Icon aria-hidden="true" />
					{control.label}
				</Button>
				{control.reason ? (
					<p id={reasonId} className="mt-1.5 text-muted-foreground text-xs">
						{control.reason}
					</p>
				) : null}
			</div>
		</OutcomeCard>
	);
}

/** Every undo tone maps 1:1 onto a card tone (a "warning" tone was added for partial undos). */
const UNDO_TONE_TO_OUTCOME: Record<UndoTone, OutcomeTone> = {
	success: "success",
	warning: "warning",
	danger: "danger",
};

/** The header icon that matches each undo tone. */
const UNDO_TONE_ICONS: Record<UndoTone, React.ReactNode> = {
	success: <CheckCircle2Icon />,
	warning: <AlertTriangleIcon />,
	danger: <XCircleIcon />,
};

/**
 * The honest outcome of a completed undo. It presents whatever the engine really
 * did — COMPLETE, PARTIAL, or UNAVAILABLE, each visually distinct through its
 * tone — with every count and line derived from the per-item outcomes
 * (`undoPresentation` / `undoFileLine` / `undoFolderLine`), a per-file breakdown
 * splitting what was restored from what was left exactly in place (with the honest
 * reason and a safe next step), the per-folder outcomes, and the outcome's honest
 * safety guarantee. Path-free by construction: display names and opaque ids only.
 */
function UndoCard({ message }: { message: UndoMessage }) {
	const presentation = undoPresentation(message);
	const tone = UNDO_TONE_TO_OUTCOME[presentation.tone];
	const fileLines = message.files.map(undoFileLine);
	const folderLines = message.folders.map(undoFolderLine);
	const restoredLines = fileLines.filter((line) => line.status === "restored");
	const leftLines = fileLines.filter((line) => line.status === "left");

	return (
		<OutcomeCard
			tone={tone}
			icon={UNDO_TONE_ICONS[presentation.tone]}
			title={presentation.title}
			label={messageAccessibleLabel(message)}
		>
			<p className="text-sm text-foreground/80">{presentation.summary}</p>
			{fileLines.length > 0 ? (
				<OutcomeStats
					stats={[
						{ value: presentation.restoredCount, label: "files restored" },
						{ value: presentation.leftInPlaceCount, label: "left in place" },
						{
							value: presentation.removedFolderCount,
							label: "folders removed",
						},
					]}
				/>
			) : null}
			{restoredLines.length > 0 ? (
				<UndoFileGroup
					title="Restored to where they were"
					tone="success"
					icon={<CheckCircle2Icon className="size-3.5" />}
					lines={restoredLines}
				/>
			) : null}
			{leftLines.length > 0 ? (
				<UndoFileGroup
					title="Left exactly where they are"
					tone="warning"
					icon={<AlertTriangleIcon className="size-3.5" />}
					lines={leftLines}
				/>
			) : null}
			{folderLines.length > 0 ? <UndoFolderList lines={folderLines} /> : null}
			<p className="border-border border-t pt-3 text-muted-foreground text-xs">
				{presentation.guarantee}
			</p>
		</OutcomeCard>
	);
}

/**
 * One outcome group of the per-file undo breakdown — either the files restored to
 * where they were, or the files left exactly in place — as a labelled semantic
 * list. Each row states the file's honest explanation and, when it was left, the
 * safe next step. Text (not colour alone) carries the outcome.
 */
function UndoFileGroup({
	title,
	tone,
	icon,
	lines,
}: {
	title: string;
	tone: OutcomeTone;
	icon: React.ReactNode;
	lines: readonly UndoFileLine[];
}) {
	return (
		<section aria-label={title}>
			<h4 className="flex items-center gap-1.5 font-semibold text-foreground text-xs">
				<span
					className={cn("shrink-0", OUTCOME_TONES[tone])}
					aria-hidden="true"
				>
					{icon}
				</span>
				{title}
				<span className="ml-auto font-normal text-muted-foreground tabular-nums">
					{lines.length}
				</span>
			</h4>
			<ul className="mt-1.5 space-y-1.5">
				{lines.map((line) => (
					<li
						key={line.itemId}
						className="rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2"
					>
						<p className="flex min-w-0 items-center gap-1.5 font-medium text-foreground text-sm">
							<span
								className="shrink-0 text-muted-foreground"
								aria-hidden="true"
							>
								<FileIcon className="size-3.5" />
							</span>
							<span className="truncate" title={line.name}>
								{line.name}
							</span>
						</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							{line.explanation}
						</p>
						{line.nextAction ? (
							<p className="mt-1 inline-flex items-start gap-1 font-medium text-[color:var(--lagoon-deep)] text-xs">
								<span className="mt-0.5 shrink-0" aria-hidden="true">
									<ShieldCheckIcon className="size-3" />
								</span>
								{line.nextAction}
							</p>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}

/** The per-folder undo outcomes: each folder Untie removed or kept, and why. */
function UndoFolderList({ lines }: { lines: readonly UndoFolderLine[] }) {
	return (
		<section aria-label="Folders">
			<h4 className="flex items-center gap-1.5 font-semibold text-foreground text-xs">
				<span className="shrink-0 text-[color:var(--palm)]" aria-hidden="true">
					<FolderIcon className="size-3.5" />
				</span>
				Folders
				<span className="ml-auto font-normal text-muted-foreground tabular-nums">
					{lines.length}
				</span>
			</h4>
			<ul className="mt-1.5 space-y-1.5">
				{lines.map((line) => (
					<li
						key={line.folderId}
						className="rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2"
					>
						<div className="flex items-baseline justify-between gap-2">
							<p className="min-w-0 truncate font-medium text-foreground text-sm">
								<span title={line.name}>{line.name}</span>
							</p>
							<span className="shrink-0 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
								{line.status === "removed" ? "removed" : "kept"}
							</span>
						</div>
						<p className="mt-0.5 text-muted-foreground text-xs">
							{line.explanation}
						</p>
					</li>
				))}
			</ul>
		</section>
	);
}
