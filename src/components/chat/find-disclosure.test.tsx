// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FindDisclosure } from "./find-disclosure";
import {
	computeFindDisclosureManifest,
	type FindDisclosureRequest,
	type RankFindShortlistInput,
} from "./find-disclosure-model";

/**
 * A small shortlist whose manifest is easy to reason about: 4 filenames, 3 of
 * which carry a content snippet. The "Images" candidate carries an empty snippet.
 */
const REQUEST: FindDisclosureRequest = {
	searchLabel: "Downloads",
	query: "tax return 2025",
	searchTerms: ["tax", "return", "2025"],
	candidates: [
		{
			category: "PDF documents",
			candidate: {
				itemId: "a1",
				displayName: "tax-return-2025.pdf",
				snippet: "Form 1040, tax year 2025",
			},
		},
		{
			category: "PDF documents",
			candidate: {
				itemId: "a2",
				displayName: "w2-2025.pdf",
				snippet: "Wage and tax statement",
			},
		},
		{
			category: "Spreadsheets",
			candidate: {
				itemId: "b1",
				displayName: "budget.xlsx",
				snippet: "Monthly expenses",
			},
		},
		{
			category: "Images",
			candidate: {
				itemId: "c1",
				displayName: "receipt-photo.png",
				snippet: "",
			},
		},
	],
};

afterEach(cleanup);

describe("FindDisclosure (F9)", () => {
	it("states counts equal to the manifest of the exact payload, and no filenames or snippets", () => {
		render(
			<FindDisclosure
				request={REQUEST}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		const manifest = computeFindDisclosureManifest(REQUEST, new Set());
		// Fixture sanity: 4 filenames, 3 documents.
		expect(manifest.filenameCount).toBe(4);
		expect(manifest.documentCount).toBe(3);

		expect(
			screen.getByText(
				`This will send ${manifest.filenameCount} filenames and content snippets from ${manifest.documentCount} documents to the AI to rank your results.`,
			),
		).toBeTruthy();

		// Counts and categories only — never a filename or a content snippet.
		expect(screen.queryByText(/tax-return-2025\.pdf/)).toBeNull();
		expect(screen.queryByText(/receipt-photo\.png/)).toBeNull();
		expect(screen.queryByText(/Form 1040/)).toBeNull();
		expect(screen.queryByText(/Wage and tax statement/)).toBeNull();
		expect(screen.getByText("PDF documents")).toBeTruthy();
		expect(screen.getByText("Spreadsheets")).toBeTruthy();
	});

	it("updates the disclosed counts when candidates are excluded, matching the manifest", () => {
		render(
			<FindDisclosure
				request={REQUEST}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		// Exclude the two PDF documents — they carry both filenames and content.
		fireEvent.click(screen.getByRole("checkbox", { name: /PDF documents/i }));

		const manifest = computeFindDisclosureManifest(
			REQUEST,
			new Set(["a1", "a2"]),
		);
		expect(manifest.filenameCount).toBe(2);
		expect(manifest.documentCount).toBe(1);
		expect(
			screen.getByText(
				`This will send ${manifest.filenameCount} filenames and content snippets from ${manifest.documentCount} document to the AI to rank your results.`,
			),
		).toBeTruthy();
	});

	it("cancels without sending: onCancel fires, onConfirm never does", () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(
			<FindDisclosure
				request={REQUEST}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("confirms with the exact included payload the disclosed counts describe", () => {
		const onConfirm = vi.fn();
		render(
			<FindDisclosure
				request={REQUEST}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>,
		);

		// Exclude the spreadsheet and image, leaving only the two PDFs, then send.
		fireEvent.click(screen.getByRole("checkbox", { name: /Spreadsheets/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /Images/i }));
		fireEvent.click(screen.getByRole("button", { name: /send to ai/i }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
		const input = onConfirm.mock.calls[0]?.[0] as RankFindShortlistInput;
		expect(
			input.candidates.map((candidate) => candidate.itemId).sort(),
		).toEqual(["a1", "a2"]);
		// The query envelope travels unchanged.
		expect(input.query).toEqual({
			searchTerms: ["tax", "return", "2025"],
			query: "tax return 2025",
		});

		// The payload handed to send is exactly what the panel disclosed.
		const manifest = computeFindDisclosureManifest(
			REQUEST,
			new Set(["b1", "c1"]),
		);
		expect(input.candidates.length).toBe(manifest.filenameCount);
		expect(manifest.filenameCount).toBe(2);
	});

	it("blocks sending when everything is excluded", () => {
		const onConfirm = vi.fn();
		render(
			<FindDisclosure
				request={REQUEST}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: /PDF documents/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /Spreadsheets/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /Images/i }));

		const send = screen.getByRole("button", {
			name: /send to ai/i,
		}) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(screen.getByText(/nothing will be sent/i)).toBeTruthy();

		fireEvent.click(send);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
