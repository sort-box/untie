// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CapabilityClient,
	IndexStatus,
	IndexStatusEvent,
} from "../../../electron/capabilities/contracts.cjs";
import { getIndexStatus, useIndexStatus } from "./index-status";

const partialStatus: IndexStatus = {
	state: "syncing",
	readiness: "partial",
	partial: true,
	lastSyncedAt: null,
	counts: { indexed: 0, added: 0, updated: 0, removed: 0 },
	progress: { phase: "processing", processed: 1, total: 2 },
	error: null,
};

afterEach(() => {
	delete (globalThis as { untie?: CapabilityClient }).untie;
});

describe("renderer index freshness adapter", () => {
	it("queries status and consumes pushed partial-to-complete updates", async () => {
		let listener: ((event: IndexStatusEvent) => void) | undefined;
		const unsubscribe = vi.fn();
		(globalThis as { untie?: Partial<CapabilityClient> }).untie = {
			getIndexStatus: vi.fn(async () => ({
				ok: true as const,
				value: partialStatus,
			})),
			subscribeIndexStatus: vi.fn((next) => {
				listener = next;
				return unsubscribe;
			}),
		};

		await expect(getIndexStatus("grant-1")).resolves.toEqual(partialStatus);
		const { result, unmount } = renderHook(() => useIndexStatus("grant-1"));
		await waitFor(() => expect(result.current.status).toEqual(partialStatus));
		expect(result.current.partial).toBe(true);

		act(() =>
			listener?.({
				grantId: "grant-1",
				status: {
					...partialStatus,
					state: "idle",
					readiness: "complete",
					partial: false,
					progress: { phase: "complete", processed: 2, total: 2 },
				},
			}),
		);
		expect(result.current.partial).toBe(false);
		unmount();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
