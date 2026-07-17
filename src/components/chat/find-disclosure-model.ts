// Per-request find disclosure model (F9, PRD §8 "Per-request disclosure").
//
// Before a find request's shortlist is transmitted to the ranking model, the UI
// must state exactly what leaves the device — e.g. "This will send 12 filenames
// and content snippets from 9 documents to the AI to rank your results." To make
// that statement provably honest, this model derives every number from the EXACT
// outbound payload the request would send, by reusing the ranking prompt builder
// (`buildFindShortlistMessages` in server/llm/find-shortlist). The payload size is
// measured on the finalized outbound messages, so the counts shown here can never
// drift from the counts sent. This is the find-side twin of the sort disclosure
// (S3 — see sort-disclosure-model.ts), mirroring it file-for-file.
//
// Filenames are sensitive (PRD §8) — they can reveal health, legal, and financial
// matters. This model therefore exposes counts and categories only: it never
// returns a display name, a content snippet, or a filesystem path. The candidate
// `displayName`/`snippet` values live in the request purely because they ARE the
// outbound payload the size is measured on; the disclosure UI must never render
// them.
//
// `buildFindShortlistMessages` is a pure function (no Electron, no Node, no
// server-only APIs — it only runs JSON.stringify plus string escaping), so
// importing it into the renderer keeps the disclosed size and the transmitted
// size one source of truth without dragging any server/main-process code into the
// client bundle.

import { buildFindShortlistMessages } from "#/server/llm/find-shortlist/prompt";
import type {
	FindShortlistCandidate,
	RankFindShortlistInput,
} from "#/server/llm/find-shortlist/types";

export type { RankFindShortlistInput };

/**
 * One candidate in a find shortlist, as the disclosure sees it: the exact
 * outbound record (`candidate`) plus a human-readable `category` used ONLY to
 * group the exclusion controls. The category is a UI label; it is never
 * transmitted, and `candidate.displayName`/`candidate.snippet` are never rendered.
 */
export interface FindDisclosureCandidate {
	readonly candidate: FindShortlistCandidate;
	readonly category: string;
}

/** The full shortlist the disclosure gate describes before sending. */
export interface FindDisclosureRequest {
	/** Display label for the search (e.g. "Downloads") — never a path. */
	readonly searchLabel: string;
	/** The user's raw search query text, transmitted so the model can rank. */
	readonly query: string;
	/** Search terms extracted from the query, transmitted alongside it. */
	readonly searchTerms: readonly string[];
	/** Every candidate, each tagged with a UI category for exclusion. */
	readonly candidates: readonly FindDisclosureCandidate[];
}

/** The candidates the user has NOT excluded, in request order. */
export function includedCandidates(
	request: FindDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): FindDisclosureCandidate[] {
	return request.candidates.filter(
		(item) => !excludedIds.has(item.candidate.itemId),
	);
}

/**
 * The exact `RankFindShortlistInput` the request would transmit given the current
 * exclusions. Confirming the disclosure hands this same value onward, so what is
 * disclosed and what is sent are, by construction, identical.
 */
export function buildFindDisclosureInput(
	request: FindDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): RankFindShortlistInput {
	return {
		query: {
			searchTerms: [...request.searchTerms],
			query: request.query,
		},
		candidates: includedCandidates(request, excludedIds).map(
			(item) => item.candidate,
		),
	};
}

/** Counts and sizes for the payload that would actually be sent (counts only). */
export interface FindDisclosureManifest {
	/** Filenames sent — one per candidate, since each carries a displayName. */
	readonly filenameCount: number;
	/** Candidates whose non-empty content snippet would be sent. */
	readonly snippetCount: number;
	/** Documents contributing a content snippet (equals snippetCount). */
	readonly documentCount: number;
	/** Opaque item IDs sent — one per candidate. */
	readonly opaqueIdCount: number;
	/** Search terms sent alongside the query. */
	readonly searchTermCount: number;
	readonly messageCount: number;
	/** Byte length of the exact serialized outbound messages. */
	readonly totalPayloadBytes: number;
}

