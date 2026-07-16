const fs = require("node:fs");

function createFilesystemWatcher({
	authorizer,
	indexSync,
	onCoalescedChange,
	fsApi = fs,
	debounceMs = 100,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
}) {
	const watched = new Map();

	function stop(grantId) {
		const entry = watched.get(grantId);
		if (!entry) return false;
		watched.delete(grantId);
		if (entry.timer !== undefined) clearTimer(entry.timer);
		entry.watcher.close();
		return true;
	}

	function loseCompleteness(grantId) {
		indexSync.markStale(grantId);
		stop(grantId);
	}

	function rootStillExists(entry) {
		try {
			const stat = fsApi.lstatSync(entry.canonicalPath);
			return stat.isDirectory() && !stat.isSymbolicLink();
		} catch {
			return false;
		}
	}

	function schedule(grantId) {
		const entry = watched.get(grantId);
		if (!entry) return;
		if (!rootStillExists(entry)) {
			loseCompleteness(grantId);
			return;
		}
		// A watcher event proves the previous scan is no longer current, but it
		// cannot prove which changes occurred. Only a subsequent full sync may
		// restore freshness.
		indexSync.markStale(grantId);
		if (entry.timer !== undefined) clearTimer(entry.timer);
		entry.timer = setTimer(() => {
			const current = watched.get(grantId);
			if (!current) return;
			current.timer = undefined;
			onCoalescedChange?.({ grantId });
		}, debounceMs);
	}

	function watchGrant(grantId) {
		if (watched.has(grantId)) return false;
		const authorization = authorizer.resolveGrant(grantId);
		const canonicalPath = authorization.canonicalPath;
		let watcher;
		try {
			watcher = fsApi.watch(canonicalPath, () => schedule(grantId));
		} catch {
			indexSync.markStale(grantId);
			return false;
		}
		const entry = { canonicalPath, timer: undefined, watcher };
		watched.set(grantId, entry);
		watcher.on("error", () => loseCompleteness(grantId));
		return true;
	}

	function reconcileGrant({ grantId, state }) {
		if (state === "active") watchGrant(grantId);
		else stop(grantId);
	}

	function close() {
		for (const grantId of [...watched.keys()]) stop(grantId);
	}

	return {
		close,
		isWatching: (grantId) => watched.has(grantId),
		reconcileGrant,
		stop,
		watchGrant,
	};
}

module.exports = { createFilesystemWatcher };
