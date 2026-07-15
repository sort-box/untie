import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { LlmAccountQuotaError } from "./errors";
import {
	isQuotaExceededData,
	type TokenQuotaReservation,
	type TokenQuotaStore,
} from "./usage-limited";

const reserveQuota = makeFunctionReference<
	"mutation",
	{ reservationId: string; requestedTokens: number },
	{
		limit: number;
		used: number;
		reserved: number;
		remaining: number;
		resetsAt: number;
	}
>("tokenQuotas:reserve");

const settleQuota = makeFunctionReference<
	"mutation",
	{ reservationId: string; actualTokens: number },
	null
>("tokenQuotas:settle");

export class ConvexTokenQuotaStore implements TokenQuotaStore {
	readonly #client: ConvexHttpClient;

	constructor(options: { convexUrl: string; token: string }) {
		this.#client = new ConvexHttpClient(options.convexUrl, {
			auth: options.token,
			logger: false,
		});
	}

	async reserve(requestedTokens: number): Promise<TokenQuotaReservation> {
		const reservationId = crypto.randomUUID();
		try {
			await this.#client.mutation(reserveQuota, {
				reservationId,
				requestedTokens,
			});
		} catch (error) {
			if (error instanceof ConvexError && isQuotaExceededData(error.data)) {
				throw new LlmAccountQuotaError(error.data);
			}
			throw error;
		}

		return { id: reservationId, reservedTokens: requestedTokens };
	}

	async settle(
		reservation: TokenQuotaReservation,
		actualTokens: number,
	): Promise<void> {
		await this.#client.mutation(settleQuota, {
			reservationId: reservation.id,
			actualTokens,
		});
	}
}
