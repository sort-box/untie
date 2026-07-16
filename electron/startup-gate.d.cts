import type { StartupStatus } from "./capabilities/contracts.cjs";
export type {
	StartupReason,
	StartupStatus,
} from "./capabilities/contracts.cjs";
export const STARTUP_STATUSES: readonly StartupStatus["status"][];
export function runStartupGate(options: {
	initializeStores(): unknown | Promise<unknown>;
	restoreGrants(
		stores: unknown,
	): Array<{ state: string }> | Promise<Array<{ state: string }>>;
	recoverJournals(context: {
		stores: unknown;
		grants: Array<{ state: string }>;
	}):
		| { recoveredCount: number; needsAttention: string[] }
		| Promise<{ recoveredCount: number; needsAttention: string[] }>;
	checkAuth():
		| "authenticated"
		| "unauthorized"
		| "expired"
		| Promise<"authenticated" | "unauthorized" | "expired">;
	checkOnboarding(context: {
		stores: unknown;
		grants: Array<{ state: string }>;
	}): "complete" | "interrupted" | Promise<"complete" | "interrupted">;
}): Promise<StartupStatus>;
