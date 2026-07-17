// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RecoveryCard } from "./recovery-card";
import {
	describeRecoveryCause,
	type RecoveryBatchSummary,
} from "./recovery-model";

// Any forward slash or backslash in the rendered output is a path leak.
const PATH_CHARS = /[/\\]/;

/** A needs_attention batch with a completed, a pending, and two conflicted ops. */
const CONFLICT: RecoveryBatchSummary = {
	batchId: "conflict-1",
	locationLabel: "Downloads",
	state: "needs_attention",
	trigger: "recovery",
	reason: "revert_conflict",
	operations: [
		{ id: "move_0", name: "budget.xlsx", kind: "file", outcome: "restored" },
		{
			id: "move_1",
			name: "screenshot.png",
			kind: "file",
			outcome: "in_doubt_conflict",
		},
		{
			id: "move_2",
			name: "logo.svg",
			kind: "file",
			outcome: "origin_occupied",
		},
		{ id: "move_3", name: "draft.md", kind: "file", outcome: "pending" },
	],
};

const GRANT_UNAVAILABLE: RecoveryBatchSummary = {
	batchId: "grant-1",
	locationLabel: "Downloads",
	state: "needs_attention",
	trigger: "recovery",
	reason: "grant_unavailable",
	operations: [
		{ id: "move_0", name: "resume.docx", kind: "file", outcome: "pending" },
	],
};

const RECOVERED: RecoveryBatchSummary = {
	batchId: "recovered-1",
	locationLabel: "Downloads",
	state: "recovered",
	trigger: "recovery",
	operations: [
		{
			id: "folder_0",
			name: "Invoices",
			kind: "folder",
			outcome: "folder_created",
		},
		{ id: "move_0", name: "march-invoice.pdf", kind: "file", outcome: "moved" },
	],
};

afterEach(cleanup);

describe("RecoveryCard (S9)", () => {
	it("headlines the batch, explains the cause, and restates the guarantee", () => {
		render(<RecoveryCard summary={CONFLICT} />);

		// A titled region names the batch for assistive tech.
		expect(
			screen.getByRole("region", { name: /needs your attention/i }),
		).toBeTruthy();
		// Plain-language explanation of what happened.
		expect(screen.getByText(/Untie recovered this sort/i)).toBeTruthy();
		// The honest guarantee is always present (its unique tail disambiguates it
		// from the reassurance a conflicted operation's next action also carries).
		expect(
			screen.getByText(
				/Any item Untie couldn't finish was left exactly where it is/i,
			),
		).toBeTruthy();
	});

	it("classifies operations into completed / not-started / needs-attention groups", () => {
		render(<RecoveryCard summary={CONFLICT} />);

		// Each disposition is its own labelled region.
		const attention = screen.getByRole("region", {
			name: "Needs your attention",
		});
		const completed = screen.getByRole("region", { name: "Completed" });
		const pending = screen.getByRole("region", { name: "Not started" });

		// Conflicted files land in the attention group with their display names.
		expect(within(attention).getByText("screenshot.png")).toBeTruthy();
		expect(within(attention).getByText("logo.svg")).toBeTruthy();
		// Completed and pending files land in their own groups.
		expect(within(completed).getByText("budget.xlsx")).toBeTruthy();
		expect(within(pending).getByText("draft.md")).toBeTruthy();
	});

	it("states honestly what happened and a safe next action for a conflict", () => {
		render(<RecoveryCard summary={CONFLICT} />);
		const attention = screen.getByRole("region", {
			name: "Needs your attention",
		});

		// The in-doubt move states what happened and offers a safe action.
		const inDoubt = describeRecoveryCause("in_doubt_conflict");
		expect(within(attention).getByText(inDoubt.explanation)).toBeTruthy();
		expect(within(attention).getByText(inDoubt.nextActions[0])).toBeTruthy();
	});

	it("lists the batch's safe next actions", () => {
		render(<RecoveryCard summary={CONFLICT} />);
		const actions = screen.getByRole("region", {
			name: /what you can safely do next/i,
		});
		// The reconnect-free conflict actions are surfaced as a list.
		expect(
			within(actions).getByText(/Reveal the item to see where it is now\./i),
		).toBeTruthy();
	});

	it("renders the whole-batch cause when access is unavailable", () => {
		render(<RecoveryCard summary={GRANT_UNAVAILABLE} />);
		const cause = describeRecoveryCause("grant_unavailable");
		expect(screen.getByRole("region", { name: cause.headline })).toBeTruthy();
		expect(screen.getByText(cause.explanation)).toBeTruthy();
		expect(screen.getByText(cause.nextActions[0])).toBeTruthy();
	});

	it("renders a recovered batch as a positive outcome with no conflicts", () => {
		render(<RecoveryCard summary={RECOVERED} />);
		expect(
			screen.getByRole("region", {
				name: /finished this sort after a restart/i,
			}),
		).toBeTruthy();
		expect(screen.getByRole("region", { name: "Completed" })).toBeTruthy();
		// Nothing needs attention, so that group is absent.
		expect(
			screen.queryByRole("region", { name: "Needs your attention" }),
		).toBeNull();
	});

	it("never renders a filesystem path for any recovery state", () => {
		for (const summary of [CONFLICT, GRANT_UNAVAILABLE, RECOVERED]) {
			const { container, unmount } = render(<RecoveryCard summary={summary} />);
			expect(PATH_CHARS.test(container.textContent ?? "")).toBe(false);
			// The accessible label the card exposes is path-free too.
			const labelled = container.querySelector("[aria-label]");
			expect(PATH_CHARS.test(labelled?.getAttribute("aria-label") ?? "")).toBe(
				false,
			);
			unmount();
		}
	});
});
