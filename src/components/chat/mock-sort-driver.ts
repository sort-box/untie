// ────────────────────────────────────────────────────────────────────────────
// DEV / MOCK SCAFFOLDING — NOT PRODUCTION CODE.
//
// This module fakes a sort request so the chat shell can round-trip through
// every message state with no Electron IPC, no backend, and no LLM call. It is
// deliberately self-contained so the real capability IPC (W9+) and journaled
// apply (W14) can delete it wholesale and swap in live data.
//
// W13 note: a plan no longer auto-applies. `buildSortPlanSteps` stops at a
// `ready` plan and waits for the user to approve it in the plan card; approval
// then runs `buildApplySteps`. `buildStalePlan`/`buildInvalidPlan` stand in for
// the prepared-plan store (W11) marking a snapshot unusable — the plan card must
// refuse to approve them.
//
// `build*` functions are pure (they take a clock via `now`) so the message-model
// transitions can be asserted in unit tests. `runDriverSteps` is the only side
// effect: it replays the scripted steps on real timers.
// ────────────────────────────────────────────────────────────────────────────

import {
	type ApplyJournalState,
	applyOperationCompleted,
	applyProgressMessage,
	buildApplyJournalState,
	buildApplyResult,
	deriveApplyProgress,
} from "./apply-progress-model";
import {
	type ChatMessage,
	type PlanFolder,
	type PlanMessage,
	planCreatedFolderCount,
	planMoveCount,
} from "./message-model";
import type {
	SortDisclosureItem,
	SortDisclosureRequest,
} from "./sort-disclosure-model";

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

/**
 * A believable mock plan for "Sort my Downloads" — 42 files across 6 folders,
 * with the COMPLETE file list per destination so the plan card can render every
 * move (some groups are long on purpose, to exercise the expandable full list).
 */
const MOCK_PLAN_FOLDERS: readonly PlanFolder[] = [
	{
		name: "Invoices & Receipts",
		isNew: false,
		files: [
			"acme-invoice-2026.pdf",
			"receipt-groceries-apr.pdf",
			"aws-invoice-march.pdf",
			"receipt-pharmacy.pdf",
			"electricity-bill-q1.pdf",
			"invoice-freelance-482.pdf",
			"receipt-hardware-store.pdf",
			"phone-bill-may.pdf",
			"receipt-coffee.pdf",
		],
		// The model was unsure whether these two belong here vs. elsewhere.
		lowConfidenceFiles: ["phone-bill-may.pdf", "receipt-coffee.pdf"],
	},
	{
		name: "Screenshots",
		isNew: true,
		files: [
			"Screenshot 2026-05-01 at 09.14.png",
			"Screenshot 2026-05-03.png",
			"Screenshot 2026-05-04 at 14.22.png",
			"Screenshot 2026-05-07.png",
			"Screenshot 2026-05-09 at 08.01.png",
			"Screenshot 2026-05-11.png",
			"Screenshot 2026-05-12 at 17.45.png",
			"Screenshot 2026-05-15.png",
			"Screenshot 2026-05-18 at 11.30.png",
			"Screenshot 2026-05-20.png",
			"Screenshot 2026-05-22 at 19.12.png",
			"Screenshot 2026-05-24.png",
			"Screenshot 2026-05-27 at 07.55.png",
			"Screenshot 2026-05-29.png",
		],
	},
	{
		name: "Installers",
		isNew: true,
		files: [
			"Figma-124.dmg",
			"zoom-installer.pkg",
			"VSCode-darwin.dmg",
			"node-v22.pkg",
			"Docker.dmg",
			"Slack-4.36.dmg",
		],
	},
	{
		name: "Contracts",
		isNew: false,
		files: [
			"apartment-lease-2025.pdf",
			"internship-agreement.pdf",
			"nda-signed.pdf",
			"freelance-contract-q2.pdf",
		],
	},
	{
		name: "Photos",
		isNew: true,
		files: [
			"IMG_2201.jpg",
			"IMG_2202.jpg",
			"IMG_2203.jpg",
			"IMG_2204.jpg",
			"IMG_2205.jpg",
			"IMG_2206.jpg",
			"IMG_2207.jpg",
		],
	},
	{
		name: "Misc PDFs",
		isNew: true,
		files: ["notes.pdf", "boarding-pass.pdf"],
		// A catch-all destination is inherently a low-confidence guess.
		lowConfidenceFiles: ["notes.pdf", "boarding-pass.pdf"],
	},
];

