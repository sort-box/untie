import { describe, expect, it } from "vitest";
import {
	LlmAccountQuotaError,
	LlmAuthenticationError,
	LlmCancelledError,
	LlmConfigurationError,
	LlmOfflineError,
	LlmRateLimitError,
	LlmRequestError,
	LlmResponseError,
	LlmSessionExpiredError,
	LlmStructuredOutputError,
	LlmTimeoutError,
} from "./errors";

describe("LLM failure classification", () => {
	it.each([
		new LlmRateLimitError(429),
		new LlmRequestError("server failure", 500),
		new LlmRequestError("network failure", undefined, { retryable: true }),
		new LlmTimeoutError(),
		new LlmOfflineError(),
	])("classifies $code as retryable", (error) => {
		expect(error).toMatchObject({
			retryable: true,
			classification: "retryable",
		});
	});

	it.each([
		new LlmRequestError("bad request", 400),
		new LlmAuthenticationError(),
		new LlmSessionExpiredError(),
		new LlmAccountQuotaError({ limit: 10, remaining: 0, resetsAt: 20 }),
		new LlmConfigurationError("invalid request"),
		new LlmResponseError("invalid response"),
		new LlmStructuredOutputError("invalid structure"),
		new LlmCancelledError(),
	])("classifies $code as terminal", (error) => {
		expect(error).toMatchObject({
			retryable: false,
			classification: "terminal",
		});
	});
});
