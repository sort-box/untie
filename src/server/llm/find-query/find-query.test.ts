import { describe, expect, it, vi } from "vitest";
import { LlmConfigurationError } from "../errors";
import type { LlmService, StructuredLlmRequest } from "../types";
import { FIND_QUERY_INJECTION_FIXTURES } from "./fixtures";
import { FIND_QUERY_TIMEOUT_MS, interpretFindQuery } from "./interpret.server";
import { buildFindQueryMessages } from "./prompt";
import { FIND_QUERY_MAX_LENGTH, parseFindQueryInterpretation } from "./schema";

const validRaw = {
	searchTerms: ["apartment", "lease"],
	filters: {
		extensions: [".PDF", "pdf"],
		namePatterns: ["*lease*"],
		modifiedAt: { after: "2025-01-01", before: "2025-12-31" },
	},
	clarification: null,
};

function fakeService(
	raw: unknown,
	observe?: (request: StructuredLlmRequest<unknown>) => void,
): LlmService {
	const implementation: LlmService["generateObject"] = async <T>(
		request: StructuredLlmRequest<T>,
	) => {
		observe?.(request as StructuredLlmRequest<unknown>);
		return {
			data: request.responseSchema.parse(raw),
			requestId: "offline-find",
			model: "mock",
			finishReason: "stop",
		};
	};
	return {
		generateText: vi.fn(),
		generateObject: vi.fn(implementation) as LlmService["generateObject"],
	};
}

describe("find query interpretation", () => {
	it("strictly validates and normalizes terms and filters", () => {
		expect(parseFindQueryInterpretation(validRaw)).toEqual({
			status: "ready",
			searchTerms: ["apartment", "lease"],
			filters: {
				extensions: ["pdf"],
				namePatterns: ["*lease*"],
				modifiedAt: { after: "2025-01-01", before: "2025-12-31" },
			},
			clarification: null,
		});
		expect(() =>
			parseFindQueryInterpretation({ ...validRaw, extra: true }),
		).toThrow();
		expect(() =>
			parseFindQueryInterpretation({
				...validRaw,
				filters: {
					...validRaw.filters,
					modifiedAt: { after: "2026-01-01", before: "2025-01-01" },
				},
			}),
		).toThrow();
	});

	it("rejects malicious model output that escapes the validated shape", () => {
		const withFilters = (filters: Record<string, unknown>) => ({
			...validRaw,
			filters: { ...validRaw.filters, ...filters },
		});
		// Extension carrying a path (index escape) or a wildcard.
		expect(() =>
			parseFindQueryInterpretation(
				withFilters({ extensions: ["/etc/passwd"] }),
			),
		).toThrow();
		expect(() =>
			parseFindQueryInterpretation(withFilters({ extensions: [".*"] })),
		).toThrow();
		// Oversized array beyond the item cap.
		expect(() =>
			parseFindQueryInterpretation(
				withFilters({
					extensions: Array.from({ length: 13 }, (_, index) => `e${index}`),
				}),
			),
		).toThrow();
		// Control character in a search term.
		expect(() =>
			parseFindQueryInterpretation({
				...validRaw,
				searchTerms: ["ok\u0007bad"],
			}),
		).toThrow();
		// Name patterns must be filename globs, never paths.
		expect(() =>
			parseFindQueryInterpretation(withFilters({ namePatterns: ["../../*"] })),
		).toThrow();
		expect(() =>
			parseFindQueryInterpretation(withFilters({ namePatterns: ["a\\b"] })),
		).toThrow();
		// Pathological glob (ReDoS-shaped) rejected by the metacharacter cap.
		expect(() =>
			parseFindQueryInterpretation(
				withFilters({ namePatterns: ["*?*?*?*?*?[a][b]"] }),
			),
		).toThrow();
	});

	it("returns a typed clarification for empty input without a model call", async () => {
		const service = fakeService(validRaw);
		const result = await interpretFindQuery({ query: "  \n" }, { service });
		expect(result).toMatchObject({
			status: "needs_clarification",
			searchTerms: [],
		});
		expect(service.generateObject).not.toHaveBeenCalled();
	});

	it("keeps an ambiguous query as a best-effort ready result", async () => {
		const result = await interpretFindQuery(
			{ query: "that report" },
			{
				service: fakeService({
					searchTerms: ["report"],
					filters: {
						extensions: [],
						namePatterns: ["*report*"],
						modifiedAt: null,
					},
					clarification: "Do you remember the topic or approximate date?",
				}),
			},
		);
		expect(result).toMatchObject({ status: "ready", searchTerms: ["report"] });
	});

	it("rejects oversized payloads before calling the model", async () => {
		const service = fakeService(validRaw);
		await expect(
			interpretFindQuery(
				{ query: "x".repeat(FIND_QUERY_MAX_LENGTH + 1) },
				{ service },
			),
		).rejects.toBeInstanceOf(LlmConfigurationError);
		expect(service.generateObject).not.toHaveBeenCalled();
	});

	it("threads cancellation and a bounded timeout to the gateway", async () => {
		const controller = new AbortController();
		let observed: StructuredLlmRequest<unknown> | undefined;
		const cancellationService: LlmService = {
			generateText: vi.fn(),
			generateObject: vi.fn(async <T>(request: StructuredLlmRequest<T>) => {
				observed = request as StructuredLlmRequest<unknown>;
				return await new Promise((_, reject) => {
					request.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
				});
			}) as LlmService["generateObject"],
		};
		const pending = interpretFindQuery(
			{ query: "lease" },
			{ service: cancellationService, signal: controller.signal },
		);
		controller.abort("cancelled");
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(observed?.signal).toBe(controller.signal);
		expect(observed?.signal?.aborted).toBe(true);
		expect(observed?.timeoutMs).toBe(FIND_QUERY_TIMEOUT_MS);
	});

	it.each(
		FIND_QUERY_INJECTION_FIXTURES,
	)("delimits injection fixture $id and stays on schema", async ({ query }) => {
		const messages = buildFindQueryMessages(query, "2026-07-16");
		expect(messages[0]?.content).toContain("UNTRUSTED DATA");
		expect(messages[1]?.content).toContain("<untrusted_find_query>");
		expect(messages[1]?.content).toContain(
			JSON.stringify({ query }).replaceAll("<", "\\u003c"),
		);
		expect(
			messages[1]?.content.match(/<\/untrusted_find_query>/gu),
		).toHaveLength(1);
		const result = await interpretFindQuery(
			{ query },
			{ service: fakeService(validRaw) },
		);
		expect(Object.keys(result).sort()).toEqual([
			"clarification",
			"filters",
			"searchTerms",
			"status",
		]);
		expect(JSON.stringify(result)).not.toContain("/etc/passwd");
		expect(JSON.stringify(result)).not.toContain("/Users/me/Secrets");
	});
});
