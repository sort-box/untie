import { OpenRouterService } from "../index";
import type { LlmService } from "../types";
import { SORT_FIXTURES } from "./fixtures";
import { buildSortMessages } from "./prompt";
import { parseSortPlan, sortPlanResponseSchema } from "./schema";
import { scorePlan, summarize, validatePlanGrounding } from "./scoring";
import type {
	FixtureScore,
	SortFixture,
	SortPlanResult,
	SpikeSummary,
} from "./types";

export const R2_MODEL = "openai/gpt-4.1-mini";
const MAX_ATTEMPTS = 2;

export async function runFixture(
	fixture: SortFixture,
	service?: LlmService,
): Promise<FixtureScore> {
	let result: SortPlanResult | undefined;
	let regenerations = 0;
	let latencyMs = 0;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const started = performance.now();
		try {
			result = service
				? await service.generateObject({
						model: R2_MODEL,
						messages: buildSortMessages(fixture),
						maxTokens: 1200,
						responseSchema: sortPlanResponseSchema,
					})
				: offlineResult(fixture, attempt);
			latencyMs += performance.now() - started;
			const errors = validatePlanGrounding(result.data, fixture);
			if (errors.length === 0) break;
			result = undefined;
		} catch {
			latencyMs += performance.now() - started;
			result = undefined;
		}
		if (attempt < MAX_ATTEMPTS - 1) regenerations += 1;
	}
	if (!result)
		throw new Error(
			`Fixture ${fixture.id} failed after ${MAX_ATTEMPTS} attempts`,
		);
	return scorePlan(fixture, result.data, {
		regenerations,
		latencyMs,
		cost: result.cost,
		promptTokens: result.usage?.promptTokens,
		completionTokens: result.usage?.completionTokens,
	});
}

function offlineResult(fixture: SortFixture, attempt: number): SortPlanResult {
	const recorded =
		fixture.recordedResponses[attempt] ?? fixture.recordedResponses.at(-1);
	return {
		data: parseSortPlan(recorded),
		requestId: `offline-${fixture.id}-${attempt}`,
		model: R2_MODEL,
		finishReason: "stop",
	};
}

export async function runSpike(
	apiKey = process.env.OPENROUTER_API_KEY,
): Promise<SpikeSummary> {
	const live = Boolean(apiKey?.trim());
	const service = live
		? new OpenRouterService({
				apiKey: apiKey ?? "",
				model: R2_MODEL,
				appName: "Untie R2 spike",
			})
		: undefined;
	const scores: FixtureScore[] = [];
	for (const fixture of SORT_FIXTURES)
		scores.push(await runFixture(fixture, service));
	return summarize(
		live ? "live" : "offline",
		live ? R2_MODEL : `${R2_MODEL} (recorded responses)`,
		scores,
	);
}

export function formatSummary(summary: SpikeSummary): string {
	return JSON.stringify(summary, null, 2);
}

if (import.meta.main) {
	runSpike().then((summary) => {
		console.log(formatSummary(summary));
		if (summary.mode === "offline")
			console.error(
				"OPENROUTER_API_KEY is absent: live latency, cost, and quality metrics remain PENDING.",
			);
	});
}
