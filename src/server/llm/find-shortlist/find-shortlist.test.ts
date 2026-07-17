import { describe, expect, it, vi } from "vitest";
import { LlmConfigurationError, LlmStructuredOutputError } from "../errors";
import type { LlmService, StructuredLlmRequest } from "../types";
import { FIND_SHORTLIST_TIMEOUT_MS, rankFindShortlist } from "./rank.server";
import { FIND_SHORTLIST_MAX_CANDIDATES } from "./schema";
import type { RankFindShortlistInput } from "./types";

const validInput: RankFindShortlistInput = {
	query: {
		query: "my apartment lease",
		searchTerms: ["apartment", "lease"],
	},
	candidates: [
		{
			itemId: "opaque-lease",
			displayName: "apartment-lease.pdf",
			snippet: "Residential lease terms for the apartment",
		},
		{
			itemId: "opaque-notes",
			displayName: "moving-notes.txt",
			snippet: "Apartment moving checklist and notes",
		},
	],
};

function fakeService(
	raw: unknown,
	observe?: (request: StructuredLlmRequest<unknown>) => void,
): LlmService {
	const generateObject: LlmService["generateObject"] = async <T>(
		request: StructuredLlmRequest<T>,
	) => {
		observe?.(request as StructuredLlmRequest<unknown>);
		let data: T;
		try {
			data = request.responseSchema.parse(raw);
		} catch (error) {
			throw new LlmStructuredOutputError("Invalid structured response", {
				cause: error,
				requestId: "offline-find-shortlist",
			});
		}
		return {
			data,
			requestId: "offline-find-shortlist",
			model: "mock",
			finishReason: "stop",
		};
	};
	return {
		generateText: vi.fn(),
		generateObject: vi.fn(generateObject) as LlmService["generateObject"],
	};
}

describe("grounded find-shortlist ranking", () => {
	it("selects and ranks supplied candidates with grounded reasons", async () => {
		let observed: StructuredLlmRequest<unknown> | undefined;
		const result = await rankFindShortlist(validInput, {
			service: fakeService(
				{
					selections: [
						{
							itemId: "opaque-lease",
							matchReason: "Apartment lease terms",
							confidence: "high",
						},
						{
							itemId: "opaque-notes",
							matchReason: "Apartment moving notes",
							confidence: "low",
						},
					],
					noMatch: false,
				},
				(request) => {
					observed = request;
				},
			),
		});

		expect(result).toEqual({
			status: "ranked",
			selections: [
				{
					itemId: "opaque-lease",
					matchReason: "Apartment lease terms",
					confidence: "high",
				},
				{
					itemId: "opaque-notes",
					matchReason: "Apartment moving notes",
					confidence: "low",
				},
			],
		});
		expect(observed).toMatchObject({
			maxTokens: 1_000,
			timeoutMs: FIND_SHORTLIST_TIMEOUT_MS,
		});
		expect(observed?.responseSchema.schema).toMatchObject({
			additionalProperties: false,
		});
	});

	it("rejects an item ID that was not supplied", async () => {
		await expect(
			rankFindShortlist(validInput, {
				service: fakeService({
					selections: [
						{
							itemId: "invented-id",
							matchReason: "Apartment lease",
							confidence: "high",
						},
					],
					noMatch: false,
				}),
			}),
		).rejects.toMatchObject({ code: "STRUCTURED_OUTPUT_INVALID" });
	});

	it("rejects a duplicate supplied item ID", async () => {
		await expect(
			rankFindShortlist(validInput, {
				service: fakeService({
					selections: [
						{
							itemId: "opaque-lease",
							matchReason: "Apartment lease",
							confidence: "high",
						},
						{
							itemId: "opaque-lease",
							matchReason: "Residential lease terms",
							confidence: "medium",
						},
					],
					noMatch: false,
				}),
			}),
		).rejects.toMatchObject({ code: "STRUCTURED_OUTPUT_INVALID" });
	});

	it("rejects a fabricated reason token absent from all supplied evidence", async () => {
		await expect(
			rankFindShortlist(validInput, {
				service: fakeService({
					selections: [
						{
							itemId: "opaque-lease",
							matchReason: "Apartment lease includes a penthouse",
							confidence: "high",
						},
					],
					noMatch: false,
				}),
			}),
		).rejects.toMatchObject({ code: "STRUCTURED_OUTPUT_INVALID" });
	});

	it("accepts the adversarial counterpart when every substantive reason token is evidence", async () => {
		await expect(
			rankFindShortlist(validInput, {
				service: fakeService({
					selections: [
						{
							itemId: "opaque-lease",
							matchReason: "Residential apartment lease terms",
							confidence: "high",
						},
					],
					noMatch: false,
				}),
			}),
		).resolves.toMatchObject({ status: "ranked" });
	});

	it.each([
		{ selections: [], noMatch: false },
		{ selections: [], noMatch: true },
	])("returns a typed no-match result for $noMatch", async (raw) => {
		await expect(
			rankFindShortlist(validInput, { service: fakeService(raw) }),
		).resolves.toEqual({ status: "no_match", selections: [] });
	});

	it("returns no match without calling the model for an empty shortlist", async () => {
		const service = fakeService({ selections: [], noMatch: true });
		await expect(
			rankFindShortlist({ ...validInput, candidates: [] }, { service }),
		).resolves.toEqual({ status: "no_match", selections: [] });
		expect(service.generateObject).not.toHaveBeenCalled();
	});

	it("surfaces malformed model output as the typed structured-output error", async () => {
		await expect(
			rankFindShortlist(validInput, {
				service: fakeService({ selections: "not-an-array", noMatch: false }),
			}),
		).rejects.toBeInstanceOf(LlmStructuredOutputError);
	});

	it("validates bounded, unique, path-free candidate input before model use", async () => {
		const service = fakeService({ selections: [], noMatch: true });
		await expect(
			rankFindShortlist(
				{
					...validInput,
					candidates: [
						{ ...validInput.candidates[0], displayName: "../lease.pdf" },
					],
				},
				{ service },
			),
		).rejects.toBeInstanceOf(LlmConfigurationError);
		await expect(
			rankFindShortlist(
				{
					...validInput,
					candidates: Array.from(
						{ length: FIND_SHORTLIST_MAX_CANDIDATES + 1 },
						(_, index) => ({
							itemId: `opaque-${index}`,
							displayName: "lease.pdf",
							snippet: "lease",
						}),
					),
				},
				{ service },
			),
		).rejects.toBeInstanceOf(LlmConfigurationError);
		expect(service.generateObject).not.toHaveBeenCalled();
	});
});
