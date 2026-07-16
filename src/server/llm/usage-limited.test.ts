import { describe, expect, it, vi } from "vitest";
import { LlmCancelledError } from "./errors";
import type { LlmResult, LlmService, StructuredLlmRequest } from "./types";
import {
	estimateInputTokens,
	LlmAccountQuotaError,
	type TokenQuotaReservation,
	type TokenQuotaStore,
	UsageLimitedLlmService,
} from "./usage-limited";

function textResult(totalTokens?: number): LlmResult<string> {
	return {
		data: "ok",
		requestId: "request-1",
		model: "test-model",
		finishReason: "stop",
		usage: totalTokens === undefined ? undefined : { totalTokens },
	};
}

function setup(result: LlmResult<string> = textResult(125)) {
	const reservation: TokenQuotaReservation = {
		id: "reservation-1",
		reservedTokens: 4_100,
	};
	const quota: TokenQuotaStore = {
		reserve: vi.fn(async () => reservation),
		settle: vi.fn(async () => undefined),
	};
	const generateText = vi.fn(async () => result);
	const service: LlmService = {
		generateText,
		async generateObject<T>(request: StructuredLlmRequest<T>) {
			return { ...result, data: request.responseSchema.parse({ ok: true }) };
		},
	};

	return {
		limited: new UsageLimitedLlmService(service, quota),
		quota,
		service,
		generateText,
	};
}

