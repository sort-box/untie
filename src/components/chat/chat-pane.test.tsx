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

/** Open the sort, then confirm the S3 disclosure so the request is transmitted. */
const sendThroughDisclosure = async () => {
	fireEvent.click(screen.getByRole("button", { name: "Simulate sort" }));
	fireEvent.click(await screen.findByRole("button", { name: /send to ai/i }));
};

describe("ChatPane approval flow (W13)", () => {
	it("stops at a ready plan, then applies it to a result on approve", async () => {
		render(<ChatPane session={session} initialMessages={[]} />);
		await sendThroughDisclosure();

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
		await sendThroughDisclosure();

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

describe("ChatPane per-request disclosure gate (S3)", () => {
	it("gates the sort behind a disclosure and sends nothing on cancel", async () => {
		render(<ChatPane session={session} initialMessages={[]} />);
		fireEvent.click(screen.getByRole("button", { name: "Simulate sort" }));

		// The disclosure blocks transmission and states what would leave the device.
		expect(await screen.findByText(/this will send/i)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		// The gate is gone and nothing was transmitted — no scan/plan is started,
		// even after the mock driver's first step would have fired.
		expect(screen.queryByText(/this will send/i)).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(screen.queryByText("Scanning Downloads…")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /approve & sort/i }),
		).toBeNull();
	}, 15000);

	it("transmits the request only after the disclosure is confirmed", async () => {
		render(<ChatPane session={session} initialMessages={[]} />);
		fireEvent.click(screen.getByRole("button", { name: "Simulate sort" }));

		// Nothing runs while the gate is open.
		await screen.findByText(/this will send/i);
		expect(screen.queryByText("Scanning Downloads…")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /send to ai/i }));

		// Confirming transmits the request, which lands a reviewable plan.
		const approve = await screen.findByRole(
			"button",
			{ name: /approve & sort/i },
			{ timeout: 6000 },
		);
		expect((approve as HTMLButtonElement).disabled).toBe(false);
	}, 15000);
});
