import { CheckIcon, CircleHelpIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "#/components/ui/button";
import {
	planAcknowledgmentCopy,
	planLowConfidenceMoves,
} from "./approval-orchestration";
import { type PlanMessage, planApprovalCopy } from "./message-model";

/**
 * The risk acknowledgment gate (S6), rendered when approving a plan that still
 * contains low-confidence moves (S4). It mirrors the S3 pre-send disclosure
 * gate's structure and accessibility: a labelled section with a live headline,
 * an itemized list of exactly what needs a second look, the exact-counts
 * mutation copy, and an explicit confirm/cancel. Nothing is applied until the
 * user ticks the acknowledgment and confirms — the confirm control stays
 * disabled until then, so the acknowledgment is genuinely explicit.
 *
 * Everything shown is derived from the SAME trimmed snapshot that would be
 * applied, so the flagged files, the counts, and the mutation copy can never
 * disagree with what actually happens. Display names only — never a path.
 */
export interface RiskAcknowledgmentProps {
	/** The trimmed snapshot the user approved and is being asked to confirm. */
	readonly snapshot: PlanMessage;
	/** Confirm: proceed to submit the acknowledged snapshot. */
	readonly onConfirm: () => void;
	/** Cancel: dismiss the gate without submitting anything. */
	readonly onCancel: () => void;
}

export function RiskAcknowledgment({
	snapshot,
	onConfirm,
	onCancel,
}: RiskAcknowledgmentProps) {
	// The acknowledgment must be explicit: the user ticks this before confirm
	// becomes available, mirroring the deliberate action the S3 gate requires.
	const [acknowledged, setAcknowledged] = useState(false);
	const titleId = useId();
	const headlineId = useId();
	const checkboxId = useId();

	// Both derived from the trimmed snapshot's own data, so they always match the
	// moves listed below and the plan that would be applied.
	const moves = planLowConfidenceMoves(snapshot.folders);
	const headline = planAcknowledgmentCopy(snapshot.folders);

	return (
		<section
			aria-labelledby={titleId}
			aria-describedby={headlineId}
			className="island-shell rise-in rounded-2xl border border-[color:var(--chip-line)] p-4"
		>
			<header className="flex items-start gap-3">
				<span
					className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--sand)] text-[color:var(--lagoon-deep)]"
					aria-hidden="true"
				>
					<CircleHelpIcon className="size-4" />
				</span>
				<div className="min-w-0">
					<p className="island-kicker">Before sorting · double-check</p>
					<h3
						id={titleId}
						className="display-title mt-1 font-semibold text-foreground text-lg"
					>
						Confirm the less-confident moves
					</h3>
				</div>
			</header>

			<p
				id={headlineId}
				aria-live="polite"
				className="mt-3 font-medium text-foreground text-sm"
			>
				{headline}
			</p>

			<ul
				className="mt-3 space-y-1.5"
				aria-label="Moves the model was less certain about"
			>
				{moves.map((move) => (
					<li
						key={`${move.destination}:${move.file}`}
						className="flex items-start gap-2 rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2"
					>
						<span
							className="mt-0.5 shrink-0 text-[color:var(--lagoon-deep)]"
							aria-hidden="true"
						>
							<CircleHelpIcon className="size-3.5" />
						</span>
						<span className="min-w-0 text-sm">
							<span className="font-medium text-foreground">{move.file}</span>
							<span className="text-muted-foreground">
								{" "}
								→ {move.destination}
							</span>
						</span>
					</li>
				))}
			</ul>

			<p className="mt-4 font-medium text-foreground text-sm">
				{planApprovalCopy(snapshot.folders)}
			</p>

			<label
				htmlFor={checkboxId}
				className="mt-3 flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2 text-sm"
			>
				<input
					id={checkboxId}
					type="checkbox"
					checked={acknowledged}
					onChange={() => setAcknowledged((prev) => !prev)}
					className="size-4 shrink-0"
					style={{ accentColor: "var(--lagoon-deep)" }}
				/>
				<span className="min-w-0 flex-1 font-medium text-foreground">
					I've reviewed the flagged moves and want to go ahead.
				</span>
			</label>

			<footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-border border-t pt-3">
				<p className="max-w-xs text-muted-foreground text-xs">
					You can still untick any of these in the plan above to leave them
					where they are.
				</p>
				<div className="flex shrink-0 gap-2">
					<Button type="button" variant="outline" size="sm" onClick={onCancel}>
						<XIcon aria-hidden="true" />
						Go back
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={onConfirm}
						disabled={!acknowledged}
						aria-describedby={headlineId}
					>
						<CheckIcon aria-hidden="true" />
						Acknowledge & sort
					</Button>
				</div>
			</footer>
		</section>
	);
}
