import { describe, expect, it } from "vitest";

import { buildFindShortlistMessages } from "#/server/llm/find-shortlist/prompt";
import {
	buildFindDisclosureInput,
	computeFindDisclosureManifest,
	type FindDisclosureRequest,
	findDisclosureBreakdown,
	findDisclosureCategories,
	findDisclosureHeadline,
	includedCandidates,
} from "./find-disclosure-model";

/**
 * A small shortlist whose manifest is easy to reason about: 4 filenames, 3 of
 * which carry a non-empty content snippet. The "Images" candidate carries an
 * empty snippet, so it counts as a filename but not a document.
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

/** Byte length of the exact serialized outbound messages for `input`. */
function payloadBytes(request: FindDisclosureRequest, excluded: Set<string>) {
	const input = buildFindDisclosureInput(request, excluded);
	return buildFindShortlistMessages(input).reduce(
		(total, message) =>
			total + new TextEncoder().encode(message.content).byteLength,
		0,
	);
}

describe("find-disclosure-model (F9)", () => {
	it("manifest counts match the exact outbound payload", () => {
		const manifest = computeFindDisclosureManifest(REQUEST, new Set());
		expect(manifest.filenameCount).toBe(4);
		expect(manifest.snippetCount).toBe(3);
		expect(manifest.documentCount).toBe(3);
		expect(manifest.opaqueIdCount).toBe(4);
		expect(manifest.searchTermCount).toBe(3);
		expect(manifest.messageCount).toBe(2);
		// The disclosed size equals the size of the serialized outbound messages.
		expect(manifest.totalPayloadBytes).toBe(payloadBytes(REQUEST, new Set()));
	});

	it("displayed-equals-sent: manifest is derived from the exact confirm input", () => {
		// The value confirm would hand onward IS the value the manifest measures.
		const excluded = new Set<string>();
		const input = buildFindDisclosureInput(REQUEST, excluded);
		const manifest = computeFindDisclosureManifest(REQUEST, excluded);
		expect(input.candidates.length).toBe(manifest.filenameCount);
		expect(
			input.candidates.filter((candidate) => candidate.snippet.length > 0)
				.length,
		).toBe(manifest.documentCount);
		expect(manifest.totalPayloadBytes).toBe(
			buildFindShortlistMessages(input).reduce(
				(total, message) =>
					total + new TextEncoder().encode(message.content).byteLength,
				0,
			),
		);
		// The query envelope is transmitted verbatim.
		expect(input.query).toEqual({
			searchTerms: ["tax", "return", "2025"],
			query: "tax return 2025",
		});
	});

	it("excluding candidates updates the counts and the payload size", () => {
		// Exclude both PDFs: 2 filenames + 2 documents removed.
		const excluded = new Set(["a1", "a2"]);
		const manifest = computeFindDisclosureManifest(REQUEST, excluded);
		expect(manifest.filenameCount).toBe(2);
		expect(manifest.documentCount).toBe(1);
		expect(manifest.totalPayloadBytes).toBe(payloadBytes(REQUEST, excluded));
		// The confirm input carries exactly the two surviving candidates.
		const input = buildFindDisclosureInput(REQUEST, excluded);
		expect(input.candidates.map((candidate) => candidate.itemId)).toEqual([
			"b1",
			"c1",
		]);
		// A smaller payload is genuinely smaller on the wire.
		expect(manifest.totalPayloadBytes).toBeLessThan(
			payloadBytes(REQUEST, new Set()),
		);
	});

	it("includedCandidates returns the surviving records in request order", () => {
		const survivors = includedCandidates(REQUEST, new Set(["a1", "c1"]));
		expect(survivors.map((item) => item.candidate.itemId)).toEqual([
			"a2",
			"b1",
		]);
	});

	it("headline drops the snippet clause when no document survives", () => {
		const full = computeFindDisclosureManifest(REQUEST, new Set());
		expect(findDisclosureHeadline(full)).toBe(
			"This will send 4 filenames and content snippets from 3 documents to the AI to rank your results.",
		);

		// Exclude every candidate that carries a snippet.
		const noDocs = computeFindDisclosureManifest(
			REQUEST,
			new Set(["a1", "a2", "b1"]),
		);
		expect(noDocs.documentCount).toBe(0);
		expect(findDisclosureHeadline(noDocs)).toBe(
			"This will send 1 filename to the AI to rank your results.",
		);
	});

	it("headline says nothing will be sent when every candidate is excluded", () => {
		const manifest = computeFindDisclosureManifest(
			REQUEST,
			new Set(["a1", "a2", "b1", "c1"]),
		);
		expect(manifest.filenameCount).toBe(0);
		expect(findDisclosureHeadline(manifest)).toBe(
			"Nothing will be sent — every candidate is excluded.",
		);
	});

	it("breakdown reports counts only and notes opaque IDs, never a path", () => {
		const manifest = computeFindDisclosureManifest(REQUEST, new Set());
		const breakdown = findDisclosureBreakdown(manifest);
		const byId = Object.fromEntries(breakdown.map((line) => [line.id, line]));
		expect(byId.filenames?.label).toBe("4 filenames");
		expect(byId.filenames?.detail).toContain("opaque ID");
		expect(byId.filenames?.detail).toContain("never a folder path");
		expect(byId.snippets?.label).toBe("content snippets from 3 documents");
		expect(byId.query).toBeDefined();
		// No filename or snippet text ever appears in the breakdown.
		const serialized = JSON.stringify(breakdown);
		expect(serialized).not.toContain("tax-return-2025.pdf");
		expect(serialized).not.toContain("Form 1040");
	});

	it("categories group candidates in first-seen order with live counts", () => {
		const categories = findDisclosureCategories(REQUEST, new Set(["a1"]));
		expect(categories.map((category) => category.category)).toEqual([
			"PDF documents",
			"Spreadsheets",
			"Images",
		]);
		const pdfs = categories[0];
		expect(pdfs?.ids).toEqual(["a1", "a2"]);
		expect(pdfs?.fileCount).toBe(2);
		expect(pdfs?.documentCount).toBe(2);
		expect(pdfs?.includedCount).toBe(1);
		expect(pdfs?.excluded).toBe(false);
		// The empty-snippet "Images" candidate counts as a file but not a document.
		const images = categories[2];
		expect(images?.fileCount).toBe(1);
		expect(images?.documentCount).toBe(0);

		// Excluding the whole category flips `excluded`.
		const allExcluded = findDisclosureCategories(
			REQUEST,
			new Set(["a1", "a2"]),
		);
		expect(allExcluded[0]?.excluded).toBe(true);
		expect(allExcluded[0]?.includedCount).toBe(0);
	});
});
