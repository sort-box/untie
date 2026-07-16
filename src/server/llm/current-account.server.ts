import { privacyLogger } from "../../../privacy-log.cjs";
import { ServerAuthError } from "../auth/errors";
import { requireServerIdentity } from "../auth/identity.server";
import { ConvexTokenQuotaStore } from "./convex-token-quota.server";
import {
	LlmAuthenticationError,
	LlmConfigurationError,
	LlmSessionExpiredError,
} from "./errors";
import { OpenRouterService } from "./openrouter";
import type { LlmService } from "./types";
import { UsageLimitedLlmService } from "./usage-limited";

export async function createCurrentAccountLlmService(): Promise<LlmService> {
	let identity: Awaited<ReturnType<typeof requireServerIdentity>>;
	let token: string;
	try {
		identity = await requireServerIdentity();
		token = await identity.getToken(
			hasConvexAudience(identity.tokenAudience)
				? undefined
				: { template: "convex" },
		);
	} catch (error) {
		if (error instanceof ServerAuthError) {
			throw error.code === "SESSION_EXPIRED"
				? new LlmSessionExpiredError()
				: new LlmAuthenticationError();
		}
		throw error;
	}

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
		{ accountRef: identity.userId, logger: logLlmGatewayEvent },
	);
}

function logLlmGatewayEvent(event: {
	accountRef: string;
	model: string;
	status: "completed" | "failed" | "quota_exhausted";
	reservedTokens: number;
	actualTokens?: number;
}): void {
	privacyLogger.log("info", "llm_gateway", event);
}

function hasConvexAudience(audience: unknown): boolean {
	return Array.isArray(audience)
		? audience.some((value) => value === "convex")
		: audience === "convex";
}
