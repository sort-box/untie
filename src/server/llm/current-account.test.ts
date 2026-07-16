import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ServerSessionExpiredError,
	ServerUnauthorizedError,
} from "../auth/errors";
import { requireServerIdentity } from "../auth/identity.server";
import { createCurrentAccountLlmService } from "./current-account.server";
import { LlmAuthenticationError, LlmSessionExpiredError } from "./errors";

vi.mock("../auth/identity.server", () => ({
	requireServerIdentity: vi.fn(),
}));

const identityMock = vi.mocked(requireServerIdentity);

describe("current-account LLM gateway authentication", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns a typed unauthenticated error", async () => {
		identityMock.mockRejectedValueOnce(new ServerUnauthorizedError());
		await expect(createCurrentAccountLlmService()).rejects.toBeInstanceOf(
			LlmAuthenticationError,
		);
	});

	it("returns a distinct typed expired-session error", async () => {
		identityMock.mockRejectedValueOnce(new ServerSessionExpiredError());
		await expect(createCurrentAccountLlmService()).rejects.toBeInstanceOf(
			LlmSessionExpiredError,
		);
	});
});
