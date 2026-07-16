const STARTUP_STATUSES = Object.freeze([
	"recovered",
	"needs_attention",
	"blocked",
]);

function blocked(reason, detail) {
	return {
		status: "blocked",
		reasons: [reason],
		recoveredBatchCount: 0,
		needsAttentionCount: 0,
		...(detail ? { detail } : {}),
	};
}

async function runStartupGate({
	initializeStores,
	restoreGrants,
	recoverJournals,
	checkAuth,
	checkOnboarding,
}) {
	let stores;
	try {
		stores = await initializeStores();
	} catch (error) {
		return blocked("migration_failure", {
			code: error?.code || "STORE_STARTUP_FAILED",
			store: error?.store || "unknown",
		});
	}
	let grants;
	try {
		grants = await restoreGrants(stores);
	} catch (error) {
		return blocked("grant_restore_failure", {
			code: error?.code || "GRANT_RESTORE_FAILED",
		});
	}
	let recovery;
	try {
		recovery = await recoverJournals({ stores, grants });
	} catch (error) {
		return blocked("journal_recovery_failure", {
			code: error?.code || "RECOVERY_FAILED",
		});
	}
	const auth = await checkAuth();
	const onboarding = await checkOnboarding({ stores, grants });
	const unavailableGrantCount = grants.filter(
		(grant) => grant.state !== "active" && grant.state !== "revoked",
	).length;
	const reasons = [];
	if (recovery.needsAttention.length > 0)
		reasons.push("journal_needs_attention");
	if (unavailableGrantCount > 0) reasons.push("unavailable_grant");
	if (auth === "expired") reasons.push("expired_auth");
	else if (auth === "unauthorized") reasons.push("unauthorized_auth");
	if (onboarding === "interrupted") reasons.push("interrupted_onboarding");
	const isBlocked = reasons.some((reason) =>
		["expired_auth", "unauthorized_auth", "interrupted_onboarding"].includes(
			reason,
		),
	);
	return {
		status: isBlocked
			? "blocked"
			: reasons.length > 0
				? "needs_attention"
				: "recovered",
		reasons,
		recoveredBatchCount: recovery.recoveredCount,
		needsAttentionCount: recovery.needsAttention.length + unavailableGrantCount,
	};
}

module.exports = { STARTUP_STATUSES, runStartupGate };
