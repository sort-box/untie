export type LlmErrorCode =
	| "INVALID_CONFIGURATION"
	| "NOT_AUTHENTICATED"
	| "REQUEST_FAILED"
	| "RATE_LIMITED"
	| "ACCOUNT_TOKEN_QUOTA_EXCEEDED"
	| "INVALID_RESPONSE"
	| "STRUCTURED_OUTPUT_INVALID";

export class LlmError extends Error {
	readonly code: LlmErrorCode;

	constructor(message: string, code: LlmErrorCode, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

export class LlmConfigurationError extends LlmError {
	constructor(message: string) {
		super(message, "INVALID_CONFIGURATION");
	}
}

export class LlmAuthenticationError extends LlmError {
	constructor() {
		super(
			"Authentication is required to use the LLM service",
			"NOT_AUTHENTICATED",
		);
	}
}

export class LlmRequestError extends LlmError {
	readonly status?: number;

	constructor(message: string, status?: number, options?: ErrorOptions) {
		super(message, "REQUEST_FAILED", options);
		this.status = status;
	}
}

export class LlmRateLimitError extends LlmError {
	readonly status: number;
	readonly retryAfterSeconds?: number;

	constructor(status: number, retryAfterSeconds?: number) {
		super("OpenRouter request was rate limited", "RATE_LIMITED");
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export class LlmAccountQuotaError extends LlmError {
	readonly limit: number;
	readonly remaining: number;
	readonly resetsAt: number;

	constructor(options: { limit: number; remaining: number; resetsAt: number }) {
		super(
			"The account has reached its weekly token limit",
			"ACCOUNT_TOKEN_QUOTA_EXCEEDED",
		);
		this.limit = options.limit;
		this.remaining = options.remaining;
		this.resetsAt = options.resetsAt;
	}
}

export class LlmResponseError extends LlmError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "INVALID_RESPONSE", options);
	}
}

export class LlmStructuredOutputError extends LlmError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "STRUCTURED_OUTPUT_INVALID", options);
	}
}
