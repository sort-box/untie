// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import type { ChatMessage } from "./message-model";

/** A fully-stored session, as the fake persistence layer keeps it. */
interface StoredSession {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];
}

// A shared in-memory store, hoisted so the module mock (also hoisted) can close
// over it. Each test seeds it before rendering; nothing touches real Electron.
const persistence = vi.hoisted(() => ({
	store: new Map<string, StoredSession>(),
}));

vi.mock("./chat-persistence", () => {
	const firstUserText = (messages: ChatMessage[]): string | undefined => {
		for (const message of messages) {
			if (message.kind === "user") return message.text;
		}
		return undefined;
	};
	const summarize = (s: StoredSession) => ({
		id: s.id,
		title: s.title,
		createdAt: s.createdAt,
		updatedAt: s.updatedAt,
		messageCount: s.messages.length,
	});
	return {
		isChatPersistenceAvailable: () => true,
		listChatSessions: vi.fn(async () =>
			[...persistence.store.values()]
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map(summarize),
		),
		loadChatSession: vi.fn(async (sessionId: string) => {
			const s = persistence.store.get(sessionId);
			return s ? { ...s, messages: [...s.messages] } : null;
		}),
		saveChatSession: vi.fn(
			async (input: {
				id: string;
				createdAt: number;
				messages: ChatMessage[];
			}) => {
				const updatedAt = input.messages.reduce(
					(max, m) => Math.max(max, m.createdAt),
					input.createdAt,
				);
				const stored: StoredSession = {
					id: input.id,
					title: firstUserText(input.messages) ?? "New chat",
					createdAt: input.createdAt,
					updatedAt,
					messages: input.messages,
				};
				persistence.store.set(input.id, stored);
				return stored;
			},
		),
		deleteChatSession: vi.fn(async (sessionId: string) =>
			persistence.store.delete(sessionId),
		),
		deleteAllChatData: vi.fn(async () => {
			const count = persistence.store.size;
			persistence.store.clear();
			return count;
		}),
	};
});

// Import the component under test only after the mock is registered.
const { ChatWorkspace } = await import("./chat-workspace");

const SESSION_A: StoredSession = {
	id: "chat-a",
	title: "Sort my Downloads",
	createdAt: 100,
	updatedAt: 300,
	messages: [
		{ kind: "user", id: "a1", createdAt: 100, text: "Sort my Downloads" },
	],
};

const SESSION_B: StoredSession = {
	id: "chat-b",
	title: "Find my lease PDF",
	createdAt: 50,
	updatedAt: 200,
	messages: [
		{ kind: "user", id: "b1", createdAt: 50, text: "Find my lease PDF" },
	],
};

function seed(...sessions: StoredSession[]): void {
	for (const s of sessions) {
		persistence.store.set(s.id, { ...s, messages: [...s.messages] });
	}
}

const recentList = () => screen.getByRole("list", { name: "Recent chats" });
const conversation = () => screen.getByRole("list", { name: "Conversation" });

beforeAll(() => {
	// jsdom has no layout; the pane auto-scrolls to the latest message.
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
	persistence.store.clear();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ChatWorkspace", () => {
	it("shows the sidebar and pane empty states when there are no chats", async () => {
		render(<ChatWorkspace />);

		expect(await screen.findByText("No chats yet")).toBeTruthy();
		expect(screen.getByText("What should Untie sort?")).toBeTruthy();
		// No recent-chats list is rendered while the sidebar is empty.
		expect(screen.queryByRole("list", { name: "Recent chats" })).toBeNull();
	});

	it("lists recent chats newest-first and resumes the most recent on start", async () => {
		seed(SESSION_A, SESSION_B);
		render(<ChatWorkspace />);

		const list = await screen.findByRole("list", { name: "Recent chats" });
		const titles = within(list)
			.getAllByRole("button")
			.map((button) => button.textContent ?? "")
			.filter((text) => text.length > 0 && !text.startsWith("Delete"));
		expect(titles[0]).toContain("Sort my Downloads");
		expect(titles[1]).toContain("Find my lease PDF");

		// The most recent chat (A) is active and its transcript is in the pane.
		const activeRow = within(list).getByRole("button", {
			name: /^Sort my Downloads/,
		});
		expect(activeRow.getAttribute("aria-current")).toBe("true");
		expect(within(conversation()).getByText("Sort my Downloads")).toBeTruthy();
	});

	it("resumes a different chat when its list row is clicked", async () => {
		seed(SESSION_A, SESSION_B);
		render(<ChatWorkspace />);

		const rowB = await within(
			await screen.findByRole("list", {
				name: "Recent chats",
			}),
		).findByRole("button", { name: /^Find my lease PDF/ });
		fireEvent.click(rowB);

		await waitFor(() => {
			expect(
				within(conversation()).getByText("Find my lease PDF"),
			).toBeTruthy();
		});
		expect(within(conversation()).queryByText("Sort my Downloads")).toBeNull();
		expect(
			within(recentList())
				.getByRole("button", { name: /^Find my lease PDF/ })
				.getAttribute("aria-current"),
		).toBe("true");
	});

	it("starts a fresh empty chat from the New chat affordance", async () => {
		seed(SESSION_A, SESSION_B);
		render(<ChatWorkspace />);
		await screen.findByRole("list", { name: "Recent chats" });

		fireEvent.click(screen.getByRole("button", { name: "New chat" }));

		await waitFor(() => {
			expect(screen.getByText("What should Untie sort?")).toBeTruthy();
		});
		// Persisted chats stay listed, but none is marked active.
		const buttons = within(recentList()).getAllByRole("button");
		expect(buttons.some((b) => b.getAttribute("aria-current") === "true")).toBe(
			false,
		);
	});

	it("confirms before deleting and falls back when the active chat is removed", async () => {
		seed(SESSION_A, SESSION_B);
		render(<ChatWorkspace />);
		const list = await screen.findByRole("list", { name: "Recent chats" });

		// A is active; deleting it needs an explicit confirm.
		fireEvent.click(
			within(list).getByRole("button", {
				name: "Delete chat: Sort my Downloads",
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Confirm delete chat: Sort my Downloads",
			}),
		);

		// The deleted chat leaves the list and the pane falls back to the next
		// most recent chat (B).
		await waitFor(() => {
			expect(
				within(recentList()).queryByRole("button", {
					name: /^Sort my Downloads/,
				}),
			).toBeNull();
		});
		expect(within(conversation()).getByText("Find my lease PDF")).toBeTruthy();
		expect(
			within(recentList())
				.getByRole("button", { name: /^Find my lease PDF/ })
				.getAttribute("aria-current"),
		).toBe("true");
	});

	it("falls back to an empty chat when the last chat is deleted", async () => {
		seed(SESSION_A);
		render(<ChatWorkspace />);
		const list = await screen.findByRole("list", { name: "Recent chats" });

		fireEvent.click(
			within(list).getByRole("button", {
				name: "Delete chat: Sort my Downloads",
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Confirm delete chat: Sort my Downloads",
			}),
		);

		expect(await screen.findByText("No chats yet")).toBeTruthy();
		expect(screen.getByText("What should Untie sort?")).toBeTruthy();
	});
});
