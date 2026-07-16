import { describe, expect, it, vi } from "vitest";
import { createPrivacyLogger, redactSensitiveText } from "./privacy-log.cjs";

const SECRETS = {
	path: "/Users/alice/Secrets/tax-return-2024.pdf",
	filename: "tax-return-2024.pdf",
	prompt: "Summarize Alice's confidential tax return and list every payment.",
	apiKey: "sk-super-secret-provider-key-123456",
	payload: '{"choices":[{"message":{"content":"private response"}}]}',
};

describe("privacy logger", () => {
	it("emits only allowlisted metadata in real serialized output", () => {
		const output = [];
		const logger = createPrivacyLogger((line) => output.push(line));
		logger.log("info", "llm_gateway", {
			accountRef: "user_opaque123", requestId: "request_opaque456",
			model: "openai/gpt-5-mini", status: "completed",
			reservedTokens: 120, actualTokens: 80,
			path: SECRETS.path, filename: SECRETS.filename, prompt: SECRETS.prompt,
			apiKey: SECRETS.apiKey, rawProviderPayload: SECRETS.payload,
			unknownExtraField: "must-not-pass-through",
		});
		const captured = output.join("\n");
		for (const secret of Object.values(SECRETS)) expect(captured).not.toContain(secret);
		expect(captured).not.toContain("unknownExtraField");
		expect(JSON.parse(captured)).toEqual({
			level: "info", event: "llm_gateway", accountRef: "user_opaque123",
			requestId: "request_opaque456", model: "openai/gpt-5-mini",
			status: "completed", reservedTokens: 120, actualTokens: 80,
		});
	});

	it("crash diagnostics omit messages, stacks, paths, and extra fields", () => {
		const write = vi.fn();
		const logger = createPrivacyLogger(write);
		const error = new Error(`Could not read ${SECRETS.path}: ${SECRETS.prompt}`);
		error.stack = `${error.message}\n at ${SECRETS.path}:1:1`;
		error.code = "INDEX_SYNC_FAILED";
		logger.reportCrash("index_sync_crash", error, { status: "failed", rawProviderPayload: SECRETS.payload });
		const captured = write.mock.calls[0][0];
		for (const secret of Object.values(SECRETS)) expect(captured).not.toContain(secret);
		expect(JSON.parse(captured)).toEqual({ level: "error", event: "index_sync_crash", status: "failed", errorType: "Error", errorCode: "INDEX_SYNC_FAILED" });
	});

	it("does not trust a caller-provided event name", () => {
		const output = [];
		createPrivacyLogger((line) => output.push(line)).log("warn", SECRETS.filename);
		expect(output[0]).not.toContain(SECRETS.filename);
		expect(JSON.parse(output[0]).event).toBe("diagnostic");
	});

	it("scrubs sensitive text as defense in depth", () => {
		for (const secret of [SECRETS.path, SECRETS.filename, SECRETS.apiKey]) expect(redactSensitiveText(secret)).not.toContain(secret);
		expect(redactSensitiveText(SECRETS.prompt)).toBe("[REDACTED]");
	});
});
