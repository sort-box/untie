import { ConvexError, v } from "convex/values";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";

export const WEEKLY_TOKEN_LIMIT = 1_000_000;

export const reserve = mutation({
	args: {
		reservationId: v.string(),
		requestedTokens: v.number(),
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const requestedTokens = requirePositiveInteger(
			args.requestedTokens,
			"requestedTokens",
		);
		const now = Date.now();
		const weekStart = getUtcWeekStart(now);

		const existingReservation = await ctx.db
			.query("tokenQuotaReservations")
			.withIndex("by_reservation_id", (q) =>
				q.eq("reservationId", args.reservationId),
			)
			.unique();
		if (existingReservation) {
			if (
				existingReservation.accountId !== identity.tokenIdentifier ||
				existingReservation.reservedTokens !== requestedTokens
			) {
				throw new ConvexError({ code: "RESERVATION_CONFLICT" });
			}
			return quotaResponse(
				await getQuota(ctx, identity.tokenIdentifier, weekStart),
				weekStart,
			);
		}

		const quota = await getQuota(ctx, identity.tokenIdentifier, weekStart);
		const consumed = (quota?.usedTokens ?? 0) + (quota?.reservedTokens ?? 0);
		if (consumed + requestedTokens > WEEKLY_TOKEN_LIMIT) {
			throw new ConvexError({
				code: "TOKEN_QUOTA_EXCEEDED",
				limit: WEEKLY_TOKEN_LIMIT,
				remaining: Math.max(0, WEEKLY_TOKEN_LIMIT - consumed),
				resetsAt: weekStart + 7 * 24 * 60 * 60 * 1_000,
			});
		}

		if (quota) {
			await ctx.db.patch(quota._id, {
				reservedTokens: quota.reservedTokens + requestedTokens,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("tokenQuotas", {
				accountId: identity.tokenIdentifier,
				weekStart,
				usedTokens: 0,
				reservedTokens: requestedTokens,
				updatedAt: now,
			});
		}

		await ctx.db.insert("tokenQuotaReservations", {
			reservationId: args.reservationId,
			accountId: identity.tokenIdentifier,
			weekStart,
			reservedTokens: requestedTokens,
			status: "reserved",
			createdAt: now,
		});

		return {
			limit: WEEKLY_TOKEN_LIMIT,
			used: quota?.usedTokens ?? 0,
			reserved: (quota?.reservedTokens ?? 0) + requestedTokens,
			remaining: WEEKLY_TOKEN_LIMIT - consumed - requestedTokens,
			resetsAt: weekStart + 7 * 24 * 60 * 60 * 1_000,
		};
	},
});

export const settle = mutation({
	args: {
		reservationId: v.string(),
		actualTokens: v.number(),
	},
	handler: async (ctx, args) => {
		const identity = await requireIdentity(ctx);
		const actualTokens = requireNonNegativeInteger(
			args.actualTokens,
			"actualTokens",
		);
		const reservation = await ctx.db
			.query("tokenQuotaReservations")
			.withIndex("by_reservation_id", (q) =>
				q.eq("reservationId", args.reservationId),
			)
			.unique();

		if (!reservation || reservation.accountId !== identity.tokenIdentifier) {
			throw new ConvexError({ code: "RESERVATION_NOT_FOUND" });
		}
		if (reservation.status === "settled") {
			if (reservation.actualTokens !== actualTokens) {
				throw new ConvexError({ code: "RESERVATION_CONFLICT" });
			}
			return;
		}
		if (actualTokens > reservation.reservedTokens) {
			throw new ConvexError({
				code: "ACTUAL_TOKENS_EXCEED_RESERVATION",
			});
		}

		const quota = await getQuota(
			ctx,
			identity.tokenIdentifier,
			reservation.weekStart,
		);
		if (!quota) {
			throw new ConvexError({ code: "QUOTA_NOT_FOUND" });
		}

		const now = Date.now();
		await ctx.db.patch(quota._id, {
			usedTokens: quota.usedTokens + actualTokens,
			reservedTokens: Math.max(
				0,
				quota.reservedTokens - reservation.reservedTokens,
			),
			updatedAt: now,
		});
		await ctx.db.patch(reservation._id, {
			status: "settled",
			actualTokens,
			settledAt: now,
		});
	},
});

export const current = query({
	args: {},
	handler: async (ctx) => {
		const identity = await requireIdentity(ctx);
		const weekStart = getUtcWeekStart(Date.now());
		return quotaResponse(
			await getQuota(ctx, identity.tokenIdentifier, weekStart),
			weekStart,
		);
	},
});

function getUtcWeekStart(timestamp: number): number {
	const date = new Date(timestamp);
	const dayFromMonday = (date.getUTCDay() + 6) % 7;
	return Date.UTC(
		date.getUTCFullYear(),
		date.getUTCMonth(),
		date.getUTCDate() - dayFromMonday,
	);
}

async function requireIdentity(ctx: {
	auth: {
		getUserIdentity: () => Promise<{ tokenIdentifier: string } | null>;
	};
}) {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new ConvexError({ code: "NOT_AUTHENTICATED" });
	return identity;
}

async function getQuota(
	ctx: MutationCtx | QueryCtx,
	accountId: string,
	weekStart: number,
) {
	return await ctx.db
		.query("tokenQuotas")
		.withIndex("by_account_week", (q) =>
			q.eq("accountId", accountId).eq("weekStart", weekStart),
		)
		.unique();
}

function quotaResponse(
	quota: { usedTokens: number; reservedTokens: number } | null | undefined,
	weekStart: number,
) {
	const used = quota?.usedTokens ?? 0;
	const reserved = quota?.reservedTokens ?? 0;
	return {
		limit: WEEKLY_TOKEN_LIMIT,
		used,
		reserved,
		remaining: Math.max(0, WEEKLY_TOKEN_LIMIT - used - reserved),
		resetsAt: weekStart + 7 * 24 * 60 * 60 * 1_000,
	};
}

function requirePositiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ConvexError({ code: "INVALID_ARGUMENT", argument: name });
	}
	return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ConvexError({ code: "INVALID_ARGUMENT", argument: name });
	}
	return value;
}
