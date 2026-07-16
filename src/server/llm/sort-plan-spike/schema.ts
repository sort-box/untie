import type { JsonSchema } from "../types";
import type { SortPlan } from "./types";

export const SORT_PLAN_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		categories: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1, maxLength: 80 },
					fileIds: {
						type: "array",
						items: { type: "string" },
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
			items: { type: "string" },
			uniqueItems: true,
		},
	},
	required: ["categories", "unassignedFileIds"],
	additionalProperties: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseSortPlan(value: unknown): SortPlan {
	if (!isRecord(value) || !Array.isArray(value.categories)) {
		throw new Error("Plan must contain categories");
	}
	if (!Array.isArray(value.unassignedFileIds)) {
		throw new Error("Plan must contain unassignedFileIds");
	}
	const categories = value.categories.map((category) => {
		if (!isRecord(category)) throw new Error("Invalid category");
		if (
			typeof category.name !== "string" ||
			category.name.trim().length === 0 ||
			category.name.length > 80 ||
			!Array.isArray(category.fileIds) ||
			!category.fileIds.every((id) => typeof id === "string") ||
			!(["high", "medium", "low"] as unknown[]).includes(category.confidence)
		) {
			throw new Error("Invalid category fields");
		}
		if (new Set(category.fileIds).size !== category.fileIds.length) {
			throw new Error("Duplicate ID within category");
		}
		return {
			name: category.name,
			fileIds: category.fileIds,
			confidence: category.confidence as "high" | "medium" | "low",
		};
	});
	if (!value.unassignedFileIds.every((id) => typeof id === "string")) {
		throw new Error("Invalid unassigned ID");
	}
	return { categories, unassignedFileIds: value.unassignedFileIds };
}

export const sortPlanResponseSchema = {
	name: "untie_sort_plan",
	schema: SORT_PLAN_SCHEMA,
	parse: parseSortPlan,
};
