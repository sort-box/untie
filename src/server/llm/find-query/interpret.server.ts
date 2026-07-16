import type { LlmService } from "../types";
import { buildFindQueryMessages } from "./prompt";
import { findQueryResponseSchema, validateFindQueryInput } from "./schema";
import type { FindQueryInterpretation, InterpretFindQueryInput } from "./types";

export const FIND_QUERY_TIMEOUT_MS = 15_000;
export const FIND_QUERY_MODEL = "openai/gpt-4.1-mini";

export type InterpretFindQueryDependencies = {
	service: LlmService;
	signal?: AbortSignal;
	now?: () => Date;
};

export async function interpretFindQuery(
	input: InterpretFindQueryInput,
	dependencies: InterpretFindQueryDependencies,
): Promise<FindQueryInterpretation> {
	const { query } = validateFindQueryInput(input);
	if (!query.trim()) {
		return {
			status: "needs_clarification",
			searchTerms: [],
			filters: { extensions: [], namePatterns: [], modifiedAt: null },
			clarification: "What file would you like to find?",
		};
	}
	const currentDate = (dependencies.now?.() ?? new Date())
		.toISOString()
		.slice(0, 10);
	const result = await dependencies.service.generateObject({
		model: FIND_QUERY_MODEL,
		messages: buildFindQueryMessages(query, currentDate),
		maxTokens: 700,
		responseSchema: findQueryResponseSchema,
		signal: dependencies.signal,
		timeoutMs: FIND_QUERY_TIMEOUT_MS,
	});
	return result.data;
}

export async function interpretCurrentAccountFindQuery(
	input: InterpretFindQueryInput,
	signal?: AbortSignal,
): Promise<FindQueryInterpretation> {
	const validated = validateFindQueryInput(input);
	if (!validated.query.trim()) {
		return interpretFindQuery(validated, { service: emptyQueryService });
	}
	const { createCurrentAccountLlmService } = await import(
		"../current-account.server"
	);
	return interpretFindQuery(validated, {
		service: await createCurrentAccountLlmService(),
		signal,
	});
}

const emptyQueryService: LlmService = {
	generateText: async () => {
		throw new Error("Empty queries do not call the LLM");
	},
	generateObject: async () => {
		throw new Error("Empty queries do not call the LLM");
	},
};
