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
	| "PATH_SUPPLIED";

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

export interface CapabilityMap {
	ping: { request: { message: string }; response: { message: string } };
	cancellableDelay: {
		request: { milliseconds: number };
		response: { completed: boolean };
	};
	selectFolder: {
		request: Record<never, never>;
		response: { grantId: string };
	};
	scanFolder: {
		request: OpaqueIdRequest<"grantId">;
		response: { scanId: string; itemIds: string[] };
	};
	queryIndex: {
		request: { query: string; limit?: number };
		response: { itemIds: string[] };
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
}

export type CapabilityName = keyof CapabilityMap;
export type CapabilityClient = {
	[K in CapabilityName]: (
		input: CapabilityMap[K]["request"],
		options?: InvokeOptions,
	) => Promise<CapabilityResult<CapabilityMap[K]["response"]>>;
};

export const capabilityNames: readonly CapabilityName[];
export const errorCodes: readonly CapabilityErrorCode[];
