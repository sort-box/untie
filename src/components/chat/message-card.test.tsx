// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageCard } from "./message-card";
import type { PlanFolder, PlanMessage, ResultMessage } from "./message-model";
import { buildUndoMessage } from "./mock-sort-driver";

/**
 * A compact ready plan. "Screenshots" has three files so exactly one filename
 * (`shot-3.png`) lives only in the expandable full move set — the summary row
 * previews just the first two — which lets us prove the full set is inspectable.
 */
const READY_PLAN: PlanMessage = {
	kind: "plan",
	id: "plan-1",
	createdAt: 0,
	summary: "5 files into 2 folders",
	fileCount: 5,
	folderCount: 2,
	createdFolderCount: 1,
	folders: [
		{
			name: "Screenshots",
			isNew: true,
			files: ["shot-1.png", "shot-2.png", "shot-3.png"],
		},
		{ name: "Contracts", isNew: false, files: ["lease.pdf", "nda.pdf"] },
	],
	status: "ready",
};

const EXACT_COUNTS_COPY =
	"Create 1 folder and move 5 files. Nothing is renamed, overwritten, or deleted.";

const approveButton = () =>
	screen.getByRole("button", { name: /approve & sort/i }) as HTMLButtonElement;

afterEach(cleanup);

describe("PlanCard review + approval (W13)", () => {
	it("states the exact counts and the safety guarantee, derived from the data", () => {
		render(<MessageCard message={READY_PLAN} />);
		expect(screen.getByText(EXACT_COUNTS_COPY)).toBeTruthy();
		// The header restates the summary and the new/existing split.
		expect(screen.getByText("5 files into 2 folders")).toBeTruthy();
		expect(screen.getByText(/1 new · 1 existing/)).toBeTruthy();
	});

	it("makes the complete move set inspectable behind an expandable control", () => {
		render(<MessageCard message={READY_PLAN} />);

		// Every destination is listed up front (grouped, new vs existing).
		const destinations = screen.getByRole("list", {
			name: "Proposed destinations",
		});
		expect(within(destinations).getByText("Screenshots")).toBeTruthy();
		expect(within(destinations).getByText("Contracts")).toBeTruthy();

		// The full file list is collapsed by default: shot-3.png is not previewed.
		const toggle = screen.getByRole("button", { name: /review all 5 moves/i });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("shot-3.png")).toBeNull();

		// Expanding reveals every file, grouped by destination as a semantic list.
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		const screenshots = screen.getByRole("region", { name: /Screenshots/i });
		for (const file of READY_PLAN.folders[0].files) {
			expect(within(screenshots).getByText(file)).toBeTruthy();
		}
		const contracts = screen.getByRole("region", { name: /Contracts/i });
		expect(within(contracts).getByText("nda.pdf")).toBeTruthy();
	});

	it("enables Approve for a ready plan and calls back with the plan", () => {
		const onApprovePlan = vi.fn();
		render(<MessageCard message={READY_PLAN} onApprovePlan={onApprovePlan} />);

		const button = approveButton();
		expect(button.disabled).toBe(false);
		// The enabled button is described by the exact-counts copy.
		expect(button.getAttribute("aria-describedby")).toBe(
			"plan-approval-plan-1",
		);

		fireEvent.click(button);
		expect(onApprovePlan).toHaveBeenCalledTimes(1);
		expect(onApprovePlan).toHaveBeenCalledWith(READY_PLAN);
	});

	it("disables Approve for a stale plan and surfaces why", () => {
		const onApprovePlan = vi.fn();
		render(
			<MessageCard
				message={{ ...READY_PLAN, status: "stale" }}
				onApprovePlan={onApprovePlan}
			/>,
		);

		const button = approveButton();
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		expect(onApprovePlan).not.toHaveBeenCalled();

		// The reason is shown and the button points at it for assistive tech.
		expect(button.getAttribute("aria-describedby")).toBe("plan-reason-plan-1");
		const reason = document.getElementById("plan-reason-plan-1");
		expect(reason?.textContent).toMatch(/out of date/i);
	});

	it("disables Approve for an invalid plan and surfaces why", () => {
		const onApprovePlan = vi.fn();
		render(
			<MessageCard
				message={{ ...READY_PLAN, status: "invalid" }}
				onApprovePlan={onApprovePlan}
			/>,
		);

		const button = approveButton();
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		expect(onApprovePlan).not.toHaveBeenCalled();

		const reason = document.getElementById("plan-reason-plan-1");
		expect(reason?.textContent).toMatch(/safety checks/i);
	});

	it("respects an explicit statusReason on a blocked plan", () => {
		render(
			<MessageCard
				message={{
					...READY_PLAN,
					status: "stale",
					statusReason: "A referenced file changed on disk.",
				}}
			/>,
		);
		const reason = document.getElementById("plan-reason-plan-1");
		expect(reason?.textContent).toContain("A referenced file changed on disk.");
	});

	it("shows an approved plan as terminal (Approved, no active Approve control)", () => {
		render(<MessageCard message={{ ...READY_PLAN, status: "approved" }} />);
		expect(
			screen.queryByRole("button", { name: /approve & sort/i }),
		).toBeNull();
		const approved = screen.getByRole("button", { name: /^Approved$/ });
		expect((approved as HTMLButtonElement).disabled).toBe(true);
	});
});

