import { describe, expect, it, vi } from "vitest";
import type { LlmResult, LlmService, StructuredLlmRequest } from "./types";
import {
	estimateInputTokens,
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
		expect(service.generateText).toHaveBeenCalledWith(request);
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
		).rejects.toBe(expected);
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
});
