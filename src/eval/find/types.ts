export type FindQueryKind = "content" | "metadata-only" | "icloud" | "no-match";

export interface FindCorpusFile {
	id: string;
	relativePath: string;
	name: string;
	extension: string;
	content: string;
	isPlaceholder: boolean;
}

export interface FindLabeledQuery {
	id: string;
	kind: FindQueryKind;
	query: string;
	relevantIds: string[];
}

export interface FindCorpus {
	seed: number;
	files: FindCorpusFile[];
	queries: FindLabeledQuery[];
}

export interface LatencyMetrics {
	mean: number;
	p50: number;
	p95: number;
	max: number;
}

export interface AccuracyMetrics {
	queries: number;
	top1Rate: number;
	top3Rate: number;
	contestedQueries: number;
	contestedRate: number;
	meanCandidates: number;
	latencyMs: LatencyMetrics;
}

export interface FindEvaluationReport {
	runtime: string;
	sqlite: "node:sqlite";
	seed: number;
	iterationsPerQuery: number;
	corpus: {
		files: number;
		queries: number;
		content: number;
		metadataOnly: number;
		iCloud: number;
		noMatch: number;
	};
	overall: AccuracyMetrics & { noMatchAccuracy: number };
	byKind: {
		content: AccuracyMetrics;
		metadataOnly: AccuracyMetrics;
		iCloud: AccuracyMetrics;
	};
	noMatch: {
		queries: number;
		accuracy: number;
		emptyResultRate: number;
		latencyMs: LatencyMetrics;
	};
}
