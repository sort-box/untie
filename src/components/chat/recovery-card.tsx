import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	ClockIcon,
	FileIcon,
	FolderIcon,
	ShieldCheckIcon,
	SparklesIcon,
	Undo2Icon,
} from "lucide-react";

import { cn } from "#/lib/utils";
import {
	type OperationDisposition,
	type OperationPresentation,
	type RecoveryBatchSummary,
	type RecoveryTone,
	recoveryAccessibleLabel,
	recoveryPresentation,
} from "./recovery-model";

/**
 * The crash-recovery / needs_attention card (S9).
 *
 * When Untie reopens after a crash, some sort batches may be left needing the
 * user's attention. This card renders one recovered batch's presentation (from
 * `recovery-model.ts`): a headline, a plain-language explanation of the cause,
 * every operation classified as completed / pending / conflicted, the honest
 * safety guarantee, and the safe next actions for the cause. Conflicted
 * operations state honestly what happened and what the user can safely do next —
 * never a destructive suggestion.
 *
 * Like every other chat card it shows COUNTS and DISPLAY NAMES only — never a
 * filesystem path (PRD §8). It mirrors the accessibility conventions of the plan,
 * result, and disclosure cards: a titled, described region with an accessible
 * label, semantic lists for the operations and next actions, and text (not colour
 * alone) to convey each operation's disposition.
 */
export interface RecoveryCardProps {
	readonly summary: RecoveryBatchSummary;
}

const TONE_META: Record<
	RecoveryTone,
	{ icon: React.ReactNode; className: string; kicker: string }
> = {
	positive: {
		icon: <CheckCircle2Icon className="size-4" />,
		className: "text-[color:var(--palm)]",
		kicker: "After a restart · recovered",
	},
	neutral: {
		icon: <Undo2Icon className="size-4" />,
		className: "text-[color:var(--lagoon-deep)]",
		kicker: "After a restart · undone",
	},
	attention: {
		icon: <AlertTriangleIcon className="size-4" />,
		className: "text-destructive",
		kicker: "After a restart · needs attention",
	},
};

const DISPOSITION_META: Record<
	OperationDisposition,
	{ label: string; icon: React.ReactNode; className: string }
> = {
	conflicted: {
		label: "Needs your attention",
		icon: <AlertTriangleIcon className="size-3.5" />,
		className: "text-destructive",
	},
	completed: {
		label: "Completed",
		icon: <CheckCircle2Icon className="size-3.5" />,
		className: "text-[color:var(--palm)]",
	},
	pending: {
		label: "Not started",
		icon: <ClockIcon className="size-3.5" />,
		className: "text-muted-foreground",
	},
};

// Conflicted first (most important), then completed, then the untouched steps.
const DISPOSITION_ORDER: readonly OperationDisposition[] = [
	"conflicted",
	"completed",
	"pending",
];

