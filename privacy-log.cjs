"use strict";

const SAFE_FIELDS = new Set([
	"accountRef", "actualTokens", "code", "count", "durationMs",
	"errorCode", "errorType", "grantId", "itemCount", "model",
	"operationId", "planId", "requestId", "reservedTokens", "status",
	"totalBytes",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const ABSOLUTE_PATH = /(?:^|\s)(?:\/[\w.@%+~=-]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g;
const API_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const FILENAME = /\b[^\s/\\]+\.[A-Za-z0-9]{1,10}\b/g;

function redactSensitiveText(value) {
	if (typeof value !== "string") return value;
	const scrubbed = value.replace(API_KEY, "[REDACTED]").replace(ABSOLUTE_PATH, "[REDACTED]").replace(FILENAME, "[REDACTED]");
	return scrubbed.length <= 48 ? scrubbed : "[REDACTED]";
}

function safeValue(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const scrubbed = redactSensitiveText(value);
	return SAFE_IDENTIFIER.test(scrubbed) ? scrubbed : "[REDACTED]";
}

function allowlistedMetadata(metadata) {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
	const safe = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (!SAFE_FIELDS.has(key)) continue;
		const sanitized = safeValue(value);
		if (sanitized !== undefined) safe[key] = sanitized;
	}
	return safe;
}

function errorMetadata(error) {
	if (!error || typeof error !== "object") return { errorType: "UnknownError" };
	const metadata = {
		errorType: typeof error.name === "string" && SAFE_IDENTIFIER.test(error.name) ? error.name : "Error",
	};
	if (typeof error.code === "string") metadata.errorCode = error.code;
	return allowlistedMetadata(metadata);
}

function createPrivacyLogger(write = (line) => console.info(line)) {
	return {
		log(level, event, metadata = {}) {
			const safeLevel = ["info", "warn", "error"].includes(level) ? level : "info";
			const redactedEvent = redactSensitiveText(event);
			const safeEvent = typeof redactedEvent === "string" && SAFE_IDENTIFIER.test(redactedEvent) ? redactedEvent : "diagnostic";
			write(JSON.stringify({ level: safeLevel, event: safeEvent, ...allowlistedMetadata(metadata) }));
		},
		reportCrash(event, error, metadata = {}) {
			this.log("error", event, { ...metadata, ...errorMetadata(error) });
		},
	};
}

const privacyLogger = createPrivacyLogger();
module.exports = { allowlistedMetadata, createPrivacyLogger, privacyLogger, redactSensitiveText };