// ── S3 disclosure mock ──────────────────────────────────────────────────────
// The exact outbound file records the pre-send disclosure gate would describe
// for "Sort my Downloads": each item is the payload record (opaque id + display
// name + metadata + optional content snippet) plus a human `category` used only
// to group the exclusion controls. The `displayName` values ARE the data that
// would be transmitted; the disclosure panel measures them via the S2 manifest
// but never renders them (PRD §8 — filenames are sensitive). Deleted wholesale
// once the real scan/manifest IPC (W9/S2) feeds live data in.
const MOCK_REQUEST_ITEMS: readonly SortDisclosureItem[] = [
	{
		category: "PDF documents",
		file: {
			id: "req-1",
			displayName: "apartment-lease-2025.pdf",
			extension: "pdf",
			sizeBytes: 184_320,
			modifiedAt: "2026-04-02T09:14:00Z",
			excerpt: "Residential lease agreement between tenant and landlord…",
		},
	},
	{
		category: "PDF documents",
		file: {
			id: "req-2",
			displayName: "acme-invoice-2026.pdf",
			extension: "pdf",
			sizeBytes: 88_200,
			modifiedAt: "2026-05-11T15:02:00Z",
			excerpt: "Invoice #4821 — amount due within 30 days…",
		},
	},
	{
		category: "PDF documents",
		file: {
			id: "req-3",
			displayName: "nda-signed.pdf",
			extension: "pdf",
			sizeBytes: 51_900,
			modifiedAt: "2026-03-20T11:41:00Z",
			excerpt: "Mutual non-disclosure agreement, effective…",
		},
	},
	{
		category: "PDF documents",
		file: {
			id: "req-4",
			displayName: "boarding-pass.pdf",
			extension: "pdf",
			sizeBytes: 22_400,
			modifiedAt: "2026-06-01T06:20:00Z",
			excerpt: "Boarding pass — gate B12, seat 14C…",
		},
	},
	{
		category: "Screenshots",
		file: {
			id: "req-5",
			displayName: "Screenshot 2026-05-01 at 09.14.png",
			extension: "png",
			sizeBytes: 412_000,
			modifiedAt: "2026-05-01T09:14:00Z",
		},
	},
	{
		category: "Screenshots",
		file: {
			id: "req-6",
			displayName: "Screenshot 2026-05-12 at 17.45.png",
			extension: "png",
			sizeBytes: 388_400,
			modifiedAt: "2026-05-12T17:45:00Z",
		},
	},
	{
		category: "Screenshots",
		file: {
			id: "req-7",
			displayName: "Screenshot 2026-05-24.png",
			extension: "png",
			sizeBytes: 401_100,
			modifiedAt: "2026-05-24T08:03:00Z",
		},
	},
	{
		category: "Installers",
		file: {
			id: "req-8",
			displayName: "Figma-124.dmg",
			extension: "dmg",
			sizeBytes: 96_400_000,
		},
	},
	{
		category: "Installers",
		file: {
			id: "req-9",
			displayName: "node-v22.pkg",
			extension: "pkg",
			sizeBytes: 44_800_000,
		},
	},
	{
		category: "Photos",
		file: {
			id: "req-10",
			displayName: "IMG_2201.jpg",
			extension: "jpg",
			sizeBytes: 3_120_000,
			modifiedAt: "2026-04-18T13:30:00Z",
		},
	},
	{
		category: "Photos",
		file: {
			id: "req-11",
			displayName: "IMG_2205.jpg",
			extension: "jpg",
			sizeBytes: 2_980_000,
			modifiedAt: "2026-04-18T13:34:00Z",
		},
	},
	{
		category: "Photos",
		file: {
			id: "req-12",
			displayName: "IMG_2207.jpg",
			extension: "jpg",
			sizeBytes: 3_050_000,
			modifiedAt: "2026-04-18T13:37:00Z",
		},
	},
];

/**
 * A believable pre-send sort request for the S3 disclosure gate. The disclosure
 * panel computes the S2 manifest from these exact records, so the counts it
 * shows equal the counts that would be sent.
 */
export function buildMockSortRequest(): SortDisclosureRequest {
	return {
		locationLabel: "Downloads",
		candidateDestinationNames: [
			"Invoices & Receipts",
			"Contracts",
			"Documents",
		],
		items: MOCK_REQUEST_ITEMS,
	};
}

const SCAN_PROGRESS_TOTAL = 3;

/** Denormalised summary fields for a `plan` message, derived from its folders. */
function planSummaryFields(folders: readonly PlanFolder[]) {
	const fileCount = planMoveCount(folders);
	const folderCount = folders.length;
	return {
		fileCount,
		folderCount,
		createdFolderCount: planCreatedFolderCount(folders),
		summary: `${fileCount} files into ${folderCount} folders`,
	};
}

/** Build a `plan` message for the given folders and approval status. */
function buildPlanMessage(input: {
	id: string;
	now: number;
	folders: readonly PlanFolder[];
	status: PlanMessage["status"];
	statusReason?: string;
}): PlanMessage {
	const { id, now, folders, status, statusReason } = input;
	return {
		kind: "plan",
		id,
		createdAt: now,
		...planSummaryFields(folders),
		folders,
		status,
		...(statusReason ? { statusReason } : {}),
	};
}

/**
 * Happy-path sort simulation: one assistant status message evolves
 * `pending` → `progress` (×N) → `plan` (`ready`) in place, then STOPS. The plan
 * card owns approval from here (W13) — apply runs only on the user's approval.
 */
