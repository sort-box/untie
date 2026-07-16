import type { CurrentIdentityResult } from "./current-identity";
import { ServerAuthError } from "./errors";
import { requireServerIdentity } from "./identity.server";

export async function resolveCurrentIdentity(): Promise<CurrentIdentityResult> {
	try {
		const identity = await requireServerIdentity();
		await identity.getToken();
		return { status: "authenticated", userId: identity.userId };
	} catch (error) {
		if (error instanceof ServerAuthError) {
			return error.code === "UNAUTHORIZED"
				? { status: "unauthorized", code: error.code }
				: { status: "expired", code: error.code };
		}
		throw error;
	}
}