/**
 * A ready plan where the model was less certain about `shot-3.png` — used to
 * prove the low-confidence flag and the exclusion behaviour (S4).
 */
const READY_PLAN_S4: PlanMessage = {
	...READY_PLAN,
	folders: [
		{
			name: "Screenshots",
			isNew: true,
			files: ["shot-1.png", "shot-2.png", "shot-3.png"],
			lowConfidenceFiles: ["shot-3.png"],
		},
		{ name: "Contracts", isNew: false, files: ["lease.pdf", "nda.pdf"] },
	],
};

const expandFullList = () =>
	fireEvent.click(screen.getByRole("button", { name: /review all 5 moves/i }));

describe("PlanCard full review + exclusions (S4)", () => {
	it("progressively discloses the complete move set behind the expand control", () => {
		render(<MessageCard message={READY_PLAN_S4} />);

		// Collapsed: the deepest-nested move is not yet in the document.
		expect(screen.queryByText("shot-3.png")).toBeNull();

		expandFullList();

		// Expanded: every single proposed move is now inspectable.
		for (const folder of READY_PLAN_S4.folders) {
			const region = screen.getByRole("region", {
				name: new RegExp(folder.name, "i"),
			});
			for (const file of folder.files) {
				expect(within(region).getByText(file)).toBeTruthy();
			}
		}
	});

	it("flags a low-confidence move with an accessible, non-colour marker", () => {
		render(<MessageCard message={READY_PLAN_S4} />);
		expandFullList();

		const screenshots = screen.getByRole("region", { name: /Screenshots/i });
		// The flag is text (not colour alone) and sits on the flagged file's row.
		const flags = within(screenshots).getAllByText(/less certain/i);
		expect(flags).toHaveLength(1);
		expect(flags[0].closest("li")?.textContent).toContain("shot-3.png");
		// Confident moves carry no flag.
		expect(within(screenshots).queryAllByText(/less certain/i)).toHaveLength(1);
	});

	it("excludes a file, marks it, and drops it from the counts and approval copy", () => {
		render(<MessageCard message={READY_PLAN_S4} />);
		// Baseline exact-counts copy for the full plan.
		expect(screen.getByText(EXACT_COUNTS_COPY)).toBeTruthy();

		expandFullList();
		const includeNda = screen.getByRole("checkbox", {
			name: /include nda\.pdf/i,
		}) as HTMLInputElement;
		expect(includeNda.checked).toBe(true);

		fireEvent.click(includeNda);
		expect(includeNda.checked).toBe(false);

		// The row is marked as excluded (state conveyed by text, not colour).
		expect(includeNda.closest("li")?.textContent).toMatch(/excluded/i);
		// The approval copy and the header count both drop the excluded file.
		expect(
			screen.getByText(
				"Create 1 folder and move 4 files. Nothing is renamed, overwritten, or deleted.",
			),
		).toBeTruthy();
		expect(screen.getByText(/· 1 excluded/)).toBeTruthy();
	});

	it("keeps excluded files out of the approved snapshot sent to apply", () => {
		const onApprovePlan = vi.fn();
		render(
			<MessageCard message={READY_PLAN_S4} onApprovePlan={onApprovePlan} />,
		);
		expandFullList();
		fireEvent.click(
			screen.getByRole("checkbox", { name: /include nda\.pdf/i }),
		);

		fireEvent.click(approveButton());
		expect(onApprovePlan).toHaveBeenCalledTimes(1);
		const approved = onApprovePlan.mock.calls[0]?.[0] as PlanMessage;
		const approvedFiles = approved.folders.flatMap((folder) => folder.files);
		expect(approvedFiles).not.toContain("nda.pdf");
		expect(approvedFiles).toContain("lease.pdf");
		expect(approved.fileCount).toBe(4);
	});

	it("excludes a whole destination via its group checkbox", () => {
		const onApprovePlan = vi.fn();
		render(
			<MessageCard message={READY_PLAN_S4} onApprovePlan={onApprovePlan} />,
		);

		const contractsGroup = screen.getByRole("checkbox", {
			name: /include the .* for contracts/i,
		}) as HTMLInputElement;
		fireEvent.click(contractsGroup);

		// Both Contracts files leave the plan; only Screenshots remains.
		expect(
			screen.getByText(
				"Create 1 folder and move 3 files. Nothing is renamed, overwritten, or deleted.",
			),
		).toBeTruthy();

		fireEvent.click(approveButton());
		const approved = onApprovePlan.mock.calls[0]?.[0] as PlanMessage;
		expect(approved.folders.map((folder) => folder.name)).toEqual([
			"Screenshots",
		]);
	});

	it("blocks approval when every file is excluded and explains why", () => {
		const onApprovePlan = vi.fn();
		render(
			<MessageCard message={READY_PLAN_S4} onApprovePlan={onApprovePlan} />,
		);

		// Exclude both destinations wholesale.
		for (const name of [/for screenshots/i, /for contracts/i]) {
			fireEvent.click(screen.getByRole("checkbox", { name }));
		}

		const button = approveButton();
		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		expect(onApprovePlan).not.toHaveBeenCalled();
		expect(screen.getByText(/every file is excluded/i)).toBeTruthy();
	});

	it("exposes expand, exclusion, and approve as keyboard-operable controls", () => {
		render(<MessageCard message={READY_PLAN_S4} />);

		// Native <button>: focusable and operable by Enter/Space.
		const toggle = screen.getByRole("button", { name: /review all 5 moves/i });
		toggle.focus();
		expect(document.activeElement).toBe(toggle);

		expandFullList();
		// Native checkbox: focusable and operable by Space, and enabled here.
		const checkbox = screen.getByRole("checkbox", {
			name: /include nda\.pdf/i,
		}) as HTMLInputElement;
		expect(checkbox.tagName).toBe("INPUT");
		expect(checkbox.disabled).toBe(false);
		checkbox.focus();
		expect(document.activeElement).toBe(checkbox);

		const approve = approveButton();
		approve.focus();
		expect(document.activeElement).toBe(approve);
	});

	it("renders the exclusion controls read-only for a non-ready plan", () => {
		render(<MessageCard message={{ ...READY_PLAN_S4, status: "stale" }} />);
		expandFullList();
		const checkbox = screen.getByRole("checkbox", {
			name: /include nda\.pdf/i,
		}) as HTMLInputElement;
		expect(checkbox.disabled).toBe(true);
	});
});

