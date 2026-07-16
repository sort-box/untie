import { SendIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "#/components/ui/button";
import {
	buildDisclosureInput,
	computeDisclosureManifest,
	disclosureBreakdown,
	disclosureCategories,
	disclosureHeadline,
	formatPayloadSize,
	type GenerateSortPlanInput,
	type SortDisclosureRequest,
} from "./sort-disclosure-model";

/**
 * The per-request sort disclosure gate (S3, PRD §8).
 *
 * Before any sort request is transmitted, this panel states exactly what would
 * leave the device — filename, metadata, content-snippet and candidate-folder
 * counts, all derived from the S2 manifest of the precise outbound payload, so
 * the numbers shown equal the numbers sent. The user can CONFIRM (send) or
 * CANCEL (nothing is sent). Excluding a category updates the counts live to
 * match what would actually be transmitted; when everything is excluded, sending
 * is blocked. Filenames are sensitive (PRD §8), so the panel renders counts and
 * categories only — never a display name or filesystem path.
 */
export interface SortDisclosureProps {
	readonly request: SortDisclosureRequest;
	/** Send: receives the exact payload the disclosed counts describe. */
	readonly onConfirm: (input: GenerateSortPlanInput) => void;
	/** Cancel: nothing is transmitted. */
	readonly onCancel: () => void;
}

const TITLE_ID = "sort-disclosure-title";
const HEADLINE_ID = "sort-disclosure-headline";

export function SortDisclosure({
	request,
	onConfirm,
	onCancel,
}: SortDisclosureProps) {
	const [excludedIds, setExcludedIds] = useState<ReadonlySet<string>>(
		() => new Set<string>(),
	);

	// Every count comes from the manifest of the exact payload that would be
	// sent for the current exclusion set — never hardcoded — so the disclosure
	// can never disagree with what leaves the device.
	const manifest = useMemo(
		() => computeDisclosureManifest(request, excludedIds),
		[request, excludedIds],
	);
	const categories = useMemo(
		() => disclosureCategories(request, excludedIds),
		[request, excludedIds],
	);
	const breakdown = useMemo(() => disclosureBreakdown(manifest), [manifest]);

	const nothingToSend = manifest.filenameCount === 0;

	const toggleCategory = (ids: readonly string[], excluded: boolean) => {
		setExcludedIds((prev) => {
			const next = new Set(prev);
			for (const id of ids) {
				if (excluded) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	};

	return (
		<section
			aria-labelledby={TITLE_ID}
			aria-describedby={HEADLINE_ID}
			className="island-shell rise-in rounded-2xl border border-[color:var(--chip-line)] p-4"
		>
			<header className="flex items-start gap-3">
				<span
					className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--sand)] text-[color:var(--palm)]"
					aria-hidden="true"
				>
					<ShieldCheckIcon className="size-4" />
				</span>
				<div className="min-w-0">
					<p className="island-kicker">Before sending · privacy</p>
					<h3
						id={TITLE_ID}
						className="display-title mt-1 font-semibold text-foreground text-lg"
					>
						Review what leaves your device
					</h3>
				</div>
			</header>

			<p
				id={HEADLINE_ID}
				aria-live="polite"
				className="mt-3 font-medium text-foreground text-sm"
			>
				{disclosureHeadline(manifest)}
			</p>

			<ul
				className="mt-3 space-y-1.5"
				aria-label="What Untie will send to the AI"
			>
				{breakdown.map((line) => (
					<li
						key={line.id}
						className="rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2"
					>
						<p className="font-medium text-foreground text-sm tabular-nums">
							{line.label}
						</p>
						{line.detail ? (
							<p className="text-muted-foreground text-xs">{line.detail}</p>
						) : null}
					</li>
				))}
			</ul>

			<section
				className="mt-4"
				aria-label="Exclude categories from this request"
			>
				<h4 className="font-semibold text-foreground text-xs">
					Exclude anything you'd rather not send from {request.locationLabel}
				</h4>
				<ul className="mt-2 space-y-1.5">
					{categories.map((category) => (
						<li key={category.category}>
							<label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 bg-[color:var(--chip-bg)] px-3 py-2 text-sm">
								<input
									type="checkbox"
									checked={!category.excluded}
									onChange={() =>
										toggleCategory(category.ids, category.excluded)
									}
									className="size-4 shrink-0"
									style={{ accentColor: "var(--lagoon-deep)" }}
								/>
								<span className="min-w-0 flex-1 truncate font-medium text-foreground">
									{category.category}
								</span>
								<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
									{category.fileCount}{" "}
									{category.fileCount === 1 ? "file" : "files"}
									{category.documentCount > 0
										? ` · ${category.documentCount} with content`
										: ""}
								</span>
							</label>
						</li>
					))}
				</ul>
			</section>

			<footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-border border-t pt-3">
				<p className="max-w-xs text-muted-foreground text-xs">
					Your files and the full index stay on your Mac.{" "}
					<span className="tabular-nums">
						{formatPayloadSize(manifest.totalPayloadBytes)}
					</span>{" "}
					total leaves the device.
				</p>
				<div className="flex shrink-0 gap-2">
					<Button type="button" variant="outline" size="sm" onClick={onCancel}>
						<XIcon aria-hidden="true" />
						Cancel
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={() =>
							onConfirm(buildDisclosureInput(request, excludedIds))
						}
						disabled={nothingToSend}
						aria-describedby={HEADLINE_ID}
					>
						<SendIcon aria-hidden="true" />
						Send to AI
					</Button>
				</div>
			</footer>
		</section>
	);
}
