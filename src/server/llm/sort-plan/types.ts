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

export type SortPlanMetadataField = "extension" | "sizeBytes" | "modifiedAt";

export interface SortPlanRequestDataManifest {
	filenameCount: number;
	metadata: {
		fields: SortPlanMetadataField[];
		valueCount: number;
	};
	contentSnippetCount: number;
	documentCount: number;
	opaqueIdCount: number;
	candidateDestinationNameCount: number;
	regenerationInstructionCount: number;
	messageCount: number;
	totalPayloadBytes: number;
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
