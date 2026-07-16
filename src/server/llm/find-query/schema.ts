import { LlmConfigurationError } from "../errors";
import type { JsonSchema } from "../types";
import type { FindQueryInterpretation, InterpretFindQueryInput } from "./types";

const MAX_ITEMS = 12;
const MAX_TERM_LENGTH = 100;
const MAX_PATTERN_LENGTH = 160;
export const FIND_QUERY_MAX_LENGTH = 2_000;

export const FIND_QUERY_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		searchTerms: {
			type: "array",
			items: { type: "string", minLength: 1, maxLength: MAX_TERM_LENGTH },
			maxItems: MAX_ITEMS,
		},
		filters: {
			type: "object",
			properties: {
				extensions: {
					type: "array",
					items: { type: "string", minLength: 1, maxLength: 20 },
					maxItems: MAX_ITEMS,
				},
				namePatterns: {
					type: "array",
					items: {
						type: "string",
						minLength: 1,
						maxLength: MAX_PATTERN_LENGTH,
						// Filename globs only — never a path. No path separators.
						pattern: "^[^/\\\\]+$",
					},
					maxItems: MAX_ITEMS,
				},
				modifiedAt: {
					anyOf: [
						{
							type: "object",
							properties: {
								after: { type: ["string", "null"] },
								before: { type: ["string", "null"] },
							},
							required: ["after", "before"],
							additionalProperties: false,
						},
						{ type: "null" },
					],
				},
			},
			required: ["extensions", "namePatterns", "modifiedAt"],
			additionalProperties: false,
		},
		clarification: { type: ["string", "null"], maxLength: 240 },
	},
	required: ["searchTerms", "filters", "clarification"],
	additionalProperties: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function parseStrings(
	value: unknown,
	label: string,
	maxLength: number,
): string[] {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) {
		throw new Error(`Invalid ${label}`);
	}
	const normalized = value.map((item) => {
		if (typeof item !== "string") throw new Error(`Invalid ${label}`);
		const trimmed = item.trim();
		if (
			!trimmed ||
			trimmed.length > maxLength ||
			[...trimmed].some((character) => character.charCodeAt(0) < 32)
		) {
			throw new Error(`Invalid ${label}`);
		}
		return trimmed;
	});
	return [...new Set(normalized)];
}

function parseIsoDate(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		throw new Error("Dates must use YYYY-MM-DD");
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	if (
		Number.isNaN(date.valueOf()) ||
		date.toISOString().slice(0, 10) !== value
	) {
		throw new Error("Invalid calendar date");
	}
	return value;
}

export function parseFindQueryInterpretation(
	value: unknown,
): Extract<FindQueryInterpretation, { status: "ready" }> {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["searchTerms", "filters", "clarification"]) ||
		!isRecord(value.filters) ||
		!hasOnlyKeys(value.filters, ["extensions", "namePatterns", "modifiedAt"])
	) {
		throw new Error("Invalid find-query interpretation");
	}
	const searchTerms = parseStrings(
		value.searchTerms,
		"search terms",
		MAX_TERM_LENGTH,
	);
	const extensions = parseStrings(
		value.filters.extensions,
		"extensions",
		20,
	).map((extension) => extension.replace(/^\./u, "").toLowerCase());
	if (
		extensions.some((extension) => !/^[a-z0-9][a-z0-9+_-]*$/u.test(extension))
	) {
		throw new Error("Invalid extension");
	}
	const namePatterns = parseStrings(
		value.filters.namePatterns,
		"name patterns",
		MAX_PATTERN_LENGTH,
	);
	// A name pattern is a filename glob, never a path. Reject path separators
	// (traversal / index escape) and cap glob metacharacters so a downstream
	// consumer (F7) cannot be handed a pathological ReDoS-shaped pattern.
	for (const pattern of namePatterns) {
		if (/[/\\]/u.test(pattern)) {
			throw new Error("Invalid name pattern");
		}
		if ((pattern.match(/[*?[\]{}]/gu)?.length ?? 0) > 8) {
			throw new Error("Invalid name pattern");
		}
	}
	let modifiedAt = null;
	if (value.filters.modifiedAt !== null) {
		if (!isRecord(value.filters.modifiedAt))
			throw new Error("Invalid date range");
		if (!hasOnlyKeys(value.filters.modifiedAt, ["after", "before"])) {
			throw new Error("Invalid date range");
		}
		const after = parseIsoDate(value.filters.modifiedAt.after);
		const before = parseIsoDate(value.filters.modifiedAt.before);
		if (after && before && after > before)
			throw new Error("Invalid date range order");
		modifiedAt = { after, before };
	}
	if (value.clarification !== null && typeof value.clarification !== "string") {
		throw new Error("Invalid clarification");
	}
	const clarification = value.clarification?.trim() || null;
	if (clarification && clarification.length > 240)
		throw new Error("Invalid clarification");
	return {
		status: "ready",
		searchTerms,
		filters: { extensions: [...new Set(extensions)], namePatterns, modifiedAt },
		clarification,
	};
}

export const findQueryResponseSchema = {
	name: "untie_find_query_interpretation",
	schema: FIND_QUERY_SCHEMA,
	parse: parseFindQueryInterpretation,
};

export function validateFindQueryInput(
	value: unknown,
): InterpretFindQueryInput {
	if (typeof value !== "object" || value === null || !("query" in value)) {
		throw new LlmConfigurationError("A find query is required");
	}
	const query = value.query;
	if (typeof query !== "string") {
		throw new LlmConfigurationError("Find query must be a string");
	}
	if (query.length > FIND_QUERY_MAX_LENGTH) {
		throw new LlmConfigurationError(
			`Find query must not exceed ${FIND_QUERY_MAX_LENGTH} characters`,
		);
	}
	return { query };
}
