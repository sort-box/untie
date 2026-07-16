import type { LlmService } from "../types";
import { buildSortPlanRequest } from "./prompt";
import {
	groundSortPlan,
	sortPlanResponseSchema,
	validateGenerateSortPlanInput,
} from "./schema";
import type { GenerateSortPlanInput, SortPlan } from "./types";

export const SORT_PLAN_MODEL = "openai/gpt-4.1-mini";
export const SORT_PLAN_TIMEOUT_MS = 30_000;

export interface GenerateSortPlanDependencies {
	service: LlmService;
	signal?: AbortSignal;
}

export async function generateSortPlan(
	input: GenerateSortPlanInput,
	dependencies: GenerateSortPlanDependencies,
): Promise<SortPlan> {
	const validated = validateGenerateSortPlanInput(input);
	const { messages } = buildSortPlanRequest(validated);
	const result = await dependencies.service.generateObject({
		model: SORT_PLAN_MODEL,
		messages,
		maxTokens: 1_200,
		responseSchema: sortPlanResponseSchema,
		signal: dependencies.signal,
		timeoutMs: SORT_PLAN_TIMEOUT_MS,
	});
	return groundSortPlan(
		result.data,
		new Set(validated.files.map((file) => file.id)),
	);
}

export async function generateCurrentAccountSortPlan(
	input: GenerateSortPlanInput,
	signal?: AbortSignal,
): Promise<SortPlan> {
	const validated = validateGenerateSortPlanInput(input);
	const { createCurrentAccountLlmService } = await import(
		"../current-account.server"
	);
	return generateSortPlan(validated, {
		service: await createCurrentAccountLlmService(),
		signal,
	});
}
