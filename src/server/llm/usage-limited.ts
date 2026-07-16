import { LlmAccountQuotaError } from "./errors";
import type {
	LlmRequest,
	LlmResult,
	LlmService,
	StructuredLlmRequest,
} from "./types";

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

export interface TokenQuotaReservation {
	id: string;
	reservedTokens: number;
}

export interface TokenQuotaStore {
	reserve(requestedTokens: number): Promise<TokenQuotaReservation>;
	settle(
		reservation: TokenQuotaReservation,
		actualTokens: number,
	): Promise<void>;
}

export type LlmGatewayLogEvent = {
	accountRef: string;
	model: string;
	status: "completed" | "failed" | "quota_exhausted";
	reservedTokens: number;
	actualTokens?: number;
};

export type LlmGatewayLogger = (event: LlmGatewayLogEvent) => void;

export type UsageLimitedLlmServiceOptions = {
	accountRef?: string;
	logger?: LlmGatewayLogger;
};

export class UsageLimitedLlmService implements LlmService {
	constructor(
		private readonly service: LlmService,
		private readonly quota: TokenQuotaStore,
		private readonly options: UsageLimitedLlmServiceOptions = {},
	) {}

	async generateText(request: LlmRequest): Promise<LlmResult<string>> {
		return await this.#run(request, () => this.service.generateText(request));
	}

	async generateObject<T>(
		request: StructuredLlmRequest<T>,
	): Promise<LlmResult<T>> {
		return await this.#run(
			request,
			() => this.service.generateObject(request),
			{
				additionalCharacters: JSON.stringify(request.responseSchema.schema)
					.length,
			},
		);
	}

	async #run<T>(
		request: LlmRequest,
		generate: () => Promise<LlmResult<T>>,
		options: { additionalCharacters?: number } = {},
	): Promise<LlmResult<T>> {
		const reservedTokens = estimateInputTokens(
			request,
			options.additionalCharacters,
		);
		let reservation: TokenQuotaReservation;
		try {
			reservation = await this.quota.reserve(reservedTokens);
		} catch (error) {
			if (error instanceof LlmAccountQuotaError) {
				this.#log(request, "quota_exhausted", reservedTokens);
			}
			throw error;
		}

		let result: LlmResult<T>;
		try {
			result = await generate();
		} catch (error) {
			await this.quota.settle(reservation, 0);
			this.#log(request, "failed", reservation.reservedTokens, 0);
			throw error;
		}

		const actualTokens = Math.min(
			result.usage?.totalTokens ?? reservation.reservedTokens,
			reservation.reservedTokens,
		);
		await this.quota.settle(reservation, actualTokens);
		this.#log(request, "completed", reservation.reservedTokens, actualTokens);
		return result;
	}

	#log(
		request: LlmRequest,
		status: LlmGatewayLogEvent["status"],
		reservedTokens: number,
		actualTokens?: number,
	): void {
		this.options.logger?.({
			accountRef: this.options.accountRef ?? "unknown",
			model: request.model ?? "default",
			status,
			reservedTokens,
			...(actualTokens === undefined ? {} : { actualTokens }),
		});
	}
}

export function estimateInputTokens(
	request: LlmRequest,
	additionalCharacters = 0,
): number {
	const encoder = new TextEncoder();
	const messageBytes = request.messages.reduce(
		(total, message) => total + encoder.encode(message.content).byteLength + 16,
		0,
	);
	const estimatedPromptTokens = Math.max(
		1,
		messageBytes + additionalCharacters,
	);
	return (
		estimatedPromptTokens + (request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)
	);
}

export function isQuotaExceededData(value: unknown): value is {
	code: "TOKEN_QUOTA_EXCEEDED";
	limit: number;
	remaining: number;
	resetsAt: number;
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		value.code === "TOKEN_QUOTA_EXCEEDED" &&
		"limit" in value &&
		typeof value.limit === "number" &&
		"remaining" in value &&
		typeof value.remaining === "number" &&
		"resetsAt" in value &&
		typeof value.resetsAt === "number"
	);
}

export { LlmAccountQuotaError };
