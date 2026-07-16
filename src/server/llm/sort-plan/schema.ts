import { LlmConfigurationError, LlmStructuredOutputError } from "../errors";
import type { JsonSchema } from "../types";
import type {
	GenerateSortPlanInput,
	SortPlan,
	SortPlanFileContext,
} from "./types";

export const SORT_PLAN_MAX_FILES = 250;
export const SORT_PLAN_MAX_DESTINATIONS = 100;
export const SORT_PLAN_MAX_PROMPT_BYTES = 128_000;
const MAX_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 512;
const MAX_EXCERPT_LENGTH = 2_000;
const MAX_DESTINATION_LENGTH = 80;
const MAX_REGENERATION_INSTRUCTION_LENGTH = 500;

export const SORT_PLAN_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		categories: {
			type: "array",
			maxItems: SORT_PLAN_MAX_FILES,
			items: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 80 },
					fileIds: {
						type: "array",
						maxItems: SORT_PLAN_MAX_FILES,
						items: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
						uniqueItems: true,
					},
					confidence: { enum: ["high", "medium", "low"] },
				},
				required: ["name", "fileIds", "confidence"],
				additionalProperties: false,
			},
		},
		unassignedFileIds: {
			type: "array",
			maxItems: SORT_PLAN_MAX_FILES,
			items: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
			uniqueItems: true,
		},
	},
	required: ["categories", "unassignedFileIds"],
	additionalProperties: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length <= maxLength;
}

function validateFile(value: unknown): SortPlanFileContext {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"id",
			"displayName",
			"extension",
			"sizeBytes",
			"modifiedAt",
			"excerpt",
		]) ||
		!isBoundedString(value.id, MAX_ID_LENGTH) ||
		value.id.length === 0 ||
		!isBoundedString(value.displayName, MAX_DISPLAY_NAME_LENGTH) ||
		value.displayName.length === 0 ||
		value.displayName.includes("/") ||
		value.displayName.includes("\\") ||
		(value.extension !== undefined && !isBoundedString(value.extension, 32)) ||
		(value.modifiedAt !== undefined &&
			!isBoundedString(value.modifiedAt, 40)) ||
		(value.excerpt !== undefined &&
			!isBoundedString(value.excerpt, MAX_EXCERPT_LENGTH)) ||
		(value.sizeBytes !== undefined &&
			(typeof value.sizeBytes !== "number" ||
				!Number.isSafeInteger(value.sizeBytes) ||
				value.sizeBytes < 0))
	) {
		throw new LlmConfigurationError("Invalid sort-plan file context");
	}
	return value as unknown as SortPlanFileContext;
}

export function validateGenerateSortPlanInput(
	value: unknown,
): GenerateSortPlanInput {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"files",
			"candidateDestinationNames",
			"regenerationInstruction",
		]) ||
		!Array.isArray(value.files) ||
		value.files.length === 0 ||
		value.files.length > SORT_PLAN_MAX_FILES ||
		!Array.isArray(value.candidateDestinationNames) ||
		value.candidateDestinationNames.length > SORT_PLAN_MAX_DESTINATIONS
	) {
		throw new LlmConfigurationError("Invalid sort-plan scan context");
	}
	const files = value.files.map(validateFile);
	if (new Set(files.map((file) => file.id)).size !== files.length) {
		throw new LlmConfigurationError("Sort-plan file IDs must be unique");
	}
	const candidateDestinationNames = value.candidateDestinationNames.map(
		(name) => {
			if (
				!isBoundedString(name, MAX_DESTINATION_LENGTH) ||
				!name.trim() ||
				name.includes("/") ||
				name.includes("\\")
			) {
				throw new LlmConfigurationError("Invalid candidate destination name");
			}
			return name;
		},
	);
	if (
		value.regenerationInstruction !== undefined &&
		!isBoundedString(
			value.regenerationInstruction,
			MAX_REGENERATION_INSTRUCTION_LENGTH,
		)
	) {
		throw new LlmConfigurationError("Invalid regeneration instruction");
	}
	return {
		files,
		candidateDestinationNames,
		...(value.regenerationInstruction === undefined
			? {}
			: { regenerationInstruction: value.regenerationInstruction }),
	};
}

export function parseSortPlan(value: unknown): SortPlan {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["categories", "unassignedFileIds"]) ||
		!Array.isArray(value.categories) ||
		value.categories.length > SORT_PLAN_MAX_FILES ||
		!Array.isArray(value.unassignedFileIds) ||
		value.unassignedFileIds.length > SORT_PLAN_MAX_FILES
	) {
		throw new Error("Invalid sort plan");
	}
	const categories = value.categories.map((category) => {
		if (
			!isRecord(category) ||
			!hasOnlyKeys(category, ["name", "fileIds", "confidence"]) ||
			typeof category.name !== "string" ||
			!category.name.trim() ||
			category.name.length > MAX_DESTINATION_LENGTH ||
			!Array.isArray(category.fileIds) ||
			category.fileIds.length > SORT_PLAN_MAX_FILES ||
			!category.fileIds.every(
				(id) =>
					typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH,
			) ||
			new Set(category.fileIds).size !== category.fileIds.length ||
			!(["high", "medium", "low"] as unknown[]).includes(category.confidence)
		) {
			throw new Error("Invalid sort-plan category");
		}
		return {
			name: category.name,
			fileIds: category.fileIds,
			confidence: category.confidence as "high" | "medium" | "low",
		};
	});
	if (
		!value.unassignedFileIds.every(
			(id) =>
				typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH,
		) ||
		new Set(value.unassignedFileIds).size !== value.unassignedFileIds.length
	) {
		throw new Error("Invalid unassigned file IDs");
	}
	return { categories, unassignedFileIds: value.unassignedFileIds };
}

export function groundSortPlan(
	plan: SortPlan,
	suppliedIds: Set<string>,
): SortPlan {
	const seen = new Set<string>();
	for (const category of plan.categories) {
		if (!isSafeFolderName(category.name)) {
			throw new LlmStructuredOutputError(
				"Sort plan contained an unsafe destination name",
			);
		}
		for (const id of category.fileIds)
			assertGroundedOnce(id, suppliedIds, seen);
	}
	for (const id of plan.unassignedFileIds)
		assertGroundedOnce(id, suppliedIds, seen);
	return plan;
}

function assertGroundedOnce(
	id: string,
	suppliedIds: Set<string>,
	seen: Set<string>,
): void {
	if (!suppliedIds.has(id) || seen.has(id)) {
		throw new LlmStructuredOutputError(
			"Sort plan referenced an unknown or duplicate file ID",
		);
	}
	seen.add(id);
}

function isSafeFolderName(name: string): boolean {
	const trimmed = name.trim();
	return (
		trimmed === name &&
		trimmed !== "." &&
		trimmed !== ".." &&
		!name.includes("/") &&
		!name.includes("\\") &&
		![...name].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	);
}

export const sortPlanResponseSchema = {
	name: "untie_sort_plan",
	schema: SORT_PLAN_SCHEMA,
	parse: parseSortPlan,
};
