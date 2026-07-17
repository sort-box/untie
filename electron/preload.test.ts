import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("sandboxed preload bridge", () => {
	it("exposes only opaque-ID capabilities and no raw filesystem primitive", () => {
		let exposed: Record<string, unknown> | undefined;
		const ipcRenderer = {
			invoke: vi.fn(),
			send: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const context = {
			AbortController,
			Object,
			Promise,
			process: { platform: "darwin" },
			require(specifier: string) {
				if (specifier === "electron") {
					return {
						contextBridge: {
							exposeInMainWorld(name: string, value: Record<string, unknown>) {
								if (name === "untie") exposed = value;
							},
						},
						ipcRenderer,
					};
				}
				if (specifier.endsWith("contracts.cjs")) {
					return require("./capabilities/contracts.cjs");
				}
				return require("./capabilities/registry.cjs");
			},
		};

		vm.runInNewContext(readFileSync("electron/preload.cjs", "utf8"), context);

		expect(Object.keys(exposed ?? {}).sort()).toEqual(
			[
				"acknowledgeFolderRisk",
				"applyPlan",
				"cancellableDelay",
				"classifyFolderRisk",
				"deleteAllChatData",
				"deleteAllLocalData",
				"deleteChatSession",
				"getStartupStatus",
				"getIndexStatus",
				"listChatSessions",
				"listFolderGrants",
				"loadChatSession",
				"openItem",
				"ping",
				"preparePlan",
				"queryIndex",
				"revealItem",
				"revokeFolderGrant",
				"saveChatSession",
				"scanFolder",
				"selectFolder",
				"subscribeIndexStatus",
				"undo",
			].sort(),
		);
		for (const forbidden of [
			"read",
			"readFile",
			"writeFile",
			"write",
			"move",
			"rename",
			"readdir",
			"stat",
			"delete",
			"openPath",
			"fs",
			"path",
		]) {
			expect(exposed).not.toHaveProperty(forbidden);
		}
		expect(exposed?.move).toBeUndefined();
	});

	it("sends cancellation for an in-flight request", async () => {
		let exposed: Record<string, CallableFunction> | undefined;
		let resolveInvoke: ((value: unknown) => void) | undefined;
		const ipcRenderer = {
			invoke: vi.fn(
				() =>
					new Promise((resolve) => {
						resolveInvoke = resolve;
					}),
			),
			send: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const context = {
			AbortController,
			Object,
			Promise,
			process: { platform: "darwin" },
			require(specifier: string) {
				if (specifier === "electron") {
					return {
						contextBridge: {
							exposeInMainWorld(
								name: string,
								value: Record<string, CallableFunction>,
							) {
								if (name === "untie") exposed = value;
							},
						},
						ipcRenderer,
					};
				}
				if (specifier.endsWith("contracts.cjs")) {
					return require("./capabilities/contracts.cjs");
				}
				return require("./capabilities/registry.cjs");
			},
		};
		vm.runInNewContext(readFileSync("electron/preload.cjs", "utf8"), context);
		const controller = new AbortController();
		const pending = exposed?.cancellableDelay(
			{ milliseconds: 1000 },
			{ signal: controller.signal },
		);

		controller.abort();
		expect(ipcRenderer.send).toHaveBeenCalledWith(
			"untie:capability:cancel",
			"renderer-1",
		);
		resolveInvoke?.({ ok: false, error: { code: "CANCELLED" } });
		await pending;
	});
});
