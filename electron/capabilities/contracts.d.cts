export type CapabilityErrorCode =
	| "INVALID_REQUEST"
	| "INVALID_RESPONSE"
	| "CANCELLED"
	| "NOT_IMPLEMENTED"
	| "INTERNAL"
	| "UNKNOWN_CAPABILITY"
	| "UNAUTHORIZED"
	| "REVOKED_GRANT"
	| "STALE_REFERENCE"
	| "NOT_CONTAINED"
	| "PATH_SUPPLIED"
	| "EXPIRED_ID"
	| "INVALIDATED_ID"
	| "UNKNOWN_RISK_CLASSIFICATION"
	| "UNKNOWN_ACKNOWLEDGMENT_TOKEN"
	| "ACKNOWLEDGMENT_TOKEN_CONSUMED"
	| "ACKNOWLEDGMENT_TOKEN_MISMATCH";

export type CapabilityError = {
	code: CapabilityErrorCode;
	message: string;
	details?: unknown;
};

export type CapabilityResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: CapabilityError };

export type InvokeOptions = { signal?: AbortSignal };
export type OpaqueIdRequest<K extends string> = { [P in K]: string };
export type PlanOperation = {
	itemId: string;
	destination:
		| { existingFolderId: string; newFolderName?: never }
		| { existingFolderId?: never; newFolderName: string };
};
export type FolderGrantState = "active" | "missing" | "moved" | "revoked";
export type FolderGrant = {
	readonly grantId: string;
	readonly state: FolderGrantState;
	readonly createdAt: number;
};
export type ScanSkipReason =
	| "HIDDEN"
	| "SYMLINK_OR_ALIAS"
	| "PACKAGE_BUNDLE"
	| "TEMPORARY_DOWNLOAD"
	| "APP_DATA"
	| "UNSUPPORTED_TYPE";
export type ScanNamedEntry = { readonly name: string };
export type ScanFileEntry = ScanNamedEntry & { readonly itemId: string };
export type ScanSkippedEntry = ScanNamedEntry & {
	readonly reason: ScanSkipReason;
};
export type ScanFolderResult = {
	readonly files: ScanFileEntry[];
	readonly candidateDestinations: ScanNamedEntry[];
	readonly skipped: ScanSkippedEntry[];
};
export type IndexOperationalState =
	| "idle"
	| "syncing"
	| "stale"
	| "unavailable";
export type IndexReadiness = "partial" | "complete" | "error";
export type IndexProgressPhase =
	| "pending"
	| "scanning"
	| "processing"
	| "committing"
	| "complete"
	| "error";
export type IndexStatus = {
	readonly state: IndexOperationalState;
	readonly readiness: IndexReadiness;
	/** Explicit UI marker: label find/chat answers while true. */
	readonly partial: boolean;
	readonly lastSyncedAt: number | null;
	readonly counts: {
		readonly indexed: number;
		readonly added: number;
		readonly updated: number;
		readonly removed: number;
	};
	readonly progress: {
		readonly phase: IndexProgressPhase;
		readonly processed: number;
		readonly total: number;
	};
	readonly error: { readonly code: string; readonly message: string } | null;
};
export type IndexStatusEvent = {
	readonly grantId: string;
	readonly status: IndexStatus;
};
export type SortRiskCode =
	| "FILE_COUNT_TOO_LARGE"
	| "TOTAL_SIZE_TOO_LARGE"
	| "TOOL_MANAGED_FOLDER";
export type SortRiskClassification = {
	readonly classificationId: string;
	readonly risky: boolean;
	readonly risks: readonly {
		readonly code: SortRiskCode;
		readonly reason: string;
	}[];
	readonly metrics: { readonly fileCount: number; readonly totalBytes: number };
	readonly toolMarkers: readonly string[];
};
export type StartupReason =
	| "migration_failure"
	| "grant_restore_failure"
	| "journal_recovery_failure"
	| "journal_needs_attention"
	| "unavailable_grant"
	| "expired_auth"
	| "unauthorized_auth"
	| "interrupted_onboarding";
export type StartupStatus = {
	readonly status: "recovered" | "needs_attention" | "blocked";
	readonly reasons: readonly StartupReason[];
	readonly recoveredBatchCount: number;
	readonly needsAttentionCount: number;
	readonly detail?: { readonly code: string; readonly store?: string };
};

