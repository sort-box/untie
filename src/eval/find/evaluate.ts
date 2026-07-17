import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type {
	FindCorpus,
	FindEvaluationReport,
	FindLabeledQuery,
	FindQueryKind,
	LatencyMetrics,
} from "./types.ts";

const require = createRequire(import.meta.url);
const {
	FTS5_TOKENIZER,
}: { FTS5_TOKENIZER: string } = require("../../../electron/index-store.cjs");
const {
	BM25_WEIGHTS,
	buildPrefixAndQuery,
}: {
	BM25_WEIGHTS: readonly number[];
	buildPrefixAndQuery: (terms: string[]) => string;
} = require("../../../electron/index-retrieval.cjs");

const RESULT_LIMIT = 20;
export const DEFAULT_ITERATIONS_PER_QUERY = 10;

interface QueryResult {
	query: FindLabeledQuery;
	ids: string[];
	latencies: number[];
}

function percentile(sorted: number[], fraction: number): number {
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
}

function latencyMetrics(values: number[]): LatencyMetrics {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		mean: values.reduce((sum, value) => sum + value, 0) / values.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted.at(-1) ?? 0,
	};
}

function accuracy(results: QueryResult[]) {
	const top1 = results.filter(({ ids, query }) =>
		query.relevantIds.includes(ids[0] ?? ""),
	).length;
	const top3 = results.filter(({ ids, query }) =>
		ids.slice(0, 3).some((id) => query.relevantIds.includes(id)),
	).length;
	const contestedQueries = results.filter(({ ids }) => ids.length > 1).length;
	return {
		queries: results.length,
		top1Rate: top1 / results.length,
		top3Rate: top3 / results.length,
		contestedQueries,
		contestedRate: contestedQueries / results.length,
		meanCandidates:
			results.reduce((sum, result) => sum + result.ids.length, 0) /
			results.length,
		latencyMs: latencyMetrics(results.flatMap((result) => result.latencies)),
	};
}

function splitTerms(query: string): string[] {
	return query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function evaluateFindCorpus(
	corpus: FindCorpus,
	iterationsPerQuery = DEFAULT_ITERATIONS_PER_QUERY,
): FindEvaluationReport {
	if (!Number.isSafeInteger(iterationsPerQuery) || iterationsPerQuery < 1)
		throw new TypeError("iterationsPerQuery must be a positive integer");
	const database = new DatabaseSync(":memory:");
	try {
		database.exec(
			`CREATE VIRTUAL TABLE file_search USING fts5(file_id UNINDEXED, filename, path, extension, content, tokenize='${FTS5_TOKENIZER}')`,
		);
		const insert = database.prepare(
			"INSERT INTO file_search(file_id, filename, path, extension, content) VALUES (?, ?, ?, ?, ?)",
		);
		database.exec("BEGIN");
		for (const file of corpus.files)
			insert.run(
				file.id,
				file.name,
				file.relativePath,
				file.extension,
				file.content,
			);
		database.exec("COMMIT");
		const statement = database.prepare(
			`SELECT file_id FROM file_search WHERE file_search MATCH ? ORDER BY bm25(file_search, ${BM25_WEIGHTS.join(", ")}) ASC, file_id ASC LIMIT ${RESULT_LIMIT}`,
		);
		const results: QueryResult[] = corpus.queries.map((query) => {
			const match = buildPrefixAndQuery(splitTerms(query.query));
			let rows: Array<{ file_id: string }> = [];
			const latencies: number[] = [];
			for (let iteration = 0; iteration < iterationsPerQuery; iteration += 1) {
				const started = performance.now();
				rows = statement.all(match) as unknown as Array<{ file_id: string }>;
				latencies.push(performance.now() - started);
			}
			return { query, ids: rows.map((row) => row.file_id), latencies };
		});
		const positive = results.filter(
			(result) => result.query.kind !== "no-match",
		);
		const byKind = (kind: Exclude<FindQueryKind, "no-match">) =>
			accuracy(positive.filter((result) => result.query.kind === kind));
		const noMatchResults = results.filter(
			(result) => result.query.kind === "no-match",
		);
		const emptyNoMatches = noMatchResults.filter(
			(result) => result.ids.length === 0,
		).length;
		const noMatchAccuracy = emptyNoMatches / noMatchResults.length;
		return {
			runtime: process.version,
			sqlite: "node:sqlite",
			seed: corpus.seed,
			iterationsPerQuery,
			corpus: {
				files: corpus.files.length,
				queries: corpus.queries.length,
				content: corpus.queries.filter((query) => query.kind === "content")
					.length,
				metadataOnly: corpus.queries.filter(
					(query) => query.kind === "metadata-only",
				).length,
				iCloud: corpus.queries.filter((query) => query.kind === "icloud")
					.length,
				noMatch: noMatchResults.length,
			},
			overall: { ...accuracy(positive), noMatchAccuracy },
			byKind: {
				content: byKind("content"),
				metadataOnly: byKind("metadata-only"),
				iCloud: byKind("icloud"),
			},
			noMatch: {
				queries: noMatchResults.length,
				accuracy: noMatchAccuracy,
				emptyResultRate: noMatchAccuracy,
				latencyMs: latencyMetrics(
					noMatchResults.flatMap((result) => result.latencies),
				),
			},
		};
	} finally {
		database.close();
	}
}