describe("UsageLimitedLlmService", () => {
	it("reserves an input estimate and output ceiling before generation", async () => {
		const { limited, quota, service } = setup();
		const request = {
			messages: [{ role: "user" as const, content: "12345678" }],
			maxTokens: 100,
		};

		await limited.generateText(request);

		expect(quota.reserve).toHaveBeenCalledWith(124);
		expect(service.generateText).toHaveBeenCalledWith({
			...request,
			requestId: expect.any(String),
		});
		expect(quota.settle).toHaveBeenCalledWith(
			expect.objectContaining({ id: "reservation-1" }),
			125,
		);
	});

	it("charges the reservation when OpenRouter omits usage", async () => {
		const { limited, quota } = setup(textResult());
		await limited.generateText({
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(quota.settle).toHaveBeenCalledWith(
			expect.objectContaining({ id: "reservation-1" }),
			4_100,
		);
	});

	it("releases the reservation when generation fails", async () => {
		const expected = new Error("provider failed");
		const { limited, quota, generateText } = setup();
		generateText.mockRejectedValueOnce(expected);

		await expect(
			limited.generateText({
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toMatchObject({
			code: "REQUEST_FAILED",
			retryable: true,
			cause: expected,
			requestId: expect.any(String),
		});
		expect(quota.settle).toHaveBeenCalledWith(
			expect.objectContaining({ id: "reservation-1" }),
			0,
		);
	});

	it("includes the JSON schema in structured request estimates", async () => {
		const { limited, quota } = setup();
		const schema = { type: "object", required: ["category"] };
		const request = {
			messages: [{ role: "user" as const, content: "Classify" }],
			maxTokens: 50,
			responseSchema: {
				name: "classification",
				schema,
				parse: (value: unknown) => value,
			},
		};

		await limited.generateObject(request);

		expect(quota.reserve).toHaveBeenCalledWith(
			estimateInputTokens(request, JSON.stringify(schema).length),
		);
	});

	it("rejects a request over quota with a typed error before generation", async () => {
		const { limited, quota, generateText } = setup();
		vi.mocked(quota.reserve).mockRejectedValueOnce(
			new LlmAccountQuotaError({ limit: 100, remaining: 5, resetsAt: 123 }),
		);

		await expect(
			limited.generateText({
				messages: [{ role: "user", content: "sensitive prompt" }],
				maxTokens: 10,
			}),
		).rejects.toMatchObject({
			code: "ACCOUNT_TOKEN_QUOTA_EXCEEDED",
			classification: "terminal",
			requestId: expect.any(String),
			limit: 100,
			remaining: 5,
			resetsAt: 123,
		});
		expect(generateText).not.toHaveBeenCalled();
	});

	it("does not let concurrent requests overspend the reserved quota", async () => {
		let remaining = 75;
		let nextReservation = 0;
		const quota: TokenQuotaStore = {
			reserve: vi.fn(async (requestedTokens) => {
				if (requestedTokens > remaining) {
					throw new LlmAccountQuotaError({
						limit: 75,
						remaining,
						resetsAt: 123,
					});
				}
				remaining -= requestedTokens;
				return {
					id: `reservation-${++nextReservation}`,
					reservedTokens: requestedTokens,
				};
			}),
			settle: vi.fn(async () => undefined),
		};
		const generateText = vi.fn(async () => textResult(10));
		const service: LlmService = {
			generateText,
			async generateObject<T>(request: StructuredLlmRequest<T>) {
				return {
					...textResult(10),
					data: request.responseSchema.parse({}),
				};
			},
		};
		const limited = new UsageLimitedLlmService(service, quota);
		const request = {
			messages: [{ role: "user" as const, content: "x" }],
			maxTokens: 40,
		};

		const results = await Promise.allSettled([
			limited.generateText(request),
			limited.generateText(request),
		]);

		expect(results[0]?.status).toBe("fulfilled");
		expect(results[1]).toMatchObject({
			status: "rejected",
			reason: { code: "ACCOUNT_TOKEN_QUOTA_EXCEEDED" },
		});
		expect(generateText).toHaveBeenCalledTimes(1);
	});

	it("never writes prompt, response, filename, PII, or secrets to logs", async () => {
		const events: unknown[] = [];
		const { quota, service } = setup({
			...textResult(20),
			data: "PRIVATE_RESPONSE_CONTENT",
		});
		const limited = new UsageLimitedLlmService(service, quota, {
			accountRef: "user_opaque_123",
			logger: (event) => events.push(event),
			requestIdFactory: () => "safe-request-id",
		});

		await limited.generateText({
			model: "test/model",
			messages: [
				{
					role: "user",
					content:
						"PRIVATE_PROMPT report-secret.pdf person@example.com sk-secret-token",
				},
			],
			maxTokens: 50,
		});

		expect(events).toEqual([
			{
				accountRef: "user_opaque_123",
				requestId: "safe-request-id",
				model: "test/model",
				status: "completed",
				reservedTokens: 4_100,
				actualTokens: 20,
			},
		]);
		const output = JSON.stringify(events);
		for (const sensitive of [
			"PRIVATE_PROMPT",
			"PRIVATE_RESPONSE_CONTENT",
			"report-secret.pdf",
			"person@example.com",
			"sk-secret-token",
		]) {
			expect(output).not.toContain(sensitive);
		}
	});

	it("settles a quota reservation after caller cancellation", async () => {
		const reservation = { id: "reservation-cancel", reservedTokens: 100 };
		const quota: TokenQuotaStore = {
			reserve: vi.fn(async () => reservation),
			settle: vi.fn(async () => undefined),
		};
		let receivedSignal: AbortSignal | undefined;
		const service: LlmService = {
			generateText: vi.fn(async (request): Promise<LlmResult<string>> => {
				receivedSignal = request.signal;
				return await new Promise((_resolve, reject) => {
					request.signal?.addEventListener("abort", () =>
						reject(new LlmCancelledError()),
					);
				});
			}),
			generateObject: vi.fn(),
		};
		const limited = new UsageLimitedLlmService(service, quota, {
			requestIdFactory: () => "cancel-lifecycle-id",
		});
		const controller = new AbortController();
		const result = limited.generateText({
			messages: [{ role: "user", content: "Hello" }],
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(receivedSignal).toBeDefined());
		controller.abort();
		await expect(result).rejects.toMatchObject({
			code: "REQUEST_CANCELLED",
			requestId: "cancel-lifecycle-id",
		});
		expect(receivedSignal?.aborted).toBe(true);
		expect(quota.settle).toHaveBeenCalledWith(reservation, 0);
	});
});
