import { auth } from "@clerk/tanstack-react-start/server";
import { ServerSessionExpiredError, ServerUnauthorizedError } from "./errors";

export type ServerTokenOptions = { template?: string };

export type ServerIdentity = {
	userId: string;
	tokenAudience: unknown;
	getToken: (options?: ServerTokenOptions) => Promise<string>;
};

// Classification note: Clerk's server `auth()` collapses a never-signed-in
// request and one whose session cookie has plainly expired into the same
// signed-out state, so both surface here as UNAUTHORIZED. SESSION_EXPIRED is
// reserved for the cases we can positively detect after verification: a still
// non-expired `exp` claim that Clerk nonetheless refuses to mint a token for
// (e.g. a session revoked mid-request), and a defensively-checked past `exp`.
export async function requireServerIdentity(): Promise<ServerIdentity> {
	const authState = await auth();
	if (!authState.isAuthenticated) throw new ServerUnauthorizedError();

	const expiresAt = authState.sessionClaims.exp;
	if (typeof expiresAt === "number" && expiresAt <= Date.now() / 1_000) {
		throw new ServerSessionExpiredError();
	}

	return {
		userId: authState.userId,
		tokenAudience: authState.sessionClaims.aud,
		async getToken(options) {
			let token: string | null;
			try {
				token = await authState.getToken(options);
			} catch (cause) {
				throw new ServerSessionExpiredError({ cause });
			}
			if (!token) throw new ServerSessionExpiredError();
			return token;
		},
	};
}
