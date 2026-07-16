export const EXTRACTABLE_EXTENSIONS = ["txt", "md", "pdf", "docx"] as const;

export type ExtractableExtension = (typeof EXTRACTABLE_EXTENSIONS)[number];

export interface CorpusFile {
	id: string;
	relativePath: string;
	name: string;
	extension: string;
	size: number;
	modifiedAt: string;
	content: string;
}

export interface LabeledQuery {
	id: string;
	kind: "metadata" | "content";
	query: string;
	relevantIds: string[];
}

export interface Corpus {
	files: CorpusFile[];
	queries: LabeledQuery[];
}

export interface QualityMetrics {
	mrr: number;
	precisionAt3: number;
	recallAt20: number;
	top3Rate: number;
	latencyMs: { mean: number; p50: number; p95: number; max: number };
}
