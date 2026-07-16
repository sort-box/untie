import { createServerFn } from "@tanstack/react-start";
import { validateGenerateSortPlanInput } from "./schema";

export const generateSortPlanEndpoint = createServerFn({ method: "POST" })
	.validator(validateGenerateSortPlanInput)
	.handler(async ({ data }) => {
		const { getRequest } = await import("@tanstack/react-start/server");
		const { generateCurrentAccountSortPlan } = await import(
			"./generate.server"
		);
		return generateCurrentAccountSortPlan(data, getRequest().signal);
	});
