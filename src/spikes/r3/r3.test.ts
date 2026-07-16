import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateCorpus, writeCorpus } from "./corpus.ts";
import { buildFtsQuery, evaluateStrategy, STRATEGIES } from "./evaluate.ts";
import { extractFile } from "./extraction.ts";

describe("R3 corpus and evaluation harness", () => {
	it("generates a deterministic, varied 5k corpus and labeled queries", () => {
		const first = generateCorpus();
		const second = generateCorpus();
		expect(first).toEqual(second);
		expect(first.files).toHaveLength(5_000);
		expect(
			new Set(first.files.map((file) => file.extension)).size,
		).toBeGreaterThanOrEqual(10);
		expect(
			new Set(first.files.map((file) => file.relativePath.split("/")[0])).size,
		).toBeGreaterThanOrEqual(8);
		expect(first.queries.some((query) => query.kind === "metadata")).toBe(true);
		expect(first.queries.some((query) => query.kind === "content")).toBe(true);
	});

	it("escapes and builds FTS query modes", () => {
		expect(buildFtsQuery("Lease 2025", "and")).toBe('"lease" AND "2025"');
		expect(buildFtsQuery("résumé draft", "prefix")).toBe(
			'"résumé"* AND "draft"*',
		);
		expect(buildFtsQuery("tax return", "or")).toBe('"tax" OR "return"');
	});

	it("retrieves labeled metadata and content targets", () => {
		const result = evaluateStrategy(
			generateCorpus(),
			STRATEGIES[2] as (typeof STRATEGIES)[number],
		);
		expect(result.metadata.recallAt20).toBeGreaterThanOrEqual(0.95);
		expect(result.content.recallAt20).toBeGreaterThanOrEqual(0.95);
	});

	it("round-trips extractable corpus formats", async () => {
		const root = await mkdtemp(join(tmpdir(), "untie-r3-test-"));
		try {
			const corpus = generateCorpus(20);
			const fixtures = corpus.files
				.filter((file) => ["pdf", "docx", "txt", "md"].includes(file.extension))
				.slice(0, 8);
			await writeCorpus({ files: fixtures, queries: [] }, root);
			for (const file of fixtures) {
				const extracted = await extractFile(join(root, file.relativePath));
				expect(extracted).toContain(file.content.split(" ")[0]);
			}
			expect(
				(await readFile(join(root, fixtures[0]?.relativePath ?? ""))).length,
			).toBeGreaterThan(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
