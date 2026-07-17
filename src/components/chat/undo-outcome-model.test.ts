import { describe, expect, it } from "vitest";

import {
	buildUndoResult,
	isBatchUndoable,
	UNDO_SAFETY_GUARANTEE,
	type UndoBatchState,
	type UndoEngineResult,
	type UndoFileResult,
	type UndoFolderResult,
	type UndoResult,
	undoControlPresentation,
	undoFileLine,
	undoFolderLine,
	undoLeftInPlaceCount,
	undoPresentation,
	undoRemovedFolderCount,
	undoRestoredCount,
} from "./undo-outcome-model";

/** A restored file, a modified-but-restored file, and one conflict per reason. */
const FILES: readonly UndoFileResult[] = [
	{ itemId: "m0", name: "a.pdf", outcome: "restored" },
	{ itemId: "m1", name: "b.pdf", outcome: "restored_modified" },
	{ itemId: "m2", name: "c.pdf", outcome: "already_moved_away" },
	{
		itemId: "m3",
		name: "d.pdf",
		outcome: "conflict",
		reason: "origin_occupied",
	},
	{
		itemId: "m4",
		name: "e.pdf",
		outcome: "conflict",
		reason: "destination_changed",
	},
	{
		itemId: "m5",
		name: "f.pdf",
		outcome: "conflict",
		reason: "destination_replaced",
	},
	{
		itemId: "m6",
		name: "g.pdf",
		outcome: "conflict",
		reason: "filesystem_error",
	},
];

const FOLDERS: readonly UndoFolderResult[] = [
	{ folderId: "f0", name: "Removed", outcome: "removed" },
	{ folderId: "f1", name: "Existing", outcome: "pre_existing" },
	{ folderId: "f2", name: "NowFull", outcome: "non_empty" },
	{ folderId: "f3", name: "Stuck", outcome: "unavailable" },
];

const completeResult: UndoResult = {
	outcome: "complete",
	files: [
		{ itemId: "m0", name: "a.pdf", outcome: "restored" },
		{ itemId: "m1", name: "b.pdf", outcome: "restored_modified" },
	],
	folders: [{ folderId: "f0", name: "Screenshots", outcome: "removed" }],
};

const partialResult: UndoResult = {
	outcome: "partial",
	files: FILES,
	folders: FOLDERS,
};

const unavailableResult: UndoResult = {
	outcome: "unavailable",
	files: [],
	folders: [],
};

describe("undo derived counts", () => {
	it("splits every file into restored or left-in-place, exhaustively", () => {
		// restored + restored_modified count as restored; the rest are left in place.
		expect(undoRestoredCount(FILES)).toBe(2);
		expect(undoLeftInPlaceCount(FILES)).toBe(5);
		expect(undoRestoredCount(FILES) + undoLeftInPlaceCount(FILES)).toBe(
			FILES.length,
		);
	});

	it("counts only the folders the engine actually removed", () => {
		expect(undoRemovedFolderCount(FOLDERS)).toBe(1);
	});
});

describe("undoPresentation — the three honest outcomes", () => {
	it("presents a complete undo as a success that restored everything", () => {
		const p = undoPresentation(completeResult);
		expect(p.tone).toBe("success");
		expect(p.title).toBe("Sort undone");
		expect(p.restoredCount).toBe(2);
		expect(p.leftInPlaceCount).toBe(0);
		expect(p.removedFolderCount).toBe(1);
		// A complete undo makes exactly the base guarantee — nothing more.
		expect(p.guarantee).toBe(UNDO_SAFETY_GUARANTEE);
		expect(p.summary).toMatch(/restored 2 files/i);
	});

	it("presents a partial undo as a warning, honest about what was left", () => {
		const p = undoPresentation(partialResult);
		expect(p.tone).toBe("warning");
		expect(p.title).toBe("Sort partly undone");
		expect(p.restoredCount).toBe(2);
		expect(p.leftInPlaceCount).toBe(5);
		// Derived from the data: restored 2 of 7.
		expect(p.headline).toContain("2 of 7");
		// Never over-claims: still starts with the base guarantee.
		expect(p.guarantee).toContain(UNDO_SAFETY_GUARANTEE);
		expect(p.summary).toMatch(/left exactly where/i);
	});

	it("presents an unavailable undo as a danger that restored nothing", () => {
		const p = undoPresentation(unavailableResult);
		expect(p.tone).toBe("danger");
		expect(p.title).toBe("Couldn't undo this sort");
		expect(p.restoredCount).toBe(0);
		expect(p.leftInPlaceCount).toBe(0);
		expect(p.guarantee).toContain(UNDO_SAFETY_GUARANTEE);
		// Honest: files stayed exactly where the sort left them.
		expect(p.summary).toMatch(/exactly where the sort left them/i);
	});

	it("gives each outcome a distinct tone so the card can distinguish them", () => {
		const tones = [completeResult, partialResult, unavailableResult].map(
			(result) => undoPresentation(result).tone,
		);
		expect(new Set(tones).size).toBe(3);
	});
});