// Chat persistence (P2). Messages are typed loosely at the capability boundary
// by their shared base fields only: the concrete `ChatMessage` union lives in
// the renderer message model, and the store round-trips whatever structured
// message documents the renderer wrote. The renderer narrows back to its union
// at the persistence adapter. Kept structural (no index signature) so the
// concrete union stays assignable to it on the write path.
export type PersistedChatMessage = {
	readonly kind: string;
	readonly id: string;
	readonly createdAt: number;
};

/** The write payload the renderer sends; the store derives title/updatedAt. */
export type ChatSessionInput = {
	readonly id: string;
	readonly createdAt: number;
	readonly messages: readonly PersistedChatMessage[];
};

/** A full stored session, as returned when loading or after a save. */
export type PersistedChatSession = {
	readonly id: string;
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly messages: readonly PersistedChatMessage[];
};

/** A lightweight session listing entry (no messages). */
export type ChatSessionSummary = {
	readonly id: string;
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly messageCount: number;
};

export interface CapabilityMap {
	getStartupStatus: {
		request: Record<never, never>;
		response: StartupStatus;
	};
	ping: { request: { message: string }; response: { message: string } };
	cancellableDelay: {
		request: { milliseconds: number };
		response: { completed: boolean };
	};
	selectFolder: {
		request: Record<never, never>;
		response: { grantId: string | null };
	};
	listFolderGrants: {
		request: Record<never, never>;
		response: { grants: FolderGrant[] };
	};
	revokeFolderGrant: {
		request: OpaqueIdRequest<"grantId">;
		response: { revoked: boolean };
	};
	scanFolder: {
		request: OpaqueIdRequest<"grantId">;
		response: ScanFolderResult;
	};
	getIndexStatus: {
		request: OpaqueIdRequest<"grantId">;
		response: IndexStatus;
	};
	classifyFolderRisk: {
		request: OpaqueIdRequest<"grantId">;
		response: SortRiskClassification;
	};
	acknowledgeFolderRisk: {
		request: OpaqueIdRequest<"classificationId">;
		response: { acknowledgmentToken: string };
	};
	queryIndex: {
		request: {
			grantId: string;
			interpretedQuery: {
				searchTerms: string[];
				filters: {
					extensions: string[];
					namePatterns: string[];
					modifiedAt: { after: string | null; before: string | null } | null;
				};
			};
			limit?: number;
		};
		response: {
			partial: boolean;
			candidates: Array<{
				itemId: string;
				displayName: string;
				snippet: string;
			}>;
		};
	};
	preparePlan: {
		request: { grantId: string; operations: PlanOperation[] };
		response: { planId: string };
	};
	applyPlan: {
		request: OpaqueIdRequest<"planId">;
		response: { operationId: string };
	};
	undo: {
		request: OpaqueIdRequest<"operationId">;
		response: { undone: boolean };
	};
	revealItem: {
		request: OpaqueIdRequest<"itemId">;
		response: { revealed: boolean };
	};
	openItem: {
		request: OpaqueIdRequest<"itemId">;
		response: { opened: boolean };
	};
	listChatSessions: {
		request: Record<never, never>;
		response: { sessions: ChatSessionSummary[] };
	};
	loadChatSession: {
		request: OpaqueIdRequest<"sessionId">;
		response: { session: PersistedChatSession | null };
	};
	saveChatSession: {
		request: { session: ChatSessionInput };
		response: { session: PersistedChatSession };
	};
	deleteChatSession: {
		request: OpaqueIdRequest<"sessionId">;
		response: { deleted: boolean };
	};
	deleteAllChatData: {
		request: Record<never, never>;
		response: { deletedCount: number };
	};
}

export type CapabilityName = keyof CapabilityMap;
export type CapabilityClient = {
	[K in CapabilityName]: (
		input: CapabilityMap[K]["request"],
		options?: InvokeOptions,
	) => Promise<CapabilityResult<CapabilityMap[K]["response"]>>;
} & {
	subscribeIndexStatus(listener: (event: IndexStatusEvent) => void): () => void;
};

export const capabilityNames: readonly CapabilityName[];
export const errorCodes: readonly CapabilityErrorCode[];
