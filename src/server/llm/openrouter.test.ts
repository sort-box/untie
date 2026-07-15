import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_OPENROUTER_MODEL,
	LlmConfigurationError,
	LlmRateLimitError,
	LlmRequestError,
	LlmResponseError,
	LlmStructuredOutputError,
	OpenRouterService,
} from "./index";

const API_KEY = "sk-or-v1-secret-value";

function completion(
	content = "Hello",
	overrides: Record<string, unknown> = {},
) {
	return {
		id: "generation-1",
		model: DEFAULT_OPENROUTER_MODEL,
		choices: [
			{
				message: { content },
				finish_reason: "stop",
			},
		],
		usage: {
			prompt_tokens: 4,
			completion_tokens: 2,
			total_tokens: 6,
		},
		cost: 0.000012,
		...overrides,
	};
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("OpenRouterService", () => {
	it("sends a text completion using the default model", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(completion()),
		);
		const service = new OpenRouterService({
			apiKey: API_KEY,
			fetch: fetchMock,
		});

		const result = await service.generateText({
			messages: [{ role: "user", content: "Say hello" }],
			maxTokens: 20,
		});

		expect(result).toEqual({
			data: "Hello",
			requestId: "generation-1",
			model: DEFAULT_OPENROUTER_MODEL,
			finishReason: "stop",
			usage: {
				promptTokens: 4,
				completionTokens: 2,
				totalTokens: 6,
			},
			cost: 0.000012,
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(init?.headers).toMatchObject({
			Authorization: `Bearer ${API_KEY}`,
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: DEFAULT_OPENROUTER_MODEL,
			stream: false,
			max_tokens: 20,
		});
	});

	it("supports model overrides and attribution headers", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(completion("Done", { model: "openai/custom-model" })),
		);
		const service = new OpenRouterService({
			apiKey: API_KEY,
			fetch: fetchMock,
			appUrl: "https://untie.example",
			appName: "Untie",
		});

		await service.generateText({
			model: "openai/custom-model",
			messages: [{ role: "system", content: "Be concise" }],
		});

		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(init?.headers).toMatchObject({
			"HTTP-Referer": "https://untie.example",
			"X-OpenRouter-Title": "Untie",
		});
		expect(JSON.parse(String(init?.body)).model).toBe("openai/custom-model");
	});

	it("requests and locally validates strict structured output", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				jsonResponse(completion('{"category":"document"}')),
		);
		const service = new OpenRouterService({
			apiKey: API_KEY,
			fetch: fetchMock,
		});

		const result = await service.generateObject({
			messages: [{ role: "user", content: "Classify report.pdf" }],
			responseSchema: {
				name: "file_category",
				schema: {
					type: "object",
					properties: { category: { type: "string" } },
					required: ["category"],
					additionalProperties: false,
				},
				parse(value) {
					if (
						typeof value !== "object" ||
						value === null ||
						!("category" in value) ||
						typeof value.category !== "string"
					) {
						throw new Error("Invalid category");
					}
					return { category: value.category };
				},
			},
		});

		expect(result.data).toEqual({ category: "document" });
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body))).toMatchObject({
			provider: { require_parameters: true },
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "file_category",
					strict: true,
				},
			},
		});
	});

	it("rejects invalid JSON and parser failures", async () => {
		const invalidJsonService = new OpenRouterService({
			apiKey: API_KEY,
			fetch: vi.fn(async () => jsonResponse(completion("not-json"))),
		});
		const request = {
			messages: [{ role: "user" as const, content: "Classify" }],
			responseSchema: {
				name: "result",
				schema: { type: "object" },
				parse: (value: unknown) => value,
			},
		};

		await expect(
			invalidJsonService.generateObject(request),
		).rejects.toBeInstanceOf(LlmStructuredOutputError);

		const invalidShapeService = new OpenRouterService({
			apiKey: API_KEY,
			fetch: vi.fn(async () => jsonResponse(completion("{}"))),
		});
		await expect(
			invalidShapeService.generateObject({
				...request,
				responseSchema: {
					...request.responseSchema,
					parse: () => {
						throw new Error("wrong shape");
					},
				},
			}),
		).rejects.toBeInstanceOf(LlmStructuredOutputError);
	});

	it.each([401, 402, 500])("normalizes HTTP %s failures", async (status) => {
		const service = new OpenRouterService({
			apiKey: API_KEY,
			fetch: vi.fn(async () => jsonResponse({ error: API_KEY }, { status })),
		});

		const error = await service
			.generateText({ messages: [{ role: "user", content: "Hello" }] })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LlmRequestError);
		expect(error).toMatchObject({ status });
		expect(String(error)).not.toContain(API_KEY);
	});

	it.each([
		429, 503,
	])("preserves retry metadata for HTTP %s", async (status) => {
		const service = new OpenRouterService({
			apiKey: API_KEY,
			fetch: vi.fn(async () =>
				jsonResponse({}, { status, headers: { "Retry-After": "12" } }),
			),
		});

		const error = await service
			.generateText({ messages: [{ role: "user", content: "Hello" }] })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LlmRateLimitError);
		expect(error).toMatchObject({ status, retryAfterSeconds: 12 });
	});

	it("handles malformed and non-JSON success responses", async () => {
		const malformed = new OpenRouterService({
			apiKey: API_KEY,
			fetch: vi.fn(async () => jsonResponse({ choices: [] })),
		});
		await expect(
			malformed.generateText({
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toBeInstanceOf(LlmResponseError);

		const nonJson = new OpenRouterService({
			apiKey: API_KEY,
			fetch: vi.fn(async () => new Response("bad", { status: 200 })),
		});
		await expect(
			nonJson.generateText({
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toBeInstanceOf(LlmResponseError);
	});

	it("handles aborts and timeouts", async () => {
		const pendingFetch = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					if (init?.signal?.aborted) {
						reject(new DOMException("Aborted", "AbortError"));
						return;
					}
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		const service = new OpenRouterService({
			apiKey: API_KEY,
			fetch: pendingFetch,
		});

		await expect(
			service.generateText({
				messages: [{ role: "user", content: "Hello" }],
				timeoutMs: 1,
			}),
		).rejects.toMatchObject({
			code: "REQUEST_FAILED",
			message: "OpenRouter request timed out",
		});

		const controller = new AbortController();
		controller.abort();
		await expect(
			service.generateText({
				messages: [{ role: "user", content: "Hello" }],
				signal: controller.signal,
			}),
		).rejects.toMatchObject({
			code: "REQUEST_FAILED",
			message: "OpenRouter request was aborted",
		});
	});

	it("rejects invalid configuration", async () => {
		expect(() => new OpenRouterService({ apiKey: " " })).toThrow(
			LlmConfigurationError,
		);

		const service = new OpenRouterService({ apiKey: API_KEY });
		await expect(service.generateText({ messages: [] })).rejects.toBeInstanceOf(
			LlmConfigurationError,
		);
	});
});
