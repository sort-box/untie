// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
	applyOperationCompleted,
	applyProgressMessage,
	buildApplyJournalState,
} from "./apply-progress-model";
import { ChatPane } from "./chat-pane";
import type { ChatMessage, PlanFolder } from "./message-model";

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

/** The risk acknowledgment gate's confirm control (S6). */
const acknowledgeButton = () =>
	screen.findByRole(
		"button",
		{ name: /acknowledge & sort/i },
		{ timeout: 6000 },
	) as Promise<HTMLButtonElement>;

/** Tick the explicit acknowledgment so the gate's confirm becomes available. */
const ackCheckbox = () =>
	screen.getByRole("checkbox", {
		name: /reviewed the flagged moves/i,
	}) as HTMLInputElement;

describe("ChatPane approval flow (W13 + S6)", () => {
	it("gates a flagged plan behind acknowledgment, then applies it on confirm", async () => {
		render(<ChatPane session={session} initialMessages={[]} />);
		await sendThroughDisclosure();

		// The plan is presented for review — approvable, and not auto-applied.
		const approve = await approveButton();
		expect(approve.disabled).toBe(false);
		expect(screen.queryByText("Sort complete")).toBeNull();

		// The mock plan carries low-confidence moves, so approving enters the S6
		// risk acknowledgment gate rather than applying immediately.
		fireEvent.click(approve);
		const acknowledge = await acknowledgeButton();
		expect(acknowledge.disabled).toBe(true);
		expect(screen.queryByText("Sort complete")).toBeNull();

		// The acknowledgment must be explicit; ticking it enables the confirm.
		fireEvent.click(ackCheckbox());
		expect(acknowledge.disabled).toBe(false);
		fireEvent.click(acknowledge);

		// Confirming locks the card and lands a result summary in the transcript.
		await screen.findByText("Sort complete", {}, { timeout: 6000 });
		expect(screen.getByRole("button", { name: /^Approved$/ })).toBeTruthy();
	}, 15000);

	it("applies nothing while the acknowledgment gate is open and on cancel", async () => {
		render(<ChatPane session={session} initialMessages={[]} />);
		await sendThroughDisclosure();

		fireEvent.click(await approveButton());
		await acknowledgeButton();

		// Going back dismisses the gate; nothing was applied.
		fireEvent.click(screen.getByRole("button", { name: /go back/i }));
		expect(
			screen.queryByRole("button", { name: /acknowledge & sort/i }),
		).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(screen.queryByText("Sort complete")).toBeNull();
		// The plan is still reviewable — approval can be attempted again.
		expect((await approveButton()).disabled).toBe(false);
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

describe("ChatPane apply durability across reload (S7)", () => {
	// A 10-move plan across three destinations (2 new), enough to leave a
	// meaningful "3 of 10" mid-apply snapshot.
	const RESUME_FOLDERS: readonly PlanFolder[] = [
		{
			name: "Invoices",
			isNew: false,
			files: ["a.pdf", "b.pdf", "c.pdf", "d.pdf"],
		},
		{ name: "Photos", isNew: true, files: ["1.jpg", "2.jpg", "3.jpg"] },
		{ name: "Installers", isNew: true, files: ["x.pkg", "y.dmg", "z.dmg"] },
	];

	/** Persisted transcript with an apply journaled 3 of 10 done (as after a save). */
	const seedMidApply = (): ChatMessage[] => {
		let state = buildApplyJournalState({
			operationId: "op-resume",
			locationLabel: "Downloads",
			folders: RESUME_FOLDERS,
		});
		for (let i = 0; i < 3; i += 1) state = applyOperationCompleted(state);
		const inFlight = applyProgressMessage(state, {
			id: "apply-resume",
			createdAt: 42,
		});
		const transcript: ChatMessage[] = [
			{ kind: "user", id: "u1", createdAt: 1, text: "Sort my Downloads" },
			inFlight,
		];
		// The persistence boundary round-trips exactly JSON, like a real reload.
		return JSON.parse(JSON.stringify(transcript)) as ChatMessage[];
	};

	it("recovers 3 of 10 from the journal, then resumes to the final summary", async () => {
		render(<ChatPane session={session} initialMessages={seedMidApply()} />);

		// The recovered progress is the journal's 3 of 10 — not a reset (0) and not
		// a stale/lost value — rebuilt from the persisted journal state on mount.
		const bar = screen.getByRole("progressbar");
		expect(bar.getAttribute("aria-valuenow")).toBe("3");
		expect(bar.getAttribute("aria-valuemax")).toBe("10");

		// Resuming drives the remaining operations to completion and lands the
		// final result summary, with counts derived from the journal.
		await screen.findByText(
			/Moved 10 files into 3 folders in Downloads/,
			{},
			{ timeout: 6000 },
		);
		expect(screen.getByText("Sort complete")).toBeTruthy();
		expect(
			screen.getByText(/Nothing was renamed, overwritten, or deleted\./),
		).toBeTruthy();
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
