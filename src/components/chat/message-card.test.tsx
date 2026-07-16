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
import type { PlanMessage } from "./message-model";

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
