const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 20;
const BM25_WEIGHTS = Object.freeze([0, 8, 3, 1, 1]);

function tokenizeSearchTerms(searchTerms) {
	if (!Array.isArray(searchTerms))
		throw new TypeError("searchTerms must be an array");
	return searchTerms
		.flatMap((term) =>
			typeof term === "string"
				? term.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) || []
				: [],
		)
		.slice(0, 32);
}

function buildPrefixAndQuery(searchTerms) {
	return tokenizeSearchTerms(searchTerms)
		.map((term) => `"${term.replaceAll('"', '""')}"*`)
		.join(" AND ");
}

function parseDateBoundary(value, endOfDay) {
	if (value === null) return null;
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
		throw new TypeError("modifiedAt boundaries must be ISO dates or null");
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(timestamp))
		throw new TypeError("Invalid modifiedAt date");
	const canonical = new Date(timestamp).toISOString().slice(0, 10);
	if (canonical !== value) throw new TypeError("Invalid modifiedAt date");
	return endOfDay ? timestamp + 86_400_000 : timestamp;
}

function validateFilters(filters) {
	if (!filters || typeof filters !== "object")
		throw new TypeError("filters are required");
	const extensions = filters.extensions;
	const namePatterns = filters.namePatterns;
	if (
		!Array.isArray(extensions) ||
		extensions.length > 12 ||
		extensions.some(
			(extension) =>
				typeof extension !== "string" ||
				!/^[a-z0-9][a-z0-9+_-]*$/u.test(extension),
		)
	)
		throw new TypeError("Invalid extension filter");
	if (
		!Array.isArray(namePatterns) ||
		namePatterns.length > 12 ||
		namePatterns.some(
			(pattern) =>
				typeof pattern !== "string" ||
				pattern.length === 0 ||
				pattern.length > 120 ||
				/[/\\]/u.test(pattern) ||
				(pattern.match(/[*?[\]{}]/gu)?.length || 0) > 8,
		)
	)
		throw new TypeError("Invalid name-pattern filter");
	const modifiedAt = filters.modifiedAt;
	if (modifiedAt !== null && (!modifiedAt || typeof modifiedAt !== "object"))
		throw new TypeError("Invalid modifiedAt filter");
	const after = parseDateBoundary(modifiedAt?.after ?? null, false);
	const beforeExclusive = parseDateBoundary(modifiedAt?.before ?? null, true);
	if (after !== null && beforeExclusive !== null && after >= beforeExclusive)
		throw new TypeError("Invalid modifiedAt range");
	return { extensions, namePatterns, after, beforeExclusive };
}

function createIndexRetrieval({ index, indexSync, opaqueFileRegistry }) {
	function query(
		{ grantId, interpretedQuery, limit = DEFAULT_RESULT_LIMIT },
		authorization,
	) {
		if (typeof grantId !== "string" || grantId.length === 0)
			throw new TypeError("grantId is required");
		const ftsQuery = buildPrefixAndQuery(interpretedQuery?.searchTerms);
		if (!ftsQuery)
			throw new TypeError("At least one searchable term is required");
		const filters = validateFilters(interpretedQuery?.filters);
		const boundedLimit = Math.min(
			MAX_RESULT_LIMIT,
			Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_RESULT_LIMIT,
		);
		const predicates = ["g.grant_id = ?", "file_search MATCH ?"];
		const parameters = [grantId, ftsQuery];
		if (filters.extensions.length > 0) {
			predicates.push(
				`p.extension IN (${filters.extensions.map(() => "?").join(", ")})`,
			);
			parameters.push(...filters.extensions);
		}
		for (const pattern of filters.namePatterns) {
			predicates.push("lower(p.filename) GLOB lower(?)");
			parameters.push(pattern);
		}
		if (filters.after !== null) {
			predicates.push("p.modified_at_ms >= ?");
			parameters.push(filters.after);
		}
		if (filters.beforeExclusive !== null) {
			predicates.push("p.modified_at_ms < ?");
			parameters.push(filters.beforeExclusive);
		}
		parameters.push(boundedLimit);
		const rows = index.database
			.prepare(`
				SELECT p.file_id, p.current_path, p.filename,
					snippet(file_search, 4, '[', ']', ' … ', 18) AS content_snippet,
					snippet(file_search, 1, '[', ']', ' … ', 12) AS filename_snippet,
					bm25(file_search, ${BM25_WEIGHTS.join(", ")}) AS score
				FROM file_search
				JOIN file_paths p ON p.file_id = file_search.file_id
				JOIN indexed_grants g ON g.file_id = p.file_id
				WHERE ${predicates.join(" AND ")}
				ORDER BY score ASC, p.file_id ASC
				LIMIT ?
			`)
			.all(...parameters);
		const publicFiles = opaqueFileRegistry.registerIndexedResults({
			grant: authorization.grant.grant,
			canonicalGrantPath: authorization.grant.canonicalPath,
			files: rows.map((row) => ({
				path: row.current_path,
				name: row.filename,
			})),
		});
		const sourceIndexes =
			publicFiles.sourceIndexes || publicFiles.map((_, i) => i);
		return {
			partial: indexSync.getStatus(grantId).partial,
			candidates: publicFiles.map((file, position) => ({
				itemId: file.itemId,
				displayName: rows[sourceIndexes[position]].filename,
				snippet:
					rows[sourceIndexes[position]].content_snippet ||
					rows[sourceIndexes[position]].filename_snippet ||
					rows[sourceIndexes[position]].filename,
			})),
		};
	}
	return { query };
}

module.exports = {
	BM25_WEIGHTS,
	DEFAULT_RESULT_LIMIT,
	MAX_RESULT_LIMIT,
	buildPrefixAndQuery,
	createIndexRetrieval,
};
