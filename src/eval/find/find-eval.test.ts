import { describe, expect, test } from "vitest";
import { generateFindCorpus } from "./corpus.ts";
import { evaluateFindCorpus } from "./evaluate.ts";

describe("find evaluation harness", () => {
	test("is seeded, production-equivalent, and meets retrieval quality floors", () => {
		const corpus = generateFindCorpus();
		expect(corpus).toEqual(generateFindCorpus());
		expect(corpus.files).toHaveLength(5_000);
		expect(corpus.queries).toHaveLength(30);
		expect(corpus.queries.some((query) => query.kind === "metadata-only")).toBe(
			true,
		);
		expect(corpus.queries.some((query) => query.kind === "icloud")).toBe(true);
		expect(corpus.files.filter((file) => file.isPlaceholder)).toHaveLength(9);
		expect(
			corpus.files
				.filter((file) => file.isPlaceholder)
				.every((file) => file.content === ""),
		).toBe(true);

		const report = evaluateFindCorpus(corpus, 3);
		expect(report.overall.contestedQueries).toBeGreaterThanOrEqual(12);
		expect(report.overall.contestedRate).toBeGreaterThanOrEqual(0.4);
		expect(report.overall.meanCandidates).toBeGreaterThan(1);
		expect(report.overall.top1Rate).toBeGreaterThanOrEqual(0.9);
		expect(report.overall.top3Rate).toBeGreaterThanOrEqual(0.85);
		for (const kind of ["content", "metadataOnly", "iCloud"] as const)
			expect(report.byKind[kind].contestedQueries).toBeGreaterThan(0);
		expect(report.noMatch.accuracy).toBeGreaterThanOrEqual(0.99);
		for (const latency of [
			report.overall.latencyMs,
			report.byKind.content.latencyMs,
			report.byKind.metadataOnly.latencyMs,
			report.byKind.iCloud.latencyMs,
			report.noMatch.latencyMs,
		]) {
			for (const value of Object.values(latency))
				expect(Number.isFinite(value)).toBe(true);
		}
	});
});
