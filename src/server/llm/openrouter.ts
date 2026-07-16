import {
	LlmCancelledError,
	LlmConfigurationError,
	LlmError,
	LlmOfflineError,
	LlmRateLimitError,
	LlmRequestError,
	LlmResponseError,
	LlmStructuredOutputError,
	LlmTimeoutError,
} from "./errors";
import type {
	LlmRequest,
	LlmResult,
	LlmService,
	LlmUsage,
	StructuredLlmRequest,
} from "./types";

const OPENROUTER_CHAT_COMPLETIONS_URL =
	"https://openrouter.ai/api/v1/chat/completions";

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";

export interface OpenRouterServiceOptions {
	apiKey: string;
	model?: string;
	appUrl?: string;
	appName?: string;
	fetch?: typeof globalThis.fetch;
	defaultTimeoutMs?: number;
	requestIdFactory?: () => string;
}

interface OpenRouterCompletion {
	id: string;
	model: string;
	choices: Array<{
		message?: { content?: string | null };
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	cost?: number;
}

interface RequestSignal {
	signal: AbortSignal;
	didTimeout: () => boolean;
	didCancel: () => boolean;
	cleanup: () => void;
}

export class OpenRouterService implements LlmService {
	readonly #apiKey: string;
	readonly #model: string;
	readonly #appUrl?: string;
	readonly #appName?: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #defaultTimeoutMs: number;
	readonly #requestIdFactory: () => string;

	constructor(options: OpenRouterServiceOptions) {
		const apiKey = options.apiKey.trim();
		if (!apiKey) {
			throw new LlmConfigurationError("OpenRouter API key is required");
		}

		const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
		if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
			throw new LlmConfigurationError(
				"OpenRouter default timeout must be greater than zero",
			);
		}

		this.#apiKey = apiKey;
		this.#model = options.model ?? DEFAULT_OPENROUTER_MODEL;
		this.#appUrl = options.appUrl;
		this.#appName = options.appName;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#defaultTimeoutMs = defaultTimeoutMs;
		this.#requestIdFactory =
			options.requestIdFactory ?? (() => crypto.randomUUID());
	}

	async generateText(request: LlmRequest): Promise<LlmResult<string>> {
		return await this.#complete(request);
	}

