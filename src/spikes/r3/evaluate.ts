import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { Corpus, LabeledQuery, QualityMetrics } from "./types.ts";

export interface Strategy {
	id: string;
	tokenizer: string;
	queryMode: "and" | "prefix" | "or";
}

export const STRATEGIES: Strategy[] = [
	{
		id: "unicode61-and",
		tokenizer: "unicode61 remove_diacritics 2",
		queryMode: "and",
	},
	{
		id: "unicode61-prefix",
		tokenizer: "unicode61 remove_diacritics 2",
		queryMode: "prefix",
	},
	{
		id: "porter-prefix",
		tokenizer: "porter unicode61 remove_diacritics 2",
		queryMode: "prefix",
	},
	{
		id: "porter-or",
		tokenizer: "porter unicode61 remove_diacritics 2",
		queryMode: "or",
	},
];

export interface StrategyResult {
	strategy: Strategy;
	metadata: QualityMetrics;
	content: QualityMetrics;
}

function terms(query: string): string[] {
	return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function buildFtsQuery(
	query: string,
	mode: Strategy["queryMode"],
): string {
	const tokens = terms(query).map(
		(term) => `"${term.replaceAll('"', '""')}"${mode === "prefix" ? "*" : ""}`,
	);
	return tokens.join(mode === "or" ? " OR " : " AND ");
}

function percentile(sorted: number[], fraction: number): number {
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
}

function score(
	queries: LabeledQuery[],
	results: string[][],
	latencies: number[],
): QualityMetrics {
	let reciprocalRanks = 0;
	let relevantTop3 = 0;
	let recalledTop20 = 0;
	for (const [index, query] of queries.entries()) {
		const result = results[index] ?? [];
		const rank = result.findIndex((id) => query.relevantIds.includes(id));
		if (rank >= 0) reciprocalRanks += 1 / (rank + 1);
		relevantTop3 += result
			.slice(0, 3)
			.filter((id) => query.relevantIds.includes(id)).length;
		recalledTop20 +=
			query.relevantIds.filter((id) => result.slice(0, 20).includes(id))
				.length / query.relevantIds.length;
	}
	const sorted = [...latencies].sort((a, b) => a - b);
	return {
		mrr: reciprocalRanks / queries.length,
		precisionAt3: relevantTop3 / (queries.length * 3),
		recallAt20: recalledTop20 / queries.length,
		top3Rate:
			(relevantTop3 > 0
				? queries.filter((query, index) =>
						(results[index] ?? [])
							.slice(0, 3)
							.some((id) => query.relevantIds.includes(id)),
					).length
				: 0) / queries.length,
		latencyMs: {
			mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
			p50: percentile(sorted, 0.5),
			p95: percentile(sorted, 0.95),
			max: sorted.at(-1) ?? 0,
		},
	};
}

function evaluateKind(
	db: DatabaseSync,
	strategy: Strategy,
	queries: LabeledQuery[],
	table: string,
): QualityMetrics {
	const statement = db.prepare(
		`SELECT id FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}, 8.0, 3.0, 1.0) LIMIT 20`,
	);
	const results: string[][] = [];
	const latencies: number[] = [];
	for (const query of queries) {
		const ftsQuery = buildFtsQuery(query.query, strategy.queryMode);
		let rows: Array<{ id: string }> = [];
		for (let iteration = 0; iteration < 30; iteration += 1) {
			const started = performance.now();
			rows = statement.all(ftsQuery) as unknown as Array<{ id: string }>;
			latencies.push(performance.now() - started);
		}
		results.push(rows.map((row) => row.id));
	}
	return score(queries, results, latencies);
}

export function evaluateStrategy(
	corpus: Corpus,
	strategy: Strategy,
): StrategyResult {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(
			`CREATE VIRTUAL TABLE metadata_fts USING fts5(id UNINDEXED, name, path, extension, tokenize='${strategy.tokenizer}'); CREATE VIRTUAL TABLE content_fts USING fts5(id UNINDEXED, name, path, content, tokenize='${strategy.tokenizer}')`,
		);
		const metadataInsert = db.prepare(
			"INSERT INTO metadata_fts(id, name, path, extension) VALUES (?, ?, ?, ?)",
		);
		const contentInsert = db.prepare(
			"INSERT INTO content_fts(id, name, path, content) VALUES (?, ?, ?, ?)",
		);
		db.exec("BEGIN");
		for (const file of corpus.files) {
			metadataInsert.run(file.id, file.name, file.relativePath, file.extension);
			contentInsert.run(file.id, file.name, file.relativePath, file.content);
		}
		db.exec("COMMIT");
		return {
			strategy,
			metadata: evaluateKind(
				db,
				strategy,
				corpus.queries.filter((query) => query.kind === "metadata"),
				"metadata_fts",
			),
			content: evaluateKind(
				db,
				strategy,
				corpus.queries.filter((query) => query.kind === "content"),
				"content_fts",
			),
		};
	} finally {
		db.close();
	}
}
