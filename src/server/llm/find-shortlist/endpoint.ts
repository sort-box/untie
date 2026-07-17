import { createServerFn } from "@tanstack/react-start";
import { validateRankFindShortlistInput } from "./schema";

export const rankFindShortlistEndpoint = createServerFn({ method: "POST" })
	.validator(validateRankFindShortlistInput)
	.handler(async ({ data }) => {
		const { getRequest } = await import("@tanstack/react-start/server");
		const { rankCurrentAccountFindShortlist } = await import("./rank.server");
		return rankCurrentAccountFindShortlist(data, getRequest().signal);
	});
