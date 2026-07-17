import { LlmConfigurationError, LlmStructuredOutputError } from "../errors";
import type { JsonSchema } from "../types";
import type {
	FindShortlistCandidate,
	FindShortlistModelOutput,
	RankFindShortlistInput,
} from "./types";

export const FIND_SHORTLIST_MAX_CANDIDATES = 50;
export const FIND_SHORTLIST_MAX_SNIPPET_LENGTH = 2_000;
const MAX_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 512;
const MAX_QUERY_LENGTH = 500;
const MAX_SEARCH_TERMS = 12;
const MAX_SEARCH_TERM_LENGTH = 100;
const MAX_MATCH_REASON_LENGTH = 240;

export const FIND_SHORTLIST_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		selections: {
			type: "array",
			maxItems: FIND_SHORTLIST_MAX_CANDIDATES,
			items: {
				type: "object",
				properties: {
					itemId: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
					matchReason: {
						type: "string",
						minLength: 1,
						maxLength: MAX_MATCH_REASON_LENGTH,
					},
					confidence: { enum: ["high", "medium", "low"] },
				},
				required: ["itemId", "matchReason", "confidence"],
				additionalProperties: false,
			},
		},
		noMatch: { type: "boolean" },
	},
	required: ["selections", "noMatch"],
	additionalProperties: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length <= maxLength;
}

function validateCandidate(value: unknown): FindShortlistCandidate {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["itemId", "displayName", "snippet"]) ||
		!isBoundedString(value.itemId, MAX_ID_LENGTH) ||
		value.itemId.length === 0 ||
		!isBoundedString(value.displayName, MAX_DISPLAY_NAME_LENGTH) ||
		!value.displayName.trim() ||
		value.displayName.includes("/") ||
		value.displayName.includes("\\") ||
		!isBoundedString(value.snippet, FIND_SHORTLIST_MAX_SNIPPET_LENGTH)
	) {
		throw new LlmConfigurationError("Invalid find-shortlist candidate");
	}
	return value as unknown as FindShortlistCandidate;
}

export function validateRankFindShortlistInput(
	value: unknown,
): RankFindShortlistInput {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["query", "candidates"]) ||
		!isRecord(value.query) ||
		!hasOnlyKeys(value.query, ["searchTerms", "query"]) ||
		!isBoundedString(value.query.query, MAX_QUERY_LENGTH) ||
		!value.query.query.trim() ||
		!Array.isArray(value.query.searchTerms) ||
		value.query.searchTerms.length > MAX_SEARCH_TERMS ||
		!Array.isArray(value.candidates) ||
		value.candidates.length > FIND_SHORTLIST_MAX_CANDIDATES
	) {
		throw new LlmConfigurationError("Invalid find-shortlist context");
	}
	const searchTerms = value.query.searchTerms.map((term) => {
		if (
			!isBoundedString(term, MAX_SEARCH_TERM_LENGTH) ||
			!term.trim() ||
			[...term].some((character) => character.charCodeAt(0) < 32)
		) {
			throw new LlmConfigurationError("Invalid find-shortlist search term");
		}
		return term;
	});
	const candidates = value.candidates.map(validateCandidate);
	if (
		new Set(candidates.map((candidate) => candidate.itemId)).size !==
		candidates.length
	) {
		throw new LlmConfigurationError(
			"Find-shortlist candidate IDs must be unique",
		);
	}
	return {
		query: { searchTerms, query: value.query.query },
		candidates,
	};
}

export function parseFindShortlistOutput(
	value: unknown,
): FindShortlistModelOutput {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["selections", "noMatch"]) ||
		!Array.isArray(value.selections) ||
		value.selections.length > FIND_SHORTLIST_MAX_CANDIDATES ||
		typeof value.noMatch !== "boolean"
	) {
		throw new Error("Invalid find-shortlist output");
	}
	const selections = value.selections.map((selection) => {
		if (
			!isRecord(selection) ||
			!hasOnlyKeys(selection, ["itemId", "matchReason", "confidence"]) ||
			!isBoundedString(selection.itemId, MAX_ID_LENGTH) ||
			selection.itemId.length === 0 ||
			!isBoundedString(selection.matchReason, MAX_MATCH_REASON_LENGTH) ||
			!selection.matchReason.trim() ||
			!(["high", "medium", "low"] as unknown[]).includes(selection.confidence)
		) {
			throw new Error("Invalid find-shortlist selection");
		}
		return {
			itemId: selection.itemId,
			matchReason: selection.matchReason,
			confidence: selection.confidence as "high" | "medium" | "low",
		};
	});
	return { selections, noMatch: value.noMatch };
}

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"because",
	"by",
	"file",
	"for",
	"from",
	"in",
	"is",
	"it",
	"match",
	"matches",
	"of",
	"on",
	"or",
	"query",
	"relevant",
	"the",
	"this",
	"to",
	"was",
	"with",
]);

/** Tokenizes evidence generously while keeping fabricated substantive claims visible. */
export function substantiveTokens(value: string): string[] {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u0300-\u036f]/gu, "")
		.split(/[^a-z0-9]+/u)
		.filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export function groundFindShortlistOutput(
	output: FindShortlistModelOutput,
	input: RankFindShortlistInput,
): FindShortlistModelOutput {
	const candidatesById = new Map(
		input.candidates.map((candidate) => [candidate.itemId, candidate]),
	);
	const suppliedIds = new Set(candidatesById.keys());
	const seen = new Set<string>();
	const queryTokens = new Set(
		substantiveTokens(input.query.searchTerms.join(" ")),
	);
	for (const selection of output.selections) {
		assertGroundedOnce(selection.itemId, suppliedIds, seen);
		const candidate = candidatesById.get(selection.itemId);
		if (!candidate)
			throw new LlmStructuredOutputError(
				"Find shortlist referenced an unknown candidate ID",
			);
		const evidenceTokens = new Set([
			...queryTokens,
			...substantiveTokens(candidate.displayName),
			...substantiveTokens(candidate.snippet),
		]);
		if (
			substantiveTokens(selection.matchReason).some(
				(token) => !evidenceTokens.has(token),
			)
		) {
			throw new LlmStructuredOutputError(
				"Find shortlist contained a match reason not grounded in supplied evidence",
			);
		}
	}
	return output;
}

function assertGroundedOnce(
	id: string,
	suppliedIds: Set<string>,
	seen: Set<string>,
): void {
	if (!suppliedIds.has(id) || seen.has(id)) {
		throw new LlmStructuredOutputError(
			"Find shortlist referenced an unknown or duplicate candidate ID",
		);
	}
	seen.add(id);
}

export const findShortlistResponseSchema = {
	name: "untie_find_shortlist_ranking",
	schema: FIND_SHORTLIST_SCHEMA,
	parse: parseFindShortlistOutput,
};