export function buildSortPlanSteps(input: {
	assistantId: string;
	now: number;
	folders?: readonly PlanFolder[];
}): DriverStep[] {
	const { assistantId, now, folders = MOCK_PLAN_FOLDERS } = input;

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

	for (let current = 1; current <= SCAN_PROGRESS_TOTAL; current += 1) {
		steps.push({
			delayMs: 500,
			message: {
				kind: "progress",
				id: assistantId,
				createdAt: now,
				label: "Grouping files into folders",
				current,
				total: SCAN_PROGRESS_TOTAL,
			},
		});
	}

	steps.push({
		delayMs: 650,
		message: buildPlanMessage({
			id: assistantId,
			now,
			folders,
			status: "ready",
		}),
	});

	return steps;
}

/** The folder the mock apply reports moving into, for the summary copy. */
const APPLY_LOCATION_LABEL = "Downloads";
/** Delay before the first (starting / recovered) apply progress step. */
const APPLY_FIRST_STEP_DELAY_MS = 250;
/** Delay between each journaled per-operation advance. */
const APPLY_PER_OPERATION_DELAY_MS = 40;

/**
 * Replay one apply from a journal state, one operation at a time. The starting
 * (or recovered) state is shown first, then each pending operation is advanced
 * with `applyOperationCompleted` and re-derived into a `progress` step; the last
 * advance completes the journal and yields the final `result`. Every step is
 * DERIVED from the journal (via `applyProgressMessage` / `buildApplyResult`), so
 * the scripted timing is the only mock left — the numbers are the journal's.
 * This is the seam the real journal IPC (W14) plugs into: swap where the events
 * come from, keep the model.
 */
function applyStepsFromState(input: {
	applyId: string;
	now: number;
	state: ApplyJournalState;
}): DriverStep[] {
	const { applyId, now, state } = input;
	const meta = { id: applyId, createdAt: now };
	// Show the starting / recovered journal state immediately so a resumed apply
	// keeps its recovered count on screen before advancing.
	const steps: DriverStep[] = [
		{
			delayMs: APPLY_FIRST_STEP_DELAY_MS,
			message: applyProgressMessage(state, meta),
		},
	];
	let current = state;
	while (deriveApplyProgress(current).status === "applying") {
		current = applyOperationCompleted(current);
		const stillApplying = deriveApplyProgress(current).status === "applying";
		steps.push({
			delayMs: APPLY_PER_OPERATION_DELAY_MS,
			message: stillApplying
				? applyProgressMessage(current, meta)
				: buildApplyResult(current, meta),
		});
	}
	return steps;
}

/**
 * Apply simulation, run when the user approves a `ready` plan: a determinate
 * per-operation `progress` message evolves into the final `result`. The journal
 * state is built from the approved plan's own move set and every count derives
 * from it, so the progress and the summary always match the exact-counts copy
 * the user approved. Standing in for the journaled apply engine (W14).
 */
export function buildApplySteps(input: {
	applyId: string;
	now: number;
	folders: readonly PlanFolder[];
	/** Opaque apply handle (W14's `applyPlan` operationId); defaulted for the mock. */
	operationId?: string;
}): DriverStep[] {
	const { applyId, now, folders, operationId } = input;
	const state = buildApplyJournalState({
		operationId: operationId ?? `op_${applyId}`,
		locationLabel: APPLY_LOCATION_LABEL,
		folders,
	});
	return applyStepsFromState({ applyId, now, state });
}

/**
 * Resume an apply that was in flight when the transcript was persisted (S7
 * durability). Given the recovered journal state, it drives ONLY the remaining
 * pending operations to completion — the already-done ones stay done — so a
 * mid-apply reload continues from where the journal left off rather than
 * restarting.
 */
export function resumeApplySteps(input: {
	applyId: string;
	now: number;
	state: ApplyJournalState;
}): DriverStep[] {
	return applyStepsFromState(input);
}

/**
 * A plan the user cannot approve because its snapshot went stale (in production,
 * W11 marks a snapshot unusable after an edit, expiry, grant change, or a source
 * file changing). Rendered immediately, with no scanning preamble.
 */
export function buildStalePlan(input: {
	id: string;
	now: number;
	folders?: readonly PlanFolder[];
}): PlanMessage {
	const { id, now, folders = MOCK_PLAN_FOLDERS } = input;
	return buildPlanMessage({
		id,
		now,
		folders,
		status: "stale",
		statusReason:
			"Downloads changed after this plan was prepared. Regenerate to review the current files.",
	});
}

/**
 * A plan the user cannot approve because the deterministic validator (W10)
 * rejected it — e.g. a destination collision. Rendered immediately.
 */
export function buildInvalidPlan(input: {
	id: string;
	now: number;
	folders?: readonly PlanFolder[];
}): PlanMessage {
	const { id, now, folders = MOCK_PLAN_FOLDERS } = input;
	return buildPlanMessage({
		id,
		now,
		folders,
		status: "invalid",
		statusReason:
			"Two files would collide in “Screenshots”. Untie can't approve a plan until every move is valid.",
	});
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
				total: SCAN_PROGRESS_TOTAL,
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
