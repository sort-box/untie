export const JOURNAL_SCHEMA_VERSION: number;
export const BATCH_STATES: readonly string[];

export class JournaledApplyError extends Error {
	code: string;
	batchId?: string;
}

export class InjectedApplyCrash extends Error {
	constructor(point: string);
	point: string;
}

export interface JournalItem {
	type: "folder" | "move";
	state: string;
	[key: string]: unknown;
}

export interface JournalBatch {
	schemaVersion: number;
	id: string;
	state: string;
	trigger: string | null;
	items: JournalItem[];
	[key: string]: unknown;
}

export function createJournalStore(options: {
	directory: string;
	fsApi?: typeof import("node:fs");
	randomUUID?: () => string;
}): {
	persist(batch: JournalBatch): JournalBatch;
	read(batchId: string): JournalBatch;
	list(): JournalBatch[];
};

export function createJournaledApplyEngine(options: {
	preparedPlanStore: {
		getApproved(binding: { snapshotId: string; fingerprint: string }): unknown;
		invalidate?(snapshotId: string, reason: string): void;
	};
	authorizer: {
		resolveGrant(grantId: string): unknown;
		resolveItem(itemId: string, grantId: string): unknown;
	};
	journalDirectory: string;
	fsApi?: typeof import("node:fs");
	now?: () => number;
	randomUUID?: () => string;
	fault?: (point: string, context: Record<string, unknown>) => void;
}): {
	apply(binding: { snapshotId: string; fingerprint: string }): {
		batchId: string;
		state: string;
	};
	undo(batchId: string): {
		batchId: string;
		state: string;
		outcome: "complete" | "partial" | "unavailable";
		files: Array<{ itemId: string; outcome: string; reason?: string }>;
		folders: Array<{ folderId: string; outcome: string }>;
	};
	readBatch(batchId: string): JournalBatch;
	preflight(binding: { snapshotId: string; fingerprint: string }): unknown;
};
