import { createServerFn } from "@tanstack/react-start";

// A discriminated result union is used because plain data retains its type
// shape across TanStack Start's server-function serialization boundary.
export type CurrentIdentityResult =
	| { status: "authenticated"; userId: string }
	| { status: "unauthorized"; code: "UNAUTHORIZED" }
	| { status: "expired"; code: "SESSION_EXPIRED" };

// The resolver lives in a server-only module imported dynamically inside the
// handler so its Clerk server dependency never reaches the client bundle (a
// static import here trips TanStack Start's import protection at build time).
export const getCurrentIdentity = createServerFn({ method: "GET" }).handler(
	async () => {
		const { resolveCurrentIdentity } = await import(
			"./current-identity.server"
		);
		return resolveCurrentIdentity();
	},
);
