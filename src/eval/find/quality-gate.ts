import { generateFindCorpus } from "./corpus.ts";
import { evaluateFindCorpus } from "./evaluate.ts";
import type {
	FindCorpus,
	FindEvaluationReport,
	FindQueryKind,
	FindQueryOutcome,
} from "./types.ts";

type PositiveKind = Exclude<FindQueryKind, "no-match">;
export type FindFailureCategory =
	| "not-retrieved"
	| "ranked-below-3"
	| "unexpected-match";

export interface FindQualityThreshold {
	overallTop3Rate: number;
	byKindTop3Rate: Record<PositiveKind, number>;
	noMatchAccuracy: number;
}

export interface CategorizedFindFailure {
	queryId: string;
	kind: FindQueryKind;
	category: FindFailureCategory;
	firstRelevantRank: number | null;
	candidates: number;
}

export interface FindFailureSummary {
	total: number;
	byKind: Record<FindQueryKind, number>;
	byCategory: Record<FindFailureCategory, number>;
	items: CategorizedFindFailure[];
}

export interface QualityGateResult {
	evaluation: FindEvaluationReport;
	failures: FindFailureSummary;
	threshold: FindQualityThreshold;
	pass: boolean;
	verdict: string;
}

// Frozen F13 baseline (seed 252927725): overall and every kind top-3 = 1.00,
// no-match accuracy = 1.00. Floors retain one-query safety margin per kind and
// match the existing F13 overall/no-match assertions.
export const FIND_QUALITY_THRESHOLD: FindQualityThreshold = {
	overallTop3Rate: 0.85,
	byKindTop3Rate: { content: 0.85, "metadata-only": 0.85, icloud: 0.85 },
	noMatchAccuracy: 0.99,
};

function categorizeOutcome(
	outcome: FindQueryOutcome,
): CategorizedFindFailure | null {
	let category: FindFailureCategory | null = null;
	if (outcome.kind === "no-match") {
		if (outcome.candidates > 0) category = "unexpected-match";
	} else if (!outcome.hitTop3) {
		category =
			outcome.firstRelevantRank === null ? "not-retrieved" : "ranked-below-3";
	}
	return category === null
		? null
		: {
				queryId: outcome.queryId,
				kind: outcome.kind,
				category,
				firstRelevantRank: outcome.firstRelevantRank,
				candidates: outcome.candidates,
			};
}

export function categorizeFindFailures(
	outcomes: FindQueryOutcome[],
): FindFailureSummary {
	const items = outcomes.flatMap((outcome) => {
		const failure = categorizeOutcome(outcome);
		return failure === null ? [] : [failure];
	});
	const byKind: Record<FindQueryKind, number> = {
		content: 0,
		"metadata-only": 0,
		icloud: 0,
		"no-match": 0,
	};
	const byCategory: Record<FindFailureCategory, number> = {
		"not-retrieved": 0,
		"ranked-below-3": 0,
		"unexpected-match": 0,
	};
	for (const failure of items) {
		byKind[failure.kind] += 1;
		byCategory[failure.category] += 1;
	}
	return { total: items.length, byKind, byCategory, items };
}

export function assessFindQuality(
	evaluation: FindEvaluationReport,
	threshold: FindQualityThreshold = FIND_QUALITY_THRESHOLD,
): QualityGateResult {
	const failingThresholds: string[] = [];
	if (evaluation.overall.top3Rate < threshold.overallTop3Rate)
		failingThresholds.push(
			`overall.top3Rate ${evaluation.overall.top3Rate.toFixed(3)} < ${threshold.overallTop3Rate.toFixed(3)}`,
		);
	for (const [reportKind, thresholdKind] of [
		["content", "content"],
		["metadataOnly", "metadata-only"],
		["iCloud", "icloud"],
	] as const) {
		const actual = evaluation.byKind[reportKind].top3Rate;
		const floor = threshold.byKindTop3Rate[thresholdKind];
		if (actual < floor)
			failingThresholds.push(
				`byKind.${thresholdKind}.top3Rate ${actual.toFixed(3)} < ${floor.toFixed(3)}`,
			);
	}
	if (evaluation.noMatch.accuracy < threshold.noMatchAccuracy)
		failingThresholds.push(
			`noMatch.accuracy ${evaluation.noMatch.accuracy.toFixed(3)} < ${threshold.noMatchAccuracy.toFixed(3)}`,
		);
	const pass = failingThresholds.length === 0;
	return {
		evaluation,
		failures: categorizeFindFailures(evaluation.queryOutcomes),
		threshold,
		pass,
		verdict: pass ? "GO" : `NO-GO: ${failingThresholds.join("; ")}`,
	};
}

export function runFindQualityGate(
	corpus: FindCorpus = generateFindCorpus(),
	threshold: FindQualityThreshold = FIND_QUALITY_THRESHOLD,
): QualityGateResult {
	return assessFindQuality(evaluateFindCorpus(corpus), threshold);
}
