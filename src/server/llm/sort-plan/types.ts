export interface SortPlanFileContext {
	id: string;
	displayName: string;
	extension?: string;
	sizeBytes?: number;
	modifiedAt?: string;
	excerpt?: string;
}

export interface GenerateSortPlanInput {
	files: SortPlanFileContext[];
	candidateDestinationNames: string[];
	regenerationInstruction?: string;
}

export interface SortCategory {
	name: string;
	fileIds: string[];
	confidence: "high" | "medium" | "low";
}

export interface SortPlan {
	categories: SortCategory[];
	unassignedFileIds: string[];
}
