import { auth } from "@clerk/tanstack-react-start/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentIdentity } from "./current-identity.server";
import { ServerSessionExpiredError, ServerUnauthorizedError } from "./errors";
import { requireServerIdentity } from "./identity.server";

vi.mock("@clerk/tanstack-react-start/server", () => ({ auth: vi.fn() }));

const authMock = vi.mocked(auth);

function authenticatedState(options?: {
	expiresAt?: number;
	token?: string | null;
}) {
	return {
		isAuthenticated: true as const,
		userId: "user_opaque_123",
		sessionClaims: {
			aud: "untie",
			exp: options?.expiresAt ?? Math.floor(Date.now() / 1_000) + 3_600,
		},
		getToken: vi.fn(async () =>
			options?.token === undefined ? "server-secret-token" : options.token,
		),
	};
}

describe("server identity", () => {
	beforeEach(() => vi.clearAllMocks());

	it("resolves a verified identity and returns only its opaque user ID", async () => {
		const authState = authenticatedState();
		authMock.mockResolvedValue(
			authState as unknown as Awaited<ReturnType<typeof auth>>,
		);

		const identity = await requireServerIdentity();
		expect(identity.userId).toBe("user_opaque_123");
		expect(await identity.getToken()).toBe("server-secret-token");
		expect(await resolveCurrentIdentity()).toEqual({
			status: "authenticated",
			userId: "user_opaque_123",
		});
	});

	it("distinguishes an absent session as unauthorized", async () => {
		authMock.mockResolvedValue({
			isAuthenticated: false,
		} as Awaited<ReturnType<typeof auth>>);

		await expect(requireServerIdentity()).rejects.toBeInstanceOf(
			ServerUnauthorizedError,
		);
		expect(await resolveCurrentIdentity()).toEqual({
			status: "unauthorized",
			code: "UNAUTHORIZED",
		});
	});

	it("distinguishes an invalid token as an expired session", async () => {
		authMock.mockResolvedValue(
			authenticatedState({ token: null }) as unknown as Awaited<
				ReturnType<typeof auth>
			>,
		);

		const identity = await requireServerIdentity();
		await expect(identity.getToken()).rejects.toBeInstanceOf(
			ServerSessionExpiredError,
		);
		expect(await resolveCurrentIdentity()).toEqual({
			status: "expired",
			code: "SESSION_EXPIRED",
		});
	});

	it("rejects an authenticated session whose JWT has expired", async () => {
		authMock.mockResolvedValue(
			authenticatedState({ expiresAt: 1 }) as unknown as Awaited<
				ReturnType<typeof auth>
			>,
		);

		await expect(requireServerIdentity()).rejects.toBeInstanceOf(
			ServerSessionExpiredError,
		);
	});
});
