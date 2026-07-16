// Per-request sort disclosure model (S3, PRD §8 "Per-request disclosure").
//
// Before a sort request is transmitted, the UI must state exactly what leaves
// the device — e.g. "This will send 84 filenames + metadata and content
// snippets from 12 documents to the AI." To make that statement provably honest,
// this model derives every number from the EXACT outbound payload the request
// would send, by reusing the S2 request-data manifest builder
// (`buildSortPlanRequest` in server/llm/sort-plan). The manifest is computed from
// the finalized message payload, so the counts shown here can never drift from
// the counts sent.
//
// Filenames are sensitive (PRD §8) — they can reveal health, legal, and
// financial matters. This model therefore exposes counts and categories only:
// it never returns a display name or a filesystem path. The `file.displayName`
// values live in the request purely because they ARE the outbound payload the
// manifest measures; the disclosure UI must never render them.
//
// `buildSortPlanRequest` is a pure function (no Electron, no Node, no server-only
// APIs — it only pulls in the sort-plan schema/errors), so importing it into the
// renderer keeps the disclosed counts and the transmitted counts one source of
// truth without dragging any server/main-process code into the client bundle.

import { buildSortPlanRequest } from "#/server/llm/sort-plan/prompt";
import type {
	GenerateSortPlanInput,
	SortPlanFileContext,
	SortPlanMetadataField,
	SortPlanRequestDataManifest,
} from "#/server/llm/sort-plan/types";

export type { GenerateSortPlanInput, SortPlanRequestDataManifest };

/**
 * One candidate file in a sort request, as the disclosure sees it: the exact
 * outbound record (`file`) plus a human-readable `category` used ONLY to group
 * the exclusion controls. The category is a UI label; it is never transmitted,
 * and `file.displayName` is never rendered.
 */
export interface SortDisclosureItem {
	readonly file: SortPlanFileContext;
	readonly category: string;
}

/** The full candidate request the disclosure gate describes before sending. */
export interface SortDisclosureRequest {
	/** Display label for the source location (e.g. "Downloads") — never a path. */
	readonly locationLabel: string;
	/** Existing folder names the AI may reuse as destinations. */
	readonly candidateDestinationNames: readonly string[];
	/** Every candidate file, each tagged with a UI category for exclusion. */
	readonly items: readonly SortDisclosureItem[];
}

/** The candidate files the user has NOT excluded, in request order. */
export function includedItems(
	request: SortDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): SortDisclosureItem[] {
	return request.items.filter((item) => !excludedIds.has(item.file.id));
}

/**
 * The exact `GenerateSortPlanInput` the request would transmit given the current
 * exclusions. Confirming the disclosure hands this same value onward, so what is
 * disclosed and what is sent are, by construction, identical.
 */
export function buildDisclosureInput(
	request: SortDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): GenerateSortPlanInput {
	return {
		files: includedItems(request, excludedIds).map((item) => item.file),
		candidateDestinationNames: [...request.candidateDestinationNames],
	};
}

/**
 * The S2 manifest for the payload that would actually be sent. Derived from the
 * finalized outbound messages, so its counts equal the transmitted counts.
 */
export function computeDisclosureManifest(
	request: SortDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): SortPlanRequestDataManifest {
	return buildSortPlanRequest(buildDisclosureInput(request, excludedIds))
		.manifest;
}

/** A category the user can include or exclude as a group, with live counts. */
export interface SortDisclosureCategory {
	readonly category: string;
	/** Opaque file IDs in this category; toggling flips all of them at once. */
	readonly ids: readonly string[];
	readonly fileCount: number;
	/** Files in this category whose content snippet would be sent. */
	readonly documentCount: number;
	readonly includedCount: number;
	/** True when every file in the category is currently excluded. */
	readonly excluded: boolean;
}

/** Group the request's items by category, in first-seen order, with live counts. */
export function disclosureCategories(
	request: SortDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): SortDisclosureCategory[] {
	const order: string[] = [];
	const groups = new Map<string, SortDisclosureItem[]>();
	for (const item of request.items) {
		const bucket = groups.get(item.category);
		if (bucket) {
			bucket.push(item);
		} else {
			order.push(item.category);
			groups.set(item.category, [item]);
		}
	}
	return order.map((category) => {
		const items = groups.get(category) ?? [];
		const includedCount = items.filter(
			(item) => !excludedIds.has(item.file.id),
		).length;
		return {
			category,
			ids: items.map((item) => item.file.id),
			fileCount: items.length,
			documentCount: items.filter((item) => item.file.excerpt !== undefined)
				.length,
			includedCount,
			excluded: includedCount === 0,
		};
	});
}

const METADATA_FIELD_LABELS: Record<SortPlanMetadataField, string> = {
	extension: "file type",
	sizeBytes: "size",
	modifiedAt: "last-modified date",
};

/** Human-readable labels for the metadata fields present in the payload. */
export function metadataFieldLabels(
	manifest: SortPlanRequestDataManifest,
): string[] {
	return manifest.metadata.fields.map((field) => METADATA_FIELD_LABELS[field]);
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The headline disclosure sentence (PRD §8 phrasing), assembled from the
 * manifest counts. Clauses appear only when the corresponding data is present,
 * so excluding all documents drops the "content snippets" clause automatically.
 */
export function disclosureHeadline(
	manifest: SortPlanRequestDataManifest,
): string {
	if (manifest.filenameCount === 0) {
		return "Nothing will be sent — every file is excluded.";
	}
	let sentence = `This will send ${countLabel(manifest.filenameCount, "filename")}`;
	if (manifest.metadata.fields.length > 0) {
		sentence += " + metadata";
	}
	if (manifest.documentCount > 0) {
		sentence += ` and content snippets from ${countLabel(
			manifest.documentCount,
			"document",
		)}`;
	}
	return `${sentence} to the AI.`;
}

/** A single itemized line in the disclosure breakdown (counts/categories only). */
export interface DisclosureLine {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
}

/**
 * The itemized breakdown shown beneath the headline. Every number comes from the
 * manifest; no filenames or paths appear. Lines are omitted when their category
 * of data is not present in the payload.
 */
export function disclosureBreakdown(
	manifest: SortPlanRequestDataManifest,
): DisclosureLine[] {
	const lines: DisclosureLine[] = [
		{
			id: "filenames",
			label: countLabel(manifest.filenameCount, "filename"),
			detail: "each paired with an opaque ID — never a folder path",
		},
	];
	if (manifest.metadata.valueCount > 0) {
		lines.push({
			id: "metadata",
			label: countLabel(manifest.metadata.valueCount, "metadata value"),
			detail: metadataFieldLabels(manifest).join(", "),
		});
	}
	if (manifest.documentCount > 0) {
		lines.push({
			id: "snippets",
			label: `content snippets from ${countLabel(
				manifest.documentCount,
				"document",
			)}`,
			detail: "short text excerpts, not whole files",
		});
	}
	lines.push({
		id: "destinations",
		label: countLabel(
			manifest.candidateDestinationNameCount,
			"candidate folder name",
		),
		detail: "existing folders the AI may reuse",
	});
	return lines;
}

/** Compact human-readable size for the total outbound payload. */
export function formatPayloadSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}
