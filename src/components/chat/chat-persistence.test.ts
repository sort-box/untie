import { afterEach, describe, expect, it } from "vitest";

import type {
	CapabilityClient,
	CapabilityResult,
	PersistedChatSession,
} from "../../../electron/capabilities/contracts.cjs";
import {
	applyOperationCompleted,
	applyProgressMessage,
	buildApplyJournalState,
	deriveApplyProgress,
	findInFlightApply,
} from "./apply-progress-model";
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
				// The fs-backed store serializes to JSON, so clone to faithfully drop
				// anything non-serializable and prove kind-specific fields round-trip.
				messages: JSON.parse(JSON.stringify(session.messages)),
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

	it("persists an in-flight apply's journal state so a reload can resume it", async () => {
		installFakeBridge();

		// Journal an apply 3 of 10 moves in, then persist it exactly as the pane
		// would when the transcript changes mid-apply.
		let state = buildApplyJournalState({
			operationId: "op-1",
			locationLabel: "Downloads",
			folders: [
				{
					name: "Invoices",
					isNew: false,
					files: ["a.pdf", "b.pdf", "c.pdf", "d.pdf"],
				},
				{ name: "Photos", isNew: true, files: ["1.jpg", "2.jpg", "3.jpg"] },
				{ name: "Installers", isNew: true, files: ["x.pkg", "y.dmg", "z.dmg"] },
			],
		});
		for (let i = 0; i < 3; i += 1) state = applyOperationCompleted(state);
		const inFlight = applyProgressMessage(state, {
			id: "apply-1",
			createdAt: 200,
		});
		const transcript: ChatMessage[] = [
			{ kind: "user", id: "u1", createdAt: 100, text: "Sort my Downloads" },
			inFlight,
		];

		await saveChatSession({ id: "s1", createdAt: 100, messages: transcript });

		// A fresh mount reconstructs the pane from the loaded session. The embedded
		// journal state survives, and the recovered progress is the durable 3 of 10.
		const loaded = await loadChatSession("s1");
		const recovered = findInFlightApply(loaded?.messages ?? []);
		expect(recovered).toBeDefined();
		if (!recovered) throw new Error("expected an in-flight apply");
		expect(recovered.apply).toEqual(state);
		const progress = deriveApplyProgress(recovered.apply);
		expect(progress.completed).toBe(3);
		expect(progress.total).toBe(10);
		expect(progress.status).toBe("applying");
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
