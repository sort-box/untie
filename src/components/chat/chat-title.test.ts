import { describe, expect, it } from "vitest";

import {
	deriveChatTitle,
	formatRelativeTime,
	NEW_CHAT_TITLE,
} from "./chat-title";
import type { ChatMessage } from "./message-model";

const user = (text: string, id = "u", createdAt = 0): ChatMessage => ({
	kind: "user",
	id,
	createdAt,
	text,
});

const pending: ChatMessage = {
	kind: "pending",
	id: "p",
	createdAt: 0,
	label: "Scanning…",
};

describe("deriveChatTitle", () => {
	it("falls back to the placeholder for an empty transcript", () => {
		expect(deriveChatTitle([])).toBe(NEW_CHAT_TITLE);
	});

	it("falls back to the placeholder when there is no user message yet", () => {
		expect(deriveChatTitle([pending])).toBe(NEW_CHAT_TITLE);
	});

	it("falls back to the placeholder when the first user message is blank", () => {
		expect(deriveChatTitle([user("   \n  ")])).toBe(NEW_CHAT_TITLE);
	});

	it("uses the first user message, collapsing whitespace", () => {
		expect(deriveChatTitle([user("  Sort   my\nDownloads  ")])).toBe(
			"Sort my Downloads",
		);
	});

	it("picks the first user message when several are present", () => {
		expect(
			deriveChatTitle([
				user("Find my lease", "u1", 1),
				pending,
				user("Sort Desktop", "u2", 2),
			]),
		).toBe("Find my lease");
	});

	it("elides overly long titles at 60 characters", () => {
		const title = deriveChatTitle([user("x".repeat(80))]);
		expect(title).toHaveLength(60);
		expect(title.endsWith("…")).toBe(true);
	});
});

describe("formatRelativeTime", () => {
	const now = 1_000_000_000_000;

	it("labels very recent activity as just now", () => {
		expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
	});

	it("labels minutes, hours, and days", () => {
		expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
		expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
		expect(formatRelativeTime(now - 24 * 3_600_000, now)).toBe("yesterday");
		expect(formatRelativeTime(now - 3 * 24 * 3_600_000, now)).toBe("3 d ago");
	});
});
