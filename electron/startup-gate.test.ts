import { describe, expect, it, vi } from "vitest";

const {
	runStartupGate,
}: typeof import("./startup-gate.cjs") = require("./startup-gate.cjs");

function checks(overrides: Record<string, unknown> = {}) {
	return {
		initializeStores: vi.fn(() => ({ preserved: true })),
		restoreGrants: vi.fn(() => []),
		recoverJournals: vi.fn(() => ({ recoveredCount: 0, needsAttention: [] })),
		checkAuth: vi.fn(() => "authenticated" as const),
		checkOnboarding: vi.fn(() => "complete" as const),
		...overrides,
	};
}

describe("startup gate", () => {
	it("fails safe on migration failure without running later checks", async () => {
		const options = checks({
			initializeStores: vi.fn(() => {
				throw Object.assign(new Error("boom"), {
					code: "STORE_MIGRATION_FAILED",
					store: "chat",
				});
			}),
		});
		const result = await runStartupGate(options);
		expect(result).toMatchObject({
			status: "blocked",
			reasons: ["migration_failure"],
			detail: { code: "STORE_MIGRATION_FAILED", store: "chat" },
		});
		expect(options.restoreGrants).not.toHaveBeenCalled();
	});

	it("surfaces unavailable grants", async () => {
		const result = await runStartupGate(
			checks({ restoreGrants: vi.fn(() => [{ state: "missing" }]) }),
		);
		expect(result).toMatchObject({
			status: "needs_attention",
			reasons: ["unavailable_grant"],
			needsAttentionCount: 1,
		});
	});

	it("blocks an expired authenticated session", async () => {
		const result = await runStartupGate(
			checks({ checkAuth: vi.fn(() => "expired") }),
		);
		expect(result).toMatchObject({
			status: "blocked",
			reasons: ["expired_auth"],
		});
	});

	it("blocks interrupted onboarding", async () => {
		const result = await runStartupGate(
			checks({ checkOnboarding: vi.fn(() => "interrupted") }),
		);
		expect(result).toMatchObject({
			status: "blocked",
			reasons: ["interrupted_onboarding"],
		});
	});

	it("reports clean recovery after every check resolves", async () => {
		const result = await runStartupGate(
			checks({
				recoverJournals: vi.fn(() => ({
					recoveredCount: 2,
					needsAttention: [],
				})),
			}),
		);
		expect(result).toEqual({
			status: "recovered",
			reasons: [],
			recoveredBatchCount: 2,
			needsAttentionCount: 0,
		});
	});
});