const RESULT: ResultMessage = {
	kind: "result",
	id: "result-1",
	createdAt: 0,
	summary:
		"Moved 4 files into 2 folders in Downloads. Nothing was renamed, overwritten, or deleted.",
	movedCount: 4,
	folderCount: 2,
	createdFolderCount: 1,
};

const undoButton = () =>
	screen.getByRole("button", { name: /undo this sort/i }) as HTMLButtonElement;

describe("ResultCard undo control (S10 duplicate-undo guard)", () => {
	it("offers an enabled undo control that calls back with the whole result", () => {
		const onUndo = vi.fn();
		render(<MessageCard message={RESULT} onUndo={onUndo} />);

		// The completed sort is summarised with its guarantee restated.
		expect(screen.getByText("Sort complete")).toBeTruthy();
		expect(
			screen.getByText(/Nothing was renamed, overwritten, or deleted\./),
		).toBeTruthy();

		const button = undoButton();
		expect(button.disabled).toBe(false);
		fireEvent.click(button);
		expect(onUndo).toHaveBeenCalledTimes(1);
		expect(onUndo).toHaveBeenCalledWith(RESULT);
	});

	it("disables the control once undone and refuses a second undo", () => {
		const onUndo = vi.fn();
		render(<MessageCard message={RESULT} onUndo={onUndo} undone />);

		// The terminal state relabels the control and disables it.
		const button = screen.getByRole("button", {
			name: /undone/i,
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		// It states why, for assistive tech.
		expect(button.getAttribute("aria-describedby")).toBe(
			"result-undo-reason-result-1",
		);
		const reason = document.getElementById("result-undo-reason-result-1");
		expect(reason?.textContent).toMatch(/already been undone/i);

		// Clicking the disabled control does nothing — a second undo is refused.
		fireEvent.click(button);
		expect(onUndo).not.toHaveBeenCalled();
	});
});

/** A tiny two-destination plan (one new, one existing) for undo card scenarios. */
const UNDO_FOLDERS: readonly PlanFolder[] = [
	{ name: "Screenshots", isNew: true, files: ["s1.png", "s2.png"] },
	{ name: "Contracts", isNew: false, files: ["lease.pdf", "nda.pdf"] },
];

const undoMessage = (outcome: "complete" | "partial" | "unavailable") =>
	buildUndoMessage({ id: "undo-1", now: 0, outcome, folders: UNDO_FOLDERS });

const GUARANTEE = /Nothing was renamed, overwritten, or deleted\./;

describe("UndoCard distinguishes all three outcomes (S10 conflict matrix)", () => {
	it("presents a complete undo: everything restored, honest guarantee, no left-in-place list", () => {
		render(<MessageCard message={undoMessage("complete")} />);

		expect(screen.getByText("Sort undone")).toBeTruthy();
		expect(screen.getByText(/Restored 4 files/i)).toBeTruthy();
		expect(screen.getByText(GUARANTEE)).toBeTruthy();

		// Every file is in the restored breakdown; nothing was left in place.
		expect(
			screen.getByRole("region", { name: /restored to where they were/i }),
		).toBeTruthy();
		expect(
			screen.queryByRole("region", { name: /left exactly where they are/i }),
		).toBeNull();
	});

	it("presents a partial undo: a warning that breaks down restored vs left, with the conflict reason", () => {
		render(<MessageCard message={undoMessage("partial")} />);

		expect(screen.getByText("Sort partly undone")).toBeTruthy();
		expect(screen.getByText(GUARANTEE)).toBeTruthy();

		// Both sides of the split are shown as their own breakdown sections.
		expect(
			screen.getByRole("region", { name: /restored to where they were/i }),
		).toBeTruthy();
		const left = screen.getByRole("region", {
			name: /left exactly where they are/i,
		});
		// A left-in-place file states the honest conflict reason (never a path).
		expect(within(left).getByText(/never overwrites/i)).toBeTruthy();

		// The per-folder outcomes are shown too.
		expect(screen.getByRole("region", { name: /^folders$/i })).toBeTruthy();
	});

	it("presents an unavailable undo: a danger that restored nothing and left every file in place", () => {
		render(<MessageCard message={undoMessage("unavailable")} />);

		expect(screen.getByText(/couldn.t undo this sort/i)).toBeTruthy();
		expect(screen.getByText(/exactly where the sort left them/i)).toBeTruthy();
		expect(screen.getByText(GUARANTEE)).toBeTruthy();

		// Nothing to break down: no restored / left-in-place / folder sections.
		expect(
			screen.queryByRole("region", { name: /restored to where they were/i }),
		).toBeNull();
		expect(
			screen.queryByRole("region", { name: /left exactly where they are/i }),
		).toBeNull();
	});

	it("keeps the three outcomes visually distinct via their titles", () => {
		const titles = (["complete", "partial", "unavailable"] as const).map(
			(outcome) => {
				const { unmount } = render(
					<MessageCard message={undoMessage(outcome)} />,
				);
				const article = screen.getByRole("article");
				const title = article.querySelector("h3")?.textContent ?? "";
				unmount();
				return title;
			},
		);
		expect(new Set(titles).size).toBe(3);
	});
});
