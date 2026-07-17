import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { generateCorpus } from "../src/spikes/r3/corpus.ts";

const require = createRequire(import.meta.url);
const {
	MAX_RESULT_LIMIT,
	buildPrefixAndQuery,
	createIndexRetrieval,
}: typeof import("./index-retrieval.cjs") = require("./index-retrieval.cjs");

function fixture(partial = false) {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE file_paths(file_id INTEGER PRIMARY KEY, current_path TEXT, filename TEXT, extension TEXT, modified_at_ms INTEGER);
		CREATE TABLE indexed_grants(grant_id TEXT, file_id INTEGER, PRIMARY KEY(grant_id, file_id));
		CREATE VIRTUAL TABLE file_search USING fts5(file_id UNINDEXED, filename, path, extension, content, tokenize='porter unicode61 remove_diacritics 2');
	`);
	const paths = database.prepare(
		"INSERT INTO file_paths VALUES (?, ?, ?, ?, ?)",
	);
	const grants = database.prepare("INSERT INTO indexed_grants VALUES (?, ?)");
	const search = database.prepare(
		"INSERT INTO file_search VALUES (?, ?, ?, ?, ?)",
	);
	function insert({
		id,
		grant = "grant_a",
		name,
		relativePath = name,
		extension,
		content = "",
		modifiedAt = "2025-01-01",
	}) {
		const fileId = Number(id);
		const currentPath = `/Granted/${relativePath}`;
		paths.run(
			fileId,
			currentPath,
			name,
			extension,
			Date.parse(`${modifiedAt}T12:00:00Z`),
		);
		grants.run(grant, fileId);
		search.run(fileId, name, currentPath, extension, content);
	}
	const retrieval = createIndexRetrieval({
		index: { database },
		indexSync: { getStatus: () => ({ partial }) },
		opaqueFileRegistry: {
			registerIndexedResults: ({ files }) =>
				files.map((file) => ({
					itemId: `opaque:${file.name}`,
					name: file.name,
				})),
		},
	});
	const queryGrant = (grantId, searchTerms, filters = {}, options = {}) =>
		retrieval.query(
			{
				grantId,
				interpretedQuery: {
					searchTerms,
					filters: {
						extensions: [],
						namePatterns: [],
						modifiedAt: null,
						...filters,
					},
				},
				...options,
			},
			{
				grant: {
					grant: { id: grantId, revision: 1 },
					canonicalPath: "/Granted",
				},
			},
		);
	const query = (searchTerms, filters = {}, options = {}) =>
		queryGrant("grant_a", searchTerms, filters, options);
	return { database, insert, query, queryGrant };
}

describe("production FTS retrieval", () => {
	test("builds safely quoted prefix-AND MATCH expressions", () => {
		expect(buildPrefixAndQuery(["lease OR secret", 'report"*'])).toBe(
			'"lease"* AND "or"* AND "secret"* AND "report"*',
		);
	});

	test("is grant-scoped, applies every structured filter, and returns snippets with opaque IDs only", () => {
		const { database, insert, query } = fixture(true);
		insert({
			id: 1,
			name: "lease-final.pdf",
			extension: "pdf",
			content: "Cedar apartment tenancy agreement",
			modifiedAt: "2025-06-01",
		});
		insert({
			id: 2,
			grant: "grant_b",
			name: "lease-secret.pdf",
			extension: "pdf",
			content: "Cedar apartment tenancy agreement",
			modifiedAt: "2025-06-01",
		});
		insert({
			id: 3,
			name: "lease-draft.txt",
			extension: "txt",
			content: "Cedar apartment tenancy agreement",
			modifiedAt: "2024-06-01",
		});

		const result = query(["Cedar", "apartment"], {
			extensions: ["pdf"],
			namePatterns: ["*final*"],
			modifiedAt: { after: "2025-01-01", before: "2025-12-31" },
		});
		expect(result.partial).toBe(true);
		expect(result.candidates).toEqual([
			expect.objectContaining({
				itemId: "opaque:lease-final.pdf",
				displayName: "lease-final.pdf",
			}),
		]);
		expect(result.candidates[0]?.snippet).toContain("[");
		expect(JSON.stringify(result)).not.toContain("/Granted");
		database.close();
	});

	test("isolates identical matching files by grant without confounding filters", () => {
		const { database, insert, queryGrant } = fixture();
		insert({
			id: 1,
			grant: "grant_a",
			name: "matching-lease-a.pdf",
			extension: "pdf",
			content: "identical cedar lease terms",
			modifiedAt: "2025-06-01",
		});
		insert({
			id: 2,
			grant: "grant_b",
			name: "matching-lease-b.pdf",
			extension: "pdf",
			content: "identical cedar lease terms",
			modifiedAt: "2025-06-01",
		});

		const grantA = queryGrant("grant_a", ["cedar"]);
		expect(grantA.candidates.map((candidate) => candidate.displayName)).toEqual(
			["matching-lease-a.pdf"],
		);
		expect(
			grantA.candidates.map((candidate) => candidate.displayName),
		).not.toContain("matching-lease-b.pdf");
		const grantB = queryGrant("grant_b", ["cedar"]);
		expect(grantB.candidates).toHaveLength(1);
		expect(grantB.candidates[0]?.displayName).toBe("matching-lease-b.pdf");
		database.close();
	});

	test("applies extension, name-pattern, and date filters independently", () => {
		const { database, insert, query } = fixture();
		insert({
			id: 1,
			name: "lease-final.pdf",
			extension: "pdf",
			content: "cedar lease",
			modifiedAt: "2025-06-01",
		});
		insert({
			id: 2,
			name: "lease-final.txt",
			extension: "txt",
			content: "cedar lease",
			modifiedAt: "2025-06-01",
		});
		insert({
			id: 3,
			name: "lease-draft.pdf",
			extension: "pdf",
			content: "cedar lease",
			modifiedAt: "2025-06-01",
		});
		insert({
			id: 4,
			name: "lease-old.pdf",
			extension: "pdf",
			content: "cedar lease",
			modifiedAt: "2024-06-01",
		});

		expect(
			query(["cedar"], { extensions: ["txt"] }).candidates.map(
				(candidate) => candidate.displayName,
			),
		).toEqual(["lease-final.txt"]);
		expect(
			query(["cedar"], { namePatterns: ["*draft*"] }).candidates.map(
				(candidate) => candidate.displayName,
			),
		).toEqual(["lease-draft.pdf"]);
		expect(
			query(["cedar"], {
				modifiedAt: { after: "2024-01-01", before: "2024-12-31" },
			}).candidates.map((candidate) => candidate.displayName),
		).toEqual(["lease-old.pdf"]);
		database.close();
	});

	test("uses deterministic tie-breaking and enforces the top-20 bound", () => {
		const { database, insert, query } = fixture();
		for (let id = 30; id >= 1; id -= 1)
			insert({
				id,
				name: `common-${id}.txt`,
				extension: "txt",
				content: "identical common text",
			});
		const first = query(["common"], {}, { limit: 20 });
		const second = query(["common"], {}, { limit: 20 });
		expect(first.candidates).toHaveLength(MAX_RESULT_LIMIT);
		expect(second.candidates).toEqual(first.candidates);
		expect(
			first.candidates.slice(0, 3).map((candidate) => candidate.displayName),
		).toEqual(["common-1.txt", "common-2.txt", "common-3.txt"]);
		database.close();
	});

	test("meets R3 recall and p95 latency targets on the 5,000-file reference corpus", () => {
		const corpus = generateCorpus();
		const { database, insert, query } = fixture();
		for (const [index, file] of corpus.files.entries())
			insert({
				id: index + 1,
				name: file.name,
				relativePath: file.relativePath,
				extension: file.extension,
				content: file.content,
				modifiedAt: file.modifiedAt.slice(0, 10),
			});
		const idByName = new Map(corpus.files.map((file) => [file.name, file.id]));
		const latencies: number[] = [];
		for (const labeled of corpus.queries) {
			let result = query([labeled.query]);
			for (let iteration = 0; iteration < 10; iteration += 1) {
				const started = performance.now();
				result = query([labeled.query]);
				latencies.push(performance.now() - started);
			}
			const ids = result.candidates.map((candidate) =>
				idByName.get(candidate.displayName),
			);
			expect(
				ids.slice(0, 3).some((id) => labeled.relevantIds.includes(id)),
			).toBe(true);
			expect(
				ids.slice(0, 20).some((id) => labeled.relevantIds.includes(id)),
			).toBe(true);
		}
		latencies.sort((left, right) => left - right);
		const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? Infinity;
		expect(p95).toBeLessThan(50);
		database.close();
	});
});
