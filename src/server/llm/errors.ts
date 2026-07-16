export type LlmErrorCode =
	| "INVALID_CONFIGURATION"
	| "NOT_AUTHENTICATED"
	| "SESSION_EXPIRED"
	| "REQUEST_FAILED"
	| "RATE_LIMITED"
	| "ACCOUNT_TOKEN_QUOTA_EXCEEDED"
	| "REQUEST_TIMEOUT"
	| "REQUEST_CANCELLED"
	| "OFFLINE"
	| "INVALID_RESPONSE"
	| "STRUCTURED_OUTPUT_INVALID";

export type LlmFailureClassification = "retryable" | "terminal";

export interface LlmErrorOptions extends ErrorOptions {
	requestId?: string;
	retryable?: boolean;
}

export class LlmError extends Error {
	readonly code: LlmErrorCode;
	readonly retryable: boolean;
	requestId?: string;

	constructor(
		message: string,
		code: LlmErrorCode,
		options: LlmErrorOptions = {},
	) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.requestId = options.requestId;
	}

	get classification(): LlmFailureClassification {
		return this.retryable ? "retryable" : "terminal";
	}

	withRequestId(requestId: string): this {
		this.requestId ??= requestId;
		return this;
	}
}

export class LlmConfigurationError extends LlmError {
	constructor(message: string, options?: LlmErrorOptions) {
		super(message, "INVALID_CONFIGURATION", options);
	}
}

export class LlmAuthenticationError extends LlmError {
	constructor(options?: LlmErrorOptions) {
		super(
			"Authentication is required to use the LLM service",
			"NOT_AUTHENTICATED",
			options,
		);
	}
}

export class LlmSessionExpiredError extends LlmError {
	constructor(options?: LlmErrorOptions) {
		super("The authenticated session has expired", "SESSION_EXPIRED", options);
	}
}

export class LlmRequestError extends LlmError {
	readonly status?: number;

	constructor(message: string, status?: number, options: LlmErrorOptions = {}) {
		super(message, "REQUEST_FAILED", {
			...options,
			retryable: options.retryable ?? (status !== undefined && status >= 500),
		});
		this.status = status;
	}
}

export class LlmRateLimitError extends LlmError {
	readonly status: number;
	readonly retryAfterSeconds?: number;

	constructor(
		status: number,
		retryAfterSeconds?: number,
		options?: LlmErrorOptions,
	) {
		super("OpenRouter request was rate limited", "RATE_LIMITED", {
			...options,
			retryable: true,
		});
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export class LlmAccountQuotaError extends LlmError {
	readonly limit: number;
	readonly remaining: number;
	readonly resetsAt: number;

	constructor(
		options: { limit: number; remaining: number; resetsAt: number },
		errorOptions?: LlmErrorOptions,
	) {
		super(
			"The account has reached its weekly token limit",
			"ACCOUNT_TOKEN_QUOTA_EXCEEDED",
			errorOptions,
		);
		this.limit = options.limit;
		this.remaining = options.remaining;
		this.resetsAt = options.resetsAt;
	}
}

export class LlmTimeoutError extends LlmError {
	constructor(options?: LlmErrorOptions) {
		super("The LLM request timed out", "REQUEST_TIMEOUT", {
			...options,
			retryable: true,
		});
	}
}

export class LlmCancelledError extends LlmError {
	constructor(options?: LlmErrorOptions) {
		super("The LLM request was cancelled", "REQUEST_CANCELLED", options);
	}
}

export class LlmOfflineError extends LlmError {
	constructor(options?: LlmErrorOptions) {
		super("The LLM service is unreachable", "OFFLINE", {
			...options,
			retryable: true,
		});
	}
}

export class LlmResponseError extends LlmError {
	constructor(message: string, options?: LlmErrorOptions) {
		super(message, "INVALID_RESPONSE", options);
	}
}

export class LlmStructuredOutputError extends LlmError {
	constructor(message: string, options?: LlmErrorOptions) {
		super(message, "STRUCTURED_OUTPUT_INVALID", options);
	}
}
