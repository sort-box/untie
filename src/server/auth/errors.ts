export type ServerAuthErrorCode = "UNAUTHORIZED" | "SESSION_EXPIRED";

export class ServerAuthError extends Error {
	readonly code: ServerAuthErrorCode;

	constructor(
		message: string,
		code: ServerAuthErrorCode,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

export class ServerUnauthorizedError extends ServerAuthError {
	constructor() {
		super("Authentication is required", "UNAUTHORIZED");
	}
}

export class ServerSessionExpiredError extends ServerAuthError {
	constructor(options?: ErrorOptions) {
		super("The authenticated session has expired", "SESSION_EXPIRED", options);
	}
}
