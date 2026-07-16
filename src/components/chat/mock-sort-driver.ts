// ────────────────────────────────────────────────────────────────────────────
// DEV / MOCK SCAFFOLDING — NOT PRODUCTION CODE.
//
// This module fakes a sort request so the W12 chat shell can round-trip through
// every message state with no Electron IPC, no backend, and no LLM call. It is
// deliberately self-contained so W9+ (real capability IPC) and W13 (real plan
// review & approval) can delete it wholesale and swap in live data.
//
// `build*` functions are pure (they take a clock via `now`) so the message-model
// transitions can be asserted in unit tests. `runDriverSteps` is the only side
// effect: it replays the scripted steps on real timers.
// ────────────────────────────────────────────────────────────────────────────

import type { ChatMessage, PlanFolder } from "./message-model";

/** One scripted transition: apply `message` after waiting `delayMs`. */
export interface DriverStep {
	/** Delay (ms) before applying this step, relative to the previous step. */
	readonly delayMs: number;
	/** Message state to upsert (same id evolves in place; new id appends). */
	readonly message: ChatMessage;
}

export interface DriverHandle {
	/** Cancel any not-yet-applied steps (e.g. on "New chat" or unmount). */
	cancel: () => void;
}

/** A believable mock plan for "Sort my Downloads" — 42 files, 6 folders. */
const MOCK_PLAN_FOLDERS: readonly PlanFolder[] = [
	{
		name: "Invoices & Receipts",
		fileCount: 9,
		isNew: false,
		examples: ["acme-invoice-2026.pdf", "receipt-groceries-apr.pdf"],
	},
	{
		name: "Screenshots",
		fileCount: 14,
		isNew: true,
		examples: [
			"Screenshot 2026-05-01 at 09.14.png",
			"Screenshot 2026-05-03.png",
		],
	},
	{
		name: "Installers",
		fileCount: 6,
		isNew: true,
		examples: ["Figma-124.dmg", "zoom-installer.pkg"],
	},
	{
		name: "Contracts",
		fileCount: 4,
		isNew: false,
		examples: ["apartment-lease-2025.pdf", "internship-agreement.pdf"],
	},
	{
		name: "Photos",
		fileCount: 7,
		isNew: true,
		examples: ["IMG_2201.jpg", "IMG_2202.jpg"],
	},
	{
		name: "Misc PDFs",
		fileCount: 2,
		isNew: true,
		examples: ["notes.pdf", "boarding-pass.pdf"],
	},
];

const PROGRESS_TOTAL = 3;

function sumFiles(folders: readonly PlanFolder[]): number {
	return folders.reduce((total, folder) => total + folder.fileCount, 0);
}

function countNew(folders: readonly PlanFolder[]): number {
	return folders.filter((folder) => folder.isNew).length;
}

/**
 * Happy-path sort simulation: one assistant status message evolves
 * `pending` → `progress` (×N) → `plan` in place, then a separate `result`
 * message is appended (standing in for a W13 approval that is auto-granted here).
 */
export function buildSortRoundTrip(input: {
	assistantId: string;
	resultId: string;
	now: number;
}): DriverStep[] {
	const { assistantId, resultId, now } = input;
	const folders = MOCK_PLAN_FOLDERS;
	const fileCount = sumFiles(folders);
	const folderCount = folders.length;
	const createdFolderCount = countNew(folders);

	const steps: DriverStep[] = [
		{
			delayMs: 300,
			message: {
				kind: "pending",
				id: assistantId,
				createdAt: now,
				label: "Scanning Downloads…",
			},
		},
	];

	for (let current = 1; current <= PROGRESS_TOTAL; current += 1) {
		steps.push({
			delayMs: 500,
			message: {
				kind: "progress",
				id: assistantId,
				createdAt: now,
				label: "Grouping files into folders",
				current,
				total: PROGRESS_TOTAL,
			},
		});
	}

	steps.push({
		delayMs: 650,
		message: {
			kind: "plan",
			id: assistantId,
			createdAt: now,
			summary: `${fileCount} files into ${folderCount} folders`,
			fileCount,
			folderCount,
			createdFolderCount,
			folders,
		},
	});

	steps.push({
		delayMs: 800,
		message: {
			kind: "result",
			id: resultId,
			createdAt: now,
			summary: `Moved ${fileCount} files into ${folderCount} folders in Downloads. Nothing was renamed, overwritten, or deleted.`,
			movedCount: fileCount,
			folderCount,
			createdFolderCount,
		},
	});

	return steps;
}

/**
 * Failure simulation: the assistant status message evolves
 * `pending` → `progress` → `failed` in place.
 */
export function buildSortFailure(input: {
	assistantId: string;
	now: number;
}): DriverStep[] {
	const { assistantId, now } = input;
	return [
		{
			delayMs: 300,
			message: {
				kind: "pending",
				id: assistantId,
				createdAt: now,
				label: "Scanning Downloads…",
			},
		},
		{
			delayMs: 500,
			message: {
				kind: "progress",
				id: assistantId,
				createdAt: now,
				label: "Grouping files into folders",
				current: 1,
				total: PROGRESS_TOTAL,
			},
		},
		{
			delayMs: 700,
			message: {
				kind: "failed",
				id: assistantId,
				createdAt: now,
				title: "Couldn't reach the sorting service",
				detail:
					"The request timed out before a plan came back. Check your connection and try again.",
				retryable: true,
			},
		},
	];
}

/**
 * Undo simulation: a single `undo` message restoring the given result. Undo has
 * no intermediate states here — the real journal replay lands in the sort
 * pipeline work.
 */
export function buildUndoMessage(input: {
	id: string;
	now: number;
	restoredCount: number;
	removedFolderCount: number;
}): ChatMessage {
	const { id, now, restoredCount, removedFolderCount } = input;
	return {
		kind: "undo",
		id,
		createdAt: now,
		summary: `Restored ${restoredCount} files to their original locations. Empty folders Untie created were removed.`,
		restoredCount,
		removedFolderCount,
	};
}

/**
 * Replay `steps` on real timers, calling `apply` for each and `onDone` after the
 * last. Returns a handle whose `cancel()` stops any pending steps.
 */
export function runDriverSteps(
	steps: readonly DriverStep[],
	apply: (message: ChatMessage) => void,
	onDone?: () => void,
): DriverHandle {
	const timers: ReturnType<typeof setTimeout>[] = [];
	let cancelled = false;
	let elapsed = 0;

	steps.forEach((step, index) => {
		elapsed += step.delayMs;
		const isLast = index === steps.length - 1;
		timers.push(
			setTimeout(() => {
				if (cancelled) return;
				apply(step.message);
				if (isLast) onDone?.();
			}, elapsed),
		);
	});

	if (steps.length === 0) onDone?.();

	return {
		cancel: () => {
			cancelled = true;
			for (const timer of timers) clearTimeout(timer);
		},
	};
}
