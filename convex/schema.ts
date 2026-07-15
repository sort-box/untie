import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	products: defineTable({
		title: v.string(),
		imageId: v.string(),
		price: v.number(),
	}),
	todos: defineTable({
		text: v.string(),
		completed: v.boolean(),
	}),
	tokenQuotas: defineTable({
		accountId: v.string(),
		weekStart: v.number(),
		usedTokens: v.number(),
		reservedTokens: v.number(),
		updatedAt: v.number(),
	}).index("by_account_week", ["accountId", "weekStart"]),
	tokenQuotaReservations: defineTable({
		reservationId: v.string(),
		accountId: v.string(),
		weekStart: v.number(),
		reservedTokens: v.number(),
		actualTokens: v.optional(v.number()),
		status: v.union(v.literal("reserved"), v.literal("settled")),
		createdAt: v.number(),
		settledAt: v.optional(v.number()),
	}).index("by_reservation_id", ["reservationId"]),
});