	async generateObject<T>(
		request: StructuredLlmRequest<T>,
	): Promise<LlmResult<T>> {
		const result = await this.#complete(request, {
			type: "json_schema",
			json_schema: {
				name: request.responseSchema.name,
				strict: true,
				schema: request.responseSchema.schema,
			},
		});

		let decoded: unknown;
		try {
			decoded = JSON.parse(result.data);
		} catch (error) {
			throw new LlmStructuredOutputError(
				"OpenRouter returned invalid JSON for a structured response",
				{ cause: error, requestId: result.requestId },
			);
		}

		try {
			return {
				...result,
				data: request.responseSchema.parse(decoded),
			};
		} catch (error) {
			throw new LlmStructuredOutputError(
				"OpenRouter response did not satisfy the expected structure",
				{ cause: error, requestId: result.requestId },
			);
		}
	}

	async #complete(
		request: LlmRequest,
		responseFormat?: Record<string, unknown>,
	): Promise<LlmResult<string>> {
		const requestId = request.requestId ?? this.#requestIdFactory();
		if (request.messages.length === 0) {
			throw new LlmConfigurationError("At least one LLM message is required", {
				requestId,
			});
		}

		const requestSignal = createRequestSignal(
			request.signal,
			request.timeoutMs ?? this.#defaultTimeoutMs,
		);

		let response: Response;
		try {
			response = await this.#fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
				method: "POST",
				headers: this.#headers(requestId),
				body: JSON.stringify({
					model: request.model ?? this.#model,
					messages: request.messages,
					stream: false,
					...(request.maxTokens === undefined
						? {}
						: { max_tokens: request.maxTokens }),
					...(responseFormat === undefined
						? {}
						: {
								response_format: responseFormat,
								provider: { require_parameters: true },
							}),
				}),
				signal: requestSignal.signal,
			});
		} catch (error) {
			if (requestSignal.didTimeout()) {
				throw new LlmTimeoutError({ cause: error, requestId });
			}
			if (requestSignal.didCancel() || isAbortError(error)) {
				throw new LlmCancelledError({ cause: error, requestId });
			}
			if (isOfflineError(error)) {
				throw new LlmOfflineError({ cause: error, requestId });
			}
			throw new LlmRequestError("OpenRouter request failed", undefined, {
				cause: error,
				requestId,
				retryable: true,
			});
		} finally {
			requestSignal.cleanup();
		}

		if (!response.ok) {
			if (response.status === 429 || response.status === 503) {
				throw new LlmRateLimitError(
					response.status,
					parseRetryAfter(response.headers.get("Retry-After")),
					{ requestId },
				);
			}

			throw new LlmRequestError(
				`OpenRouter request failed with status ${response.status}`,
				response.status,
				{ requestId },
			);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new LlmResponseError("OpenRouter returned a non-JSON response", {
				cause: error,
				requestId,
			});
		}

		let completion: OpenRouterCompletion;
		try {
			completion = parseCompletion(payload);
		} catch (error) {
			if (error instanceof LlmError) throw error.withRequestId(requestId);
			throw error;
		}
		const choice = completion.choices[0];
		const content = choice?.message?.content;
		if (typeof content !== "string") {
			throw new LlmResponseError(
				"OpenRouter response did not contain content",
				{
					requestId,
				},
			);
		}

		return {
			data: content,
			requestId,
			providerRequestId: completion.id,
			model: completion.model,
			finishReason: choice.finish_reason ?? null,
			usage: parseUsage(completion.usage),
			cost: completion.cost,
		};
	}

	#headers(requestId: string): Record<string, string> {
		return {
			Authorization: `Bearer ${this.#apiKey}`,
			"Content-Type": "application/json",
			"X-Request-ID": requestId,
			...(this.#appUrl ? { "HTTP-Referer": this.#appUrl } : {}),
			...(this.#appName ? { "X-OpenRouter-Title": this.#appName } : {}),
		};
	}
}

function parseCompletion(value: unknown): OpenRouterCompletion {
	if (!isRecord(value)) {
		throw new LlmResponseError("OpenRouter returned an invalid response body");
	}

	if (
		typeof value.id !== "string" ||
		typeof value.model !== "string" ||
		!Array.isArray(value.choices) ||
		value.choices.length === 0
	) {
		throw new LlmResponseError(
			"OpenRouter response is missing required fields",
		);
	}

	return value as unknown as OpenRouterCompletion;
}

function parseUsage(
	usage: OpenRouterCompletion["usage"],
): LlmUsage | undefined {
	if (!usage) return undefined;

	return {
		promptTokens: usage.prompt_tokens,
		completionTokens: usage.completion_tokens,
		totalTokens: usage.total_tokens,
	};
}

function createRequestSignal(
	externalSignal: AbortSignal | undefined,
	timeoutMs: number,
): RequestSignal {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new LlmConfigurationError(
			"Request timeout must be greater than zero",
		);
	}

	const controller = new AbortController();
	let timedOut = false;
	let cancelled = false;
	const abortFromExternal = () => {
		cancelled = true;
		controller.abort(externalSignal?.reason);
	};
	if (externalSignal?.aborted) abortFromExternal();
	else
		externalSignal?.addEventListener("abort", abortFromExternal, {
			once: true,
		});

	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	return {
		signal: controller.signal,
		didTimeout: () => timedOut,
		didCancel: () => cancelled,
		cleanup: () => {
			clearTimeout(timeout);
			externalSignal?.removeEventListener("abort", abortFromExternal);
		},
	};
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function isOfflineError(error: unknown): boolean {
	if (error instanceof TypeError) return true;
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	return [
		"EAI_AGAIN",
		"ECONNREFUSED",
		"ENETDOWN",
		"ENETUNREACH",
		"ENOTFOUND",
	].includes(String(error.code));
}
