import { describe, expect, it, vi } from "vitest";
import type { LlmService, StructuredLlmRequest } from "../types";
import { SORT_FIXTURES } from "./fixtures";
import { buildSortMessages } from "./prompt";
import { runFixture, runSpike } from "./runner";
import { parseSortPlan } from "./schema";

describe("R2 sort-plan spike", () => {
	it("validates all fixtures and recorded responses offline", async () => {
		const summary = await runSpike("");
		expect(summary.mode).toBe("offline");
		expect(summary.fixtures).toHaveLength(SORT_FIXTURES.length);
		expect(summary.precision).toBe(1);
		expect(summary.severeErrors).toBe(0);
		expect(summary.regenerations).toBe(1);
	});

	it("delimits adversarial content as untrusted data", () => {
		const fixture = SORT_FIXTURES.find(
			(item) => item.id === "injection-document-text",
		);
		if (!fixture) throw new Error("Missing fixture");
		const messages = buildSortMessages(fixture);
		expect(messages[0]?.content).toContain("UNTRUSTED DATA");
		expect(messages[1]?.content).toContain("<untrusted_folder_data>");
		expect(messages[1]?.content).not.toContain("expectedDestination");
	});

	it("rejects malformed schema and regenerates an ungrounded plan", async () => {
		expect(() => parseSortPlan({ categories: [] })).toThrow();
		let calls = 0;
		const service: LlmService = {
			generateText: vi.fn(),
			async generateObject<T>(request: StructuredLlmRequest<T>) {
				calls += 1;
				const raw =
					calls === 1
						? {
								categories: [
									{
										name: "../escape",
										fileIds: ["invented"],
										confidence: "high",
									},
								],
								unassignedFileIds: [],
							}
						: SORT_FIXTURES[0]?.recordedResponses[0];
				return {
					data: request.responseSchema.parse(raw),
					requestId: `mock-${calls}`,
					model: "mock",
					finishReason: "stop",
				};
			},
		};
		const fixture = SORT_FIXTURES[0];
		if (!fixture) throw new Error("Missing fixture");
		const score = await runFixture(fixture, service);
		expect(calls).toBe(2);
		expect(score.regenerations).toBe(1);
	});
});
