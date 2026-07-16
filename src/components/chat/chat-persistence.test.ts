import { afterEach, describe, expect, it } from "vitest";

import type {
	CapabilityClient,
	CapabilityResult,
	PersistedChatSession,
} from "../../../electron/capabilities/contracts.cjs";
import {
	deleteAllChatData,
	deleteChatSession,
	isChatPersistenceAvailable,
	listChatSessions,
	loadChatSession,
	saveChatSession,
} from "./chat-persistence";
import type { ChatMessage } from "./message-model";

const ok = <T>(value: T): CapabilityResult<T> => ({ ok: true, value });
const fail = (): CapabilityResult<never> => ({
	ok: false,
	error: { code: "INTERNAL", message: "boom" },
});

/** An in-memory stand-in for the Electron capability bridge. */
function installFakeBridge(): void {
	const sessions = new Map<string, PersistedChatSession>();
	const latest = (messages: readonly { createdAt: number }[], base: number) =>
		messages.reduce((max, m) => Math.max(max, m.createdAt), base);

	const bridge: Pick<
		CapabilityClient,
		| "listChatSessions"
		| "loadChatSession"
		| "saveChatSession"
		| "deleteChatSession"
		| "deleteAllChatData"
	> = {
		listChatSessions: async () =>
			ok({
				sessions: [...sessions.values()]
					.sort((a, b) => b.updatedAt - a.updatedAt)
					.map((s) => ({
						id: s.id,
						title: s.title,
						createdAt: s.createdAt,
						updatedAt: s.updatedAt,
						messageCount: s.messages.length,
					})),
			}),
		loadChatSession: async ({ sessionId }) =>
			ok({ session: sessions.get(sessionId) ?? null }),
		saveChatSession: async ({ session }) => {
			const stored: PersistedChatSession = {
				id: session.id,
				title: "New chat",
				createdAt: session.createdAt,
				updatedAt: latest(session.messages, session.createdAt),
				messages: session.messages,
			};
			sessions.set(session.id, stored);
			return ok({ session: stored });
		},
		deleteChatSession: async ({ sessionId }) =>
			ok({ deleted: sessions.delete(sessionId) }),
		deleteAllChatData: async () => {
			const deletedCount = sessions.size;
			sessions.clear();
			return ok({ deletedCount });
		},
	};

	(globalThis as { untie?: CapabilityClient }).untie =
		bridge as CapabilityClient;
}

function installFailingBridge(): void {
	const rejectAll = new Proxy(
		{},
		{ get: () => async () => fail() },
	) as CapabilityClient;
	(globalThis as { untie?: CapabilityClient }).untie = rejectAll;
}

function clearBridge(): void {
	(globalThis as { untie?: CapabilityClient }).untie = undefined;
}

afterEach(clearBridge);

const TRANSCRIPT: ChatMessage[] = [
	{ kind: "user", id: "m1", createdAt: 100, text: "Sort my Downloads" },
	{
		kind: "result",
		id: "m2",
		createdAt: 150,
		summary: "Moved 3 files.",
		movedCount: 3,
		folderCount: 2,
		createdFolderCount: 1,
	},
];

describe("chat persistence client", () => {
	it("reports availability from the presence of the bridge", () => {
		clearBridge();
		expect(isChatPersistenceAvailable()).toBe(false);
		installFakeBridge();
		expect(isChatPersistenceAvailable()).toBe(true);
	});

	it("round-trips a saved session back through load and list", async () => {
		installFakeBridge();

		await saveChatSession({ id: "s1", createdAt: 100, messages: TRANSCRIPT });

		const loaded = await loadChatSession("s1");
		expect(loaded?.id).toBe("s1");
		expect(loaded?.messages).toEqual(TRANSCRIPT);
		// The loaded messages narrow back to the concrete union.
		expect(loaded?.messages[0].kind).toBe("user");

		const summaries = await listChatSessions();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ id: "s1", messageCount: 2 });
	});

	it("deletes a single session and all sessions", async () => {
		installFakeBridge();
		await saveChatSession({ id: "a", createdAt: 1, messages: TRANSCRIPT });
		await saveChatSession({ id: "b", createdAt: 2, messages: TRANSCRIPT });

		expect(await deleteChatSession("a")).toBe(true);
		expect((await listChatSessions()).map((s) => s.id)).toEqual(["b"]);
		expect(await deleteAllChatData()).toBe(1);
		expect(await listChatSessions()).toEqual([]);
	});

	it("degrades to no-ops when no bridge is present", async () => {
		clearBridge();
		expect(await listChatSessions()).toEqual([]);
		expect(await loadChatSession("s1")).toBeNull();
		expect(
			await saveChatSession({ id: "s1", createdAt: 1, messages: [] }),
		).toBeNull();
		expect(await deleteChatSession("s1")).toBe(false);
		expect(await deleteAllChatData()).toBe(0);
	});

	it("returns safe fallbacks when a capability reports failure", async () => {
		installFailingBridge();
		expect(await listChatSessions()).toEqual([]);
		expect(await loadChatSession("s1")).toBeNull();
		expect(
			await saveChatSession({ id: "s1", createdAt: 1, messages: [] }),
		).toBeNull();
		expect(await deleteChatSession("s1")).toBe(false);
		expect(await deleteAllChatData()).toBe(0);
	});
});
