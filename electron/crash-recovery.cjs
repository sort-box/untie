const fs = require("node:fs");
const path = require("node:path");
const { createJournalStore } = require("./journaled-apply.cjs");

const TERMINAL_BATCH_STATES = new Set([
	"applied",
	"rolled_back",
	"needs_attention",
]);
const SUCCESS_ITEM_STATES = new Set(["moved", "created", "exists"]);

function sameIdentity(stat, evidence) {
	return stat.dev === evidence?.dev && stat.ino === evidence?.ino;
}

function statOrNull(fsApi, target) {
	try {
		return fsApi.statSync(target);
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
		throw error;
	}
}

function markConflict(item, reason) {
	item.state = "revert_conflict";
	item.reason = reason;
}

function createCrashRecoveryEngine({
	journalDirectory,
	authorizer,
	fsApi = fs,
	now = Date.now,
	randomUUID,
	fault = () => {},
}) {
	if (!journalDirectory || !authorizer)
		throw new TypeError("journalDirectory and authorizer are required");
	const journal = createJournalStore({
		directory: journalDirectory,
		fsApi,
		...(randomUUID ? { randomUUID } : {}),
	});

	function persist(batch, point) {
		batch.updatedAt = now();
		journal.persist(batch);
		fault(point, { batchId: batch.id });
	}

	function resolveAttempting(item) {
		if (item.type === "folder") {
			const found = statOrNull(fsApi, item.path);
			if (item.existed) {
				if (found?.isDirectory()) {
					item.state = "exists";
					item.createdByUs = false;
				} else {
					item.state = "failed";
					item.reason = "DESTINATION_CHANGED";
				}
			} else if (!found) {
				item.state = "pending";
			} else if (found.isDirectory()) {
				item.state = "created";
				item.createdByUs = true;
			} else {
				item.state = "failed";
				item.reason = "DESTINATION_CHANGED";
			}
			return;
		}

		const source = statOrNull(fsApi, item.source);
		const target = statOrNull(fsApi, item.target);
		const targetIsOurs = target && sameIdentity(target, item.sourceFingerprint);
		if (targetIsOurs) {
			// W14's exclusive link+unlink move can crash with both hard links. Finish
			// that primitive before reverse replay so the evidence becomes unambiguous.
			if (source && sameIdentity(source, item.sourceFingerprint))
				fsApi.unlinkSync(item.source);
			item.postMoveFingerprint = {
				canonicalPath: item.target,
				size: target.size,
				mtimeMs: target.mtimeMs,
				dev: target.dev,
				ino: target.ino,
			};
			item.state = "moved";
		} else if (
			source &&
			sameIdentity(source, item.sourceFingerprint) &&
			!target
		) {
			item.state = "pending";
		} else {
			item.state = "failed";
			item.reason = "IN_DOUBT_CONFLICT";
		}
	}

	function reverseMove(item) {
		if (item.state === "reverted" || item.state === "revert_conflict") return;
		if (item.state === "attempting") resolveAttempting(item);
		if (!["moved", "reverting"].includes(item.state)) return;

		const evidence = item.postMoveFingerprint || item.sourceFingerprint;
		const source = statOrNull(fsApi, item.source);
		const target = statOrNull(fsApi, item.target);
		if (source) {
			if (sameIdentity(source, evidence) && !target) {
				item.state = "reverted";
				return;
			}
			if (
				sameIdentity(source, evidence) &&
				target &&
				sameIdentity(target, evidence)
			) {
				fsApi.unlinkSync(item.target);
				item.state = "reverted";
				return;
			}
			markConflict(item, "origin_occupied");
			return;
		}
		if (!target) {
			markConflict(
				item,
				statOrNull(fsApi, path.dirname(item.target))
					? "source_missing"
					: "destination_changed",
			);
			return;
		}
		if (!sameIdentity(target, evidence)) {
			markConflict(item, "destination_replaced");
			return;
		}

		item.state = "reverting";
		fsApi.linkSync(item.target, item.source);
		fault("after_revert_link_before_unlink", { itemId: item.id });
		fsApi.unlinkSync(item.target);
		item.state = "reverted";
		if (
			item.postMoveFingerprint &&
			(target.size !== item.postMoveFingerprint.size ||
				target.mtimeMs !== item.postMoveFingerprint.mtimeMs)
		)
			item.note = "modified_since_move";
	}

	function cleanFolder(item) {
		if (["removed", "remove_skipped"].includes(item.state)) return;
		if (item.state === "attempting") resolveAttempting(item);
		if (item.state === "exists" || item.existed || item.createdByUs === false) {
			item.state = "remove_skipped";
			return;
		}
		if (item.state !== "created") return;
		const found = statOrNull(fsApi, item.path);
		if (!found) {
			item.state = "removed";
			return;
		}
		if (!found.isDirectory() || fsApi.readdirSync(item.path).length > 0) {
			item.state = "remove_skipped";
			return;
		}
		fsApi.rmdirSync(item.path);
		item.state = "removed";
	}

	function rollback(batch) {
		batch.state = "rolling_back";
		batch.trigger = "recovery";
		persist(batch, "after_recovery_rollback_intent");
		for (const item of batch.items) {
			if (item.state === "attempting") resolveAttempting(item);
		}
		persist(batch, "after_recovery_probe");
		for (const item of [...batch.items].reverse()) {
			if (item.type !== "move") continue;
			reverseMove(item);
			persist(batch, "after_recovery_move");
		}
		for (const item of [...batch.items].reverse()) {
			if (item.type !== "folder") continue;
			cleanFolder(item);
			persist(batch, "after_recovery_folder");
		}
		batch.state = batch.items.some(
			(item) =>
				item.state === "revert_conflict" || item.reason === "IN_DOUBT_CONFLICT",
		)
			? "needs_attention"
			: "rolled_back";
		persist(batch, "after_recovery_terminal");
		return batch;
	}

	function recoverBatch(batch) {
		if (TERMINAL_BATCH_STATES.has(batch.state)) return batch;
		try {
			authorizer.resolveGrant(batch.grantId);
		} catch {
			batch.state = "needs_attention";
			batch.trigger = "recovery";
			batch.reason = "grant_unavailable";
			persist(batch, "after_recovery_unavailable");
			return batch;
		}
		if (batch.state === "prepared") {
			const hasEvidence = batch.items.some((item) => item.state !== "pending");
			if (!hasEvidence) {
				batch.state = "rolled_back";
				batch.trigger = "recovery";
				batch.note = "never_entered_applying";
				persist(batch, "after_recovery_abandon_prepared");
				return batch;
			}
			batch.state = "applying";
		}
		if (
			batch.state === "applying" &&
			batch.items.every((item) => SUCCESS_ITEM_STATES.has(item.state))
		) {
			batch.state = "applied";
			persist(batch, "after_recovery_roll_forward");
			return batch;
		}
		return rollback(batch);
	}

	function recoverAll() {
		const stored = journal.list();
		const recoveredCount = stored.filter(
			(batch) => !TERMINAL_BATCH_STATES.has(batch.state),
		).length;
		const batches = stored.map(recoverBatch);
		return {
			batches,
			recoveredCount,
			needsAttention: batches
				.filter((batch) => batch.state === "needs_attention")
				.map((batch) => batch.id),
		};
	}

	return { recoverAll, recoverBatch, readBatch: journal.read };
}

module.exports = { createCrashRecoveryEngine };
