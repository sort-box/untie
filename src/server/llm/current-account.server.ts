import { auth } from "@clerk/tanstack-react-start/server";
import { ConvexTokenQuotaStore } from "./convex-token-quota.server";
import { LlmAuthenticationError, LlmConfigurationError } from "./errors";
import { OpenRouterService } from "./openrouter";
import type { LlmService } from "./types";
import { UsageLimitedLlmService } from "./usage-limited";

export async function createCurrentAccountLlmService(): Promise<LlmService> {
	const authState = await auth();
	if (!authState.isAuthenticated) throw new LlmAuthenticationError();

	const token = await authState.getToken(
		hasConvexAudience(authState.sessionClaims.aud)
			? undefined
			: { template: "convex" },
	);
	if (!token) throw new LlmAuthenticationError();

	const openRouterApiKey = process.env.OPENROUTER_API_KEY;
	if (!openRouterApiKey) {
		throw new LlmConfigurationError("OPENROUTER_API_KEY is required");
	}
	const convexUrl = process.env.VITE_CONVEX_URL;
	if (!convexUrl) {
		throw new LlmConfigurationError("VITE_CONVEX_URL is required");
	}

	return new UsageLimitedLlmService(
		new OpenRouterService({ apiKey: openRouterApiKey, appName: "Untie" }),
		new ConvexTokenQuotaStore({ convexUrl, token }),
	);
}

function hasConvexAudience(audience: unknown): boolean {
	return Array.isArray(audience)
		? audience.some((value) => value === "convex")
		: audience === "convex";
}
