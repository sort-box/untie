import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCapabilityRegistry } = require("./registry.cjs");
const { CapabilityAuthorizationError } = require("./authorization.cjs");

describe("capability registry", () => {
	it("validates requests and never passes renderer paths to a handler", async () => {
		let called = false;
		const registry = createCapabilityRegistry({
			scanFolder: async () => {
				called = true;
				return {};
			},
		});

		const result = await registry.invoke(undefined, {
			requestId: "1",
			capability: "scanFolder",
			input: { grantId: "grant-1", path: "/private/secret" },
		});

		expect(result).toEqual({
			ok: false,
			error: {
				code: "PATH_SUPPLIED",
				message: "Filesystem paths are not capabilities",
			},
		});
		expect(called).toBe(false);
	});

	it("routes handlers through authorization and preserves structured rejection", async () => {
		let called = false;
		const registry = createCapabilityRegistry(
			{
				openItem: async () => {
					called = true;
					return { opened: true };
				},
			},
			{
				authorize: () => {
					throw new CapabilityAuthorizationError(
						"REVOKED_GRANT",
						"The backing folder grant is missing or revoked",
					);
				},
			},
		);

		await expect(
			registry.invoke(undefined, {
				requestId: "authorize",
				capability: "openItem",
				input: { itemId: "item-1" },
			}),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "REVOKED_GRANT",
				message: "The backing folder grant is missing or revoked",
			},
		});
		expect(called).toBe(false);
	});

	it("rejects a raw path placed in an opaque ID field before the handler", async () => {
		let called = false;
		const registry = createCapabilityRegistry({
			openItem: async () => {
				called = true;
				return { opened: true };
			},
		});

		await expect(
			registry.invoke(undefined, {
				requestId: "raw-path-id",
				capability: "openItem",
				input: { itemId: "/Users/alice/private.txt" },
			}),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "PATH_SUPPLIED",
				message: "Filesystem paths are not capabilities",
			},
		});
		expect(called).toBe(false);
	});

	it("runs a registered typed capability on the happy path", async () => {
		const registry = createCapabilityRegistry({
			ping: async ({ message }: { message: string }) => ({ message }),
		});

		await expect(
			registry.invoke(undefined, {
				requestId: "happy",
				capability: "ping",
				input: { message: "hello" },
			}),
		).resolves.toEqual({ ok: true, value: { message: "hello" } });
	});

	it("rejects unknown names with a structured error", async () => {
		const registry = createCapabilityRegistry();
		const result = await registry.invoke(undefined, {
			requestId: "unknown",
			capability: "readFile",
			input: { path: "/private/secret" },
		});

		expect(result).toEqual({
			ok: false,
			error: {
				code: "UNKNOWN_CAPABILITY",
				message: "Unknown capability",
				details: { capability: "readFile" },
			},
		});
	});

	it("threads cancellation to a running handler", async () => {
		let receivedSignal: AbortSignal | undefined;
		const registry = createCapabilityRegistry({
			queryIndex: async (_input: unknown, context: { signal: AbortSignal }) => {
				receivedSignal = context.signal;
				await new Promise((resolve) =>
					context.signal.addEventListener("abort", resolve),
				);
				return {};
			},
		});
		const pending = registry.invoke(undefined, {
			requestId: "2",
			capability: "queryIndex",
			input: { query: "lease" },
		});

		await Promise.resolve();
		registry.cancel(undefined, "2");

		expect((await pending).error.code).toBe("CANCELLED");
		expect(receivedSignal?.aborted).toBe(true);
	});

	it("returns structured errors instead of leaking thrown errors", async () => {
		const registry = createCapabilityRegistry({
			openItem: async () => {
				throw new Error("/Users/alice/private.txt");
			},
		});
		const result = await registry.invoke(undefined, {
			requestId: "3",
			capability: "openItem",
			input: { itemId: "item-1" },
		});

		expect(result).toEqual({
			ok: false,
			error: { code: "INTERNAL", message: "Capability failed" },
		});
	});

	it("validates handler responses", async () => {
		const registry = createCapabilityRegistry({
			applyPlan: async () => ({ operationId: 42 }),
		});
		const result = await registry.invoke(undefined, {
			requestId: "4",
			capability: "applyPlan",
			input: { planId: "plan-1" },
		});

		expect(result).toEqual({
			ok: false,
			error: {
				code: "INVALID_RESPONSE",
				message: "Capability response failed validation",
				details: {
					capability: "applyPlan",
					reason: "response.operationId has an invalid value",
				},
			},
		});
	});

	it("rejects a grant-list response that leaks a filesystem path", async () => {
		const registry = createCapabilityRegistry({
			listFolderGrants: async () => ({
				grants: [
					{
						grantId: "grant-safe",
						state: "active",
						createdAt: 1,
						path: "/Users/alice",
					},
				],
			}),
		});
		const result = await registry.invoke(undefined, {
			requestId: "grant-path-leak",
			capability: "listFolderGrants",
			input: {},
		});

		expect(result).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE" },
		});
	});
});
