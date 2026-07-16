// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ChatPane } from "./chat-pane";

// The pane runs the mock driver on real timers; a fresh session with an empty
// transcript keeps each test independent. Persistence degrades to a no-op here
// (no Electron bridge), so nothing needs mocking.
const session = { id: "chat-pane-test", createdAt: 0 };

beforeAll(() => {
	// jsdom has no layout; the pane auto-scrolls to the newest message.
	window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

const approveButton = () =>
	screen.findByRole(
		"button",
		{ name: /approve & sort/i },
		{ timeout: 6000 },
	) as Promise<HTMLButtonElement>;

describe("ChatPane approval flow (W13)", () => {
	it("stops at a ready plan, then applies it to a result on approve", async () => {
		render(<ChatPane session={session} initialMessages={[]} />);
		fireEvent.click(screen.getByRole("button", { name: "Simulate sort" }));

		// The plan is presented for review — approvable, and not auto-applied.
		const approve = await approveButton();
		expect(approve.disabled).toBe(false);
		expect(screen.queryByText("Sort complete")).toBeNull();

		fireEvent.click(approve);

		// Approving locks the card and lands a result summary in the transcript.
		await screen.findByText("Sort complete", {}, { timeout: 6000 });
		expect(screen.getByRole("button", { name: /^Approved$/ })).toBeTruthy();
	}, 15000);

	it("blocks approval when the pending plan is marked stale", async () => {
		render(<ChatPane session={session} initialMessages={[]} />);
		fireEvent.click(screen.getByRole("button", { name: "Simulate sort" }));

		const approve = await approveButton();
		expect(approve.disabled).toBe(false);

		// Mirrors W11 invalidating a prepared snapshot underneath the user.
		fireEvent.click(screen.getByRole("button", { name: "Mark plan stale" }));

		const blocked = (await approveButton()).disabled;
		expect(blocked).toBe(true);
		expect(screen.getByText(/out of date/i)).toBeTruthy();
		expect(screen.queryByText("Sort complete")).toBeNull();
	}, 15000);
});
