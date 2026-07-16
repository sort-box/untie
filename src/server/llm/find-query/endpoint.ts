import { createServerFn } from "@tanstack/react-start";
import { validateFindQueryInput } from "./schema";

export const interpretFindQueryEndpoint = createServerFn({ method: "POST" })
	.validator(validateFindQueryInput)
	.handler(async ({ data }) => {
		const { getRequest } = await import("@tanstack/react-start/server");
		const { interpretCurrentAccountFindQuery } = await import(
			"./interpret.server"
		);
		return interpretCurrentAccountFindQuery(data, getRequest().signal);
	});
