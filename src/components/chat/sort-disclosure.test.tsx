// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SortDisclosure } from "./sort-disclosure";
import {
	computeDisclosureManifest,
	type GenerateSortPlanInput,
	type SortDisclosureRequest,
} from "./sort-disclosure-model";

/**
 * A small request whose manifest is easy to reason about: 5 filenames, 2 of
 * which carry a content snippet (the PDFs). "Screenshots" carries no snippets.
 * All five carry an `extension`, so metadata is always present.
 */
const REQUEST: SortDisclosureRequest = {
	locationLabel: "Downloads",
	candidateDestinationNames: ["Documents", "Photos"],
	items: [
		{
			category: "PDF documents",
			file: {
				id: "a1",
				displayName: "lease.pdf",
				extension: "pdf",
				sizeBytes: 10,
				modifiedAt: "2026-01-01T00:00:00Z",
				excerpt: "Lease terms",
			},
		},
		{
			category: "PDF documents",
			file: {
				id: "a2",
				displayName: "invoice.pdf",
				extension: "pdf",
				sizeBytes: 20,
				excerpt: "Amount due",
			},
		},
		{
			category: "Screenshots",
			file: {
				id: "b1",
				displayName: "shot-1.png",
				extension: "png",
				sizeBytes: 30,
				modifiedAt: "2026-02-01T00:00:00Z",
			},
		},
		{
			category: "Screenshots",
			file: {
				id: "b2",
				displayName: "shot-2.png",
				extension: "png",
				sizeBytes: 40,
			},
		},
		{
			category: "Screenshots",
			file: {
				id: "b3",
				displayName: "shot-3.png",
				extension: "png",
				sizeBytes: 50,
			},
		},
	],
};

afterEach(cleanup);

describe("SortDisclosure (S3)", () => {
	it("states counts equal to the manifest of the exact payload, and no filenames", () => {
		render(
			<SortDisclosure
				request={REQUEST}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		const manifest = computeDisclosureManifest(REQUEST, new Set());
		// Fixture sanity: 5 filenames, 2 documents.
		expect(manifest.filenameCount).toBe(5);
		expect(manifest.documentCount).toBe(2);

		expect(
			screen.getByText(
				`This will send ${manifest.filenameCount} filenames + metadata and content snippets from ${manifest.documentCount} documents to the AI.`,
			),
		).toBeTruthy();

		// Counts and categories only — never a filename or a path.
		expect(screen.queryByText(/lease\.pdf/)).toBeNull();
		expect(screen.queryByText(/shot-1\.png/)).toBeNull();
		expect(screen.getByText("PDF documents")).toBeTruthy();
		expect(screen.getByText("Screenshots")).toBeTruthy();
	});

	it("updates the disclosed counts when files are excluded, matching the manifest", () => {
		render(
			<SortDisclosure
				request={REQUEST}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		// Exclude the two PDF documents — they carry both filenames and content.
		fireEvent.click(screen.getByRole("checkbox", { name: /PDF documents/i }));

		const manifest = computeDisclosureManifest(REQUEST, new Set(["a1", "a2"]));
		expect(manifest.filenameCount).toBe(3);
		expect(manifest.documentCount).toBe(0);
		// With no documents left, the copy drops the content-snippets clause.
		expect(
			screen.getByText(
				`This will send ${manifest.filenameCount} filenames + metadata to the AI.`,
			),
		).toBeTruthy();
	});

	it("cancels without sending: onCancel fires, onConfirm never does", () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(
			<SortDisclosure
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
			<SortDisclosure
				request={REQUEST}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>,
		);

		// Exclude all screenshots, leaving only the two PDFs, then send.
		fireEvent.click(screen.getByRole("checkbox", { name: /Screenshots/i }));
		fireEvent.click(screen.getByRole("button", { name: /send to ai/i }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
		const input = onConfirm.mock.calls[0]?.[0] as GenerateSortPlanInput;
		expect(input.files.map((file) => file.id).sort()).toEqual(["a1", "a2"]);

		// The payload handed to send is exactly what the panel disclosed.
		const manifest = computeDisclosureManifest(
			REQUEST,
			new Set(["b1", "b2", "b3"]),
		);
		expect(input.files.length).toBe(manifest.filenameCount);
		expect(manifest.filenameCount).toBe(2);
	});

	it("blocks sending when everything is excluded", () => {
		const onConfirm = vi.fn();
		render(
			<SortDisclosure
				request={REQUEST}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: /PDF documents/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /Screenshots/i }));

		const send = screen.getByRole("button", {
			name: /send to ai/i,
		}) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(screen.getByText(/nothing will be sent/i)).toBeTruthy();

		fireEvent.click(send);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
