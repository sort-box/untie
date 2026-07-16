function createGrantLifecycle({ watcher, referenceStore, indexSync }) {
	function handleStateChange(grant) {
		// The grant reference is changed before this callback. From this point on,
		// authorization is fail-closed even if a derived-data cleanup throws.
		watcher.reconcileGrant(grant);
		if (grant.state === "active") return;

		// Unavailable content must not remain searchable. Shared files survive when
		// another active grant still owns an index membership.
		indexSync.removeGrant(grant.grantId);
		if (grant.state === "revoked")
			referenceStore.invalidateGrant(grant.grantId);
	}

	return { handleStateChange };
}

module.exports = { createGrantLifecycle };
