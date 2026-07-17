import type { LlmService } from "../types";
import { buildFindShortlistMessages } from "./prompt";
import {
	findShortlistResponseSchema,
	groundFindShortlistOutput,
	validateRankFindShortlistInput,
} from "./schema";
import type { FindShortlistResult, RankFindShortlistInput } from "./types";

export const FIND_SHORTLIST_MODEL = "openai/gpt-4.1-mini";
export const FIND_SHORTLIST_TIMEOUT_MS = 15_000;

export interface RankFindShortlistDependencies {
	service: LlmService;
	signal?: AbortSignal;
}

export async function rankFindShortlist(
	input: RankFindShortlistInput,
	dependencies: RankFindShortlistDependencies,
): Promise<FindShortlistResult> {
	const validated = validateRankFindShortlistInput(input);
	if (validated.candidates.length === 0) {
		return { status: "no_match", selections: [] };
	}
	const result = await dependencies.service.generateObject({
		model: FIND_SHORTLIST_MODEL,
		messages: buildFindShortlistMessages(validated),
		maxTokens: 1_000,
		responseSchema: findShortlistResponseSchema,
		signal: dependencies.signal,
		timeoutMs: FIND_SHORTLIST_TIMEOUT_MS,
	});
	const grounded = groundFindShortlistOutput(result.data, validated);
	if (grounded.noMatch || grounded.selections.length === 0) {
		return { status: "no_match", selections: [] };
	}
	return { status: "ranked", selections: grounded.selections };
}

export async function rankCurrentAccountFindShortlist(
	input: RankFindShortlistInput,
	signal?: AbortSignal,
): Promise<FindShortlistResult> {
	const validated = validateRankFindShortlistInput(input);
	if (validated.candidates.length === 0) {
		return { status: "no_match", selections: [] };
	}
	const { createCurrentAccountLlmService } = await import(
		"../current-account.server"
	);
	return rankFindShortlist(validated, {
		service: await createCurrentAccountLlmService(),
		signal,
	});
}