/** The manifest for a finalized outbound ranking input, measured on its messages. */
function manifestFromInput(
	input: RankFindShortlistInput,
): FindDisclosureManifest {
	const snippetCount = input.candidates.filter(
		(candidate) => candidate.snippet.length > 0,
	).length;
	// The exact outbound messages, serialized exactly as they would be sent, so
	// the disclosed size equals the sent size byte-for-byte.
	const messages = buildFindShortlistMessages(input);
	return {
		filenameCount: input.candidates.length,
		snippetCount,
		documentCount: snippetCount,
		opaqueIdCount: input.candidates.length,
		searchTermCount: input.query.searchTerms.length,
		messageCount: messages.length,
		totalPayloadBytes: messages.reduce(
			(total, message) =>
				total + new TextEncoder().encode(message.content).byteLength,
			0,
		),
	};
}

/**
 * The manifest for the payload that would actually be sent for the current
 * exclusions. Derived from the finalized outbound messages, so its counts equal
 * the transmitted counts.
 */
export function computeFindDisclosureManifest(
	request: FindDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): FindDisclosureManifest {
	return manifestFromInput(buildFindDisclosureInput(request, excludedIds));
}

/** A category the user can include or exclude as a group, with live counts. */
export interface FindDisclosureCategory {
	readonly category: string;
	/** Opaque item IDs in this category; toggling flips all of them at once. */
	readonly ids: readonly string[];
	readonly fileCount: number;
	/** Candidates in this category whose content snippet would be sent. */
	readonly documentCount: number;
	readonly includedCount: number;
	/** True when every candidate in the category is currently excluded. */
	readonly excluded: boolean;
}

/**
 * Group the request's candidates by category, in first-seen order, with live
 * counts.
 */
export function findDisclosureCategories(
	request: FindDisclosureRequest,
	excludedIds: ReadonlySet<string>,
): FindDisclosureCategory[] {
	const order: string[] = [];
	const groups = new Map<string, FindDisclosureCandidate[]>();
	for (const item of request.candidates) {
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
			(item) => !excludedIds.has(item.candidate.itemId),
		).length;
		return {
			category,
			ids: items.map((item) => item.candidate.itemId),
			fileCount: items.length,
			documentCount: items.filter((item) => item.candidate.snippet.length > 0)
				.length,
			includedCount,
			excluded: includedCount === 0,
		};
	});
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The headline disclosure sentence (PRD §8 phrasing), assembled from the manifest
 * counts. Clauses appear only when the corresponding data is present, so excluding
 * every candidate with a snippet drops the "content snippets" clause automatically.
 */
export function findDisclosureHeadline(
	manifest: FindDisclosureManifest,
): string {
	if (manifest.filenameCount === 0) {
		return "Nothing will be sent — every candidate is excluded.";
	}
	let sentence = `This will send ${countLabel(manifest.filenameCount, "filename")}`;
	if (manifest.documentCount > 0) {
		sentence += ` and content snippets from ${countLabel(
			manifest.documentCount,
			"document",
		)}`;
	}
	return `${sentence} to the AI to rank your results.`;
}

/** A single itemized line in the disclosure breakdown (counts/categories only). */
export interface FindDisclosureLine {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
}

/**
 * The itemized breakdown shown beneath the headline. Every number comes from the
 * manifest; no filenames or snippets appear. Lines are omitted when their category
 * of data is not present in the payload.
 */
export function findDisclosureBreakdown(
	manifest: FindDisclosureManifest,
): FindDisclosureLine[] {
	const lines: FindDisclosureLine[] = [
		{
			id: "filenames",
			label: countLabel(manifest.filenameCount, "filename"),
			detail: "each paired with an opaque ID — never a folder path",
		},
	];
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
		id: "query",
		label: "1 search query",
		detail: "the words you typed, so the AI can rank matches",
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
