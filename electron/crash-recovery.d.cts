import type { JournalBatch } from "./journaled-apply.cjs";

export type RecoverySummary = {
	batches: JournalBatch[];
	recoveredCount: number;
	needsAttention: string[];
};

export function createCrashRecoveryEngine(options: {
	journalDirectory: string;
	authorizer: { resolveGrant(grantId: string): unknown };
	fsApi?: typeof import("node:fs");
	now?: () => number;
	randomUUID?: () => string;
	fault?: (point: string, context: Record<string, unknown>) => void;
}): {
	recoverAll(): RecoverySummary;
	recoverBatch(batch: JournalBatch): JournalBatch;
	readBatch(batchId: string): JournalBatch;
};