export function RecoveryCard({ summary }: RecoveryCardProps) {
	const presentation = recoveryPresentation(summary);
	const tone = TONE_META[presentation.tone];

	const titleId = `recovery-title-${summary.batchId}`;
	const explanationId = `recovery-explanation-${summary.batchId}`;
	const actionsId = `recovery-actions-${summary.batchId}`;

	return (
		<article
			className="flex gap-3"
			aria-label={recoveryAccessibleLabel(summary)}
		>
			<AssistantAvatar />
			<section
				aria-labelledby={titleId}
				aria-describedby={explanationId}
				className="island-shell flex-1 rounded-2xl border border-border p-4"
			>
				<header className="flex items-start gap-3">
					<span
						className={cn(
							"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--sand)]",
							tone.className,
						)}
						aria-hidden="true"
					>
						{tone.icon}
					</span>
					<div className="min-w-0">
						<p className="island-kicker">{tone.kicker}</p>
						<h3
							id={titleId}
							className="display-title mt-1 font-semibold text-foreground text-lg"
						>
							{presentation.headline}
						</h3>
						<p className="mt-0.5 text-muted-foreground text-xs">
							in {summary.locationLabel}
						</p>
					</div>
				</header>

				<p id={explanationId} className="mt-3 text-foreground/80 text-sm">
					{presentation.explanation}
				</p>

				<RecoveryCounts counts={presentation.counts} />

				{DISPOSITION_ORDER.map((disposition) => {
					const group = presentation.operations.filter(
						(operation) => operation.disposition === disposition,
					);
					if (group.length === 0) return null;
					return (
						<OperationGroup
							key={disposition}
							disposition={disposition}
							operations={group}
						/>
					);
				})}

				<section className="mt-4" aria-labelledby={actionsId}>
					<h4 id={actionsId} className="font-semibold text-foreground text-xs">
						What you can safely do next
					</h4>
					<ul className="mt-2 space-y-1.5">
						{presentation.nextActions.map((action) => (
							<li
								key={action}
								className="flex items-start gap-2 rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2 text-foreground/80 text-sm"
							>
								<span
									className="mt-0.5 shrink-0 text-[color:var(--lagoon-deep)]"
									aria-hidden="true"
								>
									<ShieldCheckIcon className="size-3.5" />
								</span>
								<span>{action}</span>
							</li>
						))}
					</ul>
				</section>

				<footer className="mt-4 border-border border-t pt-3">
					<p className="text-muted-foreground text-xs">
						{presentation.guarantee}
					</p>
				</footer>
			</section>
		</article>
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

/** The completed / not-started / needs-attention tallies, derived from the model. */
function RecoveryCounts({
	counts,
}: {
	counts: { completed: number; pending: number; conflicted: number };
}) {
	const stats: ReadonlyArray<{ value: number; label: string }> = [
		{ value: counts.completed, label: "completed" },
		{ value: counts.pending, label: "not started" },
		{ value: counts.conflicted, label: "need attention" },
	];
	return (
		<dl className="mt-3 flex gap-6">
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

/** One disposition's operations, as a labelled semantic list. */
function OperationGroup({
	disposition,
	operations,
}: {
	disposition: OperationDisposition;
	operations: readonly OperationPresentation[];
}) {
	const meta = DISPOSITION_META[disposition];
	return (
		<section className="mt-4" aria-label={meta.label}>
			<h4 className="flex items-center gap-1.5 font-semibold text-foreground text-xs">
				<span className={cn("shrink-0", meta.className)} aria-hidden="true">
					{meta.icon}
				</span>
				{meta.label}
				<span className="ml-auto font-normal text-muted-foreground tabular-nums">
					{operations.length}
				</span>
			</h4>
			<ul className="mt-1.5 space-y-1.5">
				{operations.map((operation) => (
					<OperationRow key={operation.id} operation={operation} />
				))}
			</ul>
		</section>
	);
}

/** A single operation: its name, what happened, and any safe next action. */
function OperationRow({ operation }: { operation: OperationPresentation }) {
	const conflicted = operation.disposition === "conflicted";
	return (
		<li
			className={cn(
				"rounded-lg border px-3 py-2",
				conflicted
					? "border-destructive/40 bg-destructive/5"
					: "border-border/70 bg-[color:var(--chip-bg)]",
			)}
		>
			<div className="flex items-baseline justify-between gap-2">
				<p className="flex min-w-0 items-center gap-1.5 font-medium text-foreground text-sm">
					<span
						className="shrink-0 text-muted-foreground"
						aria-hidden="true"
						title={operation.kind === "folder" ? "Folder" : "File"}
					>
						{operation.kind === "folder" ? (
							<FolderIcon className="size-3.5" />
						) : (
							<FileIcon className="size-3.5" />
						)}
					</span>
					<span className="truncate" title={operation.name}>
						{operation.name}
					</span>
				</p>
				<span
					className={cn(
						"shrink-0 font-medium text-[11px]",
						conflicted ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{operation.status}
				</span>
			</div>
			<p className="mt-0.5 text-muted-foreground text-xs">{operation.detail}</p>
			{operation.safeNextAction ? (
				<p className="mt-1 inline-flex items-start gap-1 font-medium text-[color:var(--lagoon-deep)] text-xs">
					<span className="mt-0.5 shrink-0" aria-hidden="true">
						<ShieldCheckIcon className="size-3" />
					</span>
					{operation.safeNextAction}
				</p>
			) : null}
		</li>
	);
}
