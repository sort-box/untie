import type { LlmResult } from "../types";

export interface SortFixtureFile {
	id: string;
	name: string;
	extension: string;
	sizeBytes: number;
	modifiedAt: string;
	text?: string;
	expectedDestination: string;
	severeDestinations?: string[];
}

export interface SortFixture {
	id: string;
	label: "everyday" | "ambiguous" | "adversarial";
	description: string;
	existingFolders: string[];
	files: SortFixtureFile[];
	recordedResponses: unknown[];
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

export interface FixtureScore {
	fixtureId: string;
	label: SortFixture["label"];
	correctMoves: number;
	proposedMoves: number;
	totalFiles: number;
	precision: number;
	coverage: number;
	severeErrors: number;
	regenerations: number;
	latencyMs: number;
	cost?: number;
	promptTokens?: number;
	completionTokens?: number;
}

export interface SpikeSummary {
	mode: "offline" | "live";
	model: string;
	fixtures: FixtureScore[];
	precision: number;
	coverage: number;
	severeErrors: number;
	regenerations: number;
	regenerationRate: number;
	totalLatencyMs: number;
	totalCost?: number;
}

export type SortPlanResult = LlmResult<SortPlan>;
