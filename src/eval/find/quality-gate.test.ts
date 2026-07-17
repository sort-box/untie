import { describe, expect, test } from "vitest";
import { generateFindCorpus } from "./corpus.ts";
import { evaluateFindCorpus } from "./evaluate.ts";
import { assessFindQuality, runFindQualityGate } from "./quality-gate.ts";

describe("find quality gate", () => {
	test("records a GO verdict for the frozen corpus", () => {
		const result = runFindQualityGate(generateFindCorpus());

		expect(result.pass).toBe(true);
		expect(result.verdict).toBe("GO");
		expect(result.failures).toEqual({
			total: 0,
			byKind: {
				content: 0,
				"metadata-only": 0,
				icloud: 0,
				"no-match": 0,
			},
			byCategory: {
				"not-retrieved": 0,
				"ranked-below-3": 0,
				"unexpected-match": 0,
			},
			items: [],
		});
	});

	test("returns NO-GO and categorizes degraded outcomes", () => {
		const evaluation = evaluateFindCorpus(generateFindCorpus(), 1);
		const content = evaluation.queryOutcomes.find(
			(outcome) => outcome.kind === "content",
		);
		const metadata = evaluation.queryOutcomes.find(
			(outcome) => outcome.kind === "metadata-only",
		);
		const noMatch = evaluation.queryOutcomes.find(
			(outcome) => outcome.kind === "no-match",
		);
		if (!content || !metadata || !noMatch)
			throw new Error("Frozen corpus is missing required query kinds");

		const degraded = structuredClone(evaluation);
		degraded.overall.top3Rate = 0;
		degraded.byKind.content.top3Rate = 0;
		degraded.noMatch.accuracy = 0;
		degraded.queryOutcomes = degraded.queryOutcomes.map((outcome) => {
			if (outcome.queryId === content.queryId)
				return {
					...outcome,
					firstRelevantRank: null,
					hitTop1: false,
					hitTop3: false,
				};
			if (outcome.queryId === metadata.queryId)
				return {
					...outcome,
					firstRelevantRank: 4,
					hitTop1: false,
					hitTop3: false,
				};
			if (outcome.queryId === noMatch.queryId)
				return { ...outcome, resultIds: ["near-result"], candidates: 1 };
			return outcome;
		});

		const result = assessFindQuality(degraded);
		expect(result.pass).toBe(false);
		expect(result.verdict).toContain("NO-GO: overall.top3Rate");
		expect(result.verdict).toContain("byKind.content.top3Rate");
		expect(result.verdict).toContain("noMatch.accuracy");
		expect(result.failures.byCategory).toEqual({
			"not-retrieved": 1,
			"ranked-below-3": 1,
			"unexpected-match": 1,
		});
		expect(result.failures.byKind).toMatchObject({
			content: 1,
			"metadata-only": 1,
			"no-match": 1,
		});
	});
});