describe("undoFileLine — honest per-file wording", () => {
	it("marks restored files restored, with no next action needed", () => {
		const line = undoFileLine(FILES[0]);
		expect(line.status).toBe("restored");
		expect(line.explanation).toMatch(/restored/i);
		expect(line.nextAction).toBeUndefined();
	});

	it("explains a restored-modified file kept the user's newer version", () => {
		const line = undoFileLine(FILES[1]);
		expect(line.status).toBe("restored");
		expect(line.explanation).toMatch(/newer version/i);
	});

	it("gives every left-in-place file an honest reason and a safe next step", () => {
		for (const file of FILES.filter(
			(f) => f.outcome !== "restored" && f.outcome !== "restored_modified",
		)) {
			const line = undoFileLine(file);
			expect(line.status).toBe("left");
			expect(line.explanation).toMatch(/left/i);
			// Every conflict carries a non-empty, safe next action.
			if (file.outcome === "conflict") {
				expect(line.nextAction?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});
});

describe("undoFolderLine — honest per-folder wording", () => {
	it("marks a created empty folder removed and everything else kept", () => {
		expect(undoFolderLine(FOLDERS[0]).status).toBe("removed");
		for (const folder of FOLDERS.slice(1)) {
			expect(undoFolderLine(folder).status).toBe("kept");
			expect(undoFolderLine(folder).explanation.length).toBeGreaterThan(0);
		}
	});
});

describe("buildUndoResult — the id → display-name seam", () => {
	it("resolves opaque engine ids to display names without dropping outcomes", () => {
		const engine: UndoEngineResult = {
			batchId: "b1",
			state: "rolled_back",
			outcome: "complete",
			files: [{ itemId: "m0", outcome: "restored" }],
			folders: [{ folderId: "f0", outcome: "removed" }],
		};
		const result = buildUndoResult(engine, {
			fileName: (id) => (id === "m0" ? "resume.pdf" : id),
			folderName: (id) => (id === "f0" ? "Screenshots" : id),
		});
		expect(result.outcome).toBe("complete");
		expect(result.files[0]).toMatchObject({
			itemId: "m0",
			name: "resume.pdf",
			outcome: "restored",
		});
		expect(result.folders[0]).toMatchObject({
			folderId: "f0",
			name: "Screenshots",
			outcome: "removed",
		});
	});
});

describe("undo control — the UI half of the duplicate-undo guard", () => {
	it("offers an enabled control while the sort is still undoable", () => {
		const control = undoControlPresentation({ undone: false });
		expect(control.disabled).toBe(false);
		expect(control.reason).toBeNull();
		expect(control.label).toMatch(/undo/i);
	});

	it("becomes a disabled, reason-bearing terminal state once undone", () => {
		const control = undoControlPresentation({ undone: true });
		expect(control.disabled).toBe(true);
		expect(control.reason).toBeTruthy();
		expect(control.label).toBe("Undone");
	});

	it("mirrors the engine: only an applied batch may be undone", () => {
		const states: readonly UndoBatchState[] = [
			"prepared",
			"applying",
			"applied",
			"rolling_back",
			"rolled_back",
			"needs_attention",
		];
		for (const state of states) {
			expect(isBatchUndoable(state)).toBe(state === "applied");
		}
	});
});
