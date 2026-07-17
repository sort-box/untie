import { useCallback, useEffect, useState } from "react";
import type {
	CapabilityClient,
	IndexStatus,
} from "../../../electron/capabilities/contracts.cjs";

function getBridge(): CapabilityClient | undefined {
	if (typeof globalThis === "undefined") return undefined;
	return (globalThis as { untie?: CapabilityClient }).untie;
}

/** Query the authoritative per-grant freshness snapshot. */
export async function getIndexStatus(
	grantId: string,
): Promise<IndexStatus | undefined> {
	const bridge = getBridge();
	if (!bridge) return undefined;
	try {
		const result = await bridge.getIndexStatus({ grantId });
		return result.ok ? result.value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Subscribe to push updates and immediately query to close the subscribe/query
 * race. `status.partial` is the marker find/chat should attach to answers.
 */
export function useIndexStatus(grantId: string | undefined) {
	const [status, setStatus] = useState<IndexStatus>();
	const refresh = useCallback(async () => {
		if (!grantId) {
			setStatus(undefined);
			return;
		}
		setStatus(await getIndexStatus(grantId));
	}, [grantId]);

	useEffect(() => {
		let active = true;
		const bridge = getBridge();
		const unsubscribe = bridge?.subscribeIndexStatus((update) => {
			if (active && update.grantId === grantId) setStatus(update.status);
		});
		void refresh();
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, [grantId, refresh]);

	return { status, refresh, partial: status?.partial ?? true } as const;
}
