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

export class UsageLimitedLlmService implements LlmService {
	constructor(
		private readonly service: LlmService,
		private readonly quota: TokenQuotaStore,
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
		const reservation = await this.quota.reserve(reservedTokens);

		let result: LlmResult<T>;
		try {
			result = await generate();
		} catch (error) {
			await this.quota.settle(reservation, 0);
			throw error;
		}

		await this.quota.settle(
			reservation,
			result.usage?.totalTokens ?? reservation.reservedTokens,
		);
		return result;
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
