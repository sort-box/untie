const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
	CapabilityAuthorizationError,
	canonicalizePath,
} = require("./capabilities/authorization.cjs");

const GRANT_ID_PATTERN = /^grant_[0-9a-f]{32}$/;
const GRANT_STATES = Object.freeze(["active", "missing", "moved", "revoked"]);

class GrantStoreError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "GrantStoreError";
		this.code = code;
	}
}

function fail(code, message, cause) {
	return new GrantStoreError(code, message, cause ? { cause } : undefined);
}

function validateGrant(grant) {
	if (
		!grant ||
		typeof grant !== "object" ||
		!GRANT_ID_PATTERN.test(grant.id) ||
		!path.isAbsolute(grant.path) ||
		!Number.isSafeInteger(grant.identity?.dev) ||
		!Number.isSafeInteger(grant.identity?.ino) ||
		!Number.isSafeInteger(grant.createdAt) ||
		!Number.isSafeInteger(grant.revision) ||
		!GRANT_STATES.includes(grant.state)
	) {
		throw fail("GRANT_STORE_CORRUPT", "The folder grants store is corrupt.");
	}
	return Object.freeze({
		...grant,
		identity: Object.freeze({ ...grant.identity }),
	});
}

function createGrantStore(directory) {
	const file = path.join(directory, "grants.json");
	let grants = new Map();

	function load() {
		let raw;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch (cause) {
			if (cause?.code === "ENOENT") raw = "";
			else
				throw fail(
					"GRANT_STORE_UNREADABLE",
					"Folder grants could not be read.",
					cause,
				);
		}
		if (raw.trim() === "") {
			grants = new Map();
			return;
		}
		let document;
		try {
			document = JSON.parse(raw);
		} catch (cause) {
			throw fail(
				"GRANT_STORE_CORRUPT",
				"The folder grants store is corrupt.",
				cause,
			);
		}
		if (
			!document ||
			typeof document !== "object" ||
			!Array.isArray(document.grants)
		) {
			throw fail("GRANT_STORE_CORRUPT", "The folder grants store is corrupt.");
		}
		grants = new Map(
			document.grants.map((grant) => {
				const checked = validateGrant(grant);
				return [checked.id, checked];
			}),
		);
	}

	function persist() {
		const temporary = path.join(directory, `.grants.tmp-${randomUUID()}`);
		try {
			fs.writeFileSync(
				temporary,
				`${JSON.stringify({ grants: [...grants.values()] }, null, 2)}\n`,
				{
					encoding: "utf8",
					mode: 0o600,
				},
			);
			fs.renameSync(temporary, file);
		} catch (cause) {
			fs.rmSync(temporary, { force: true });
			throw fail(
				"GRANT_STORE_WRITE_FAILED",
				"Folder grants could not be saved.",
				cause,
			);
		}
	}

	function put(grant) {
		const checked = validateGrant(grant);
		grants.set(checked.id, checked);
		persist();
		return checked;
	}

	load();
	return {
		list: () => [...grants.values()],
		get: (id) => grants.get(id),
		put,
	};
}

function newGrantId(random = randomUUID) {
	return `grant_${random().replaceAll("-", "")}`;
}

function publicGrant(grant) {
	return { grantId: grant.id, state: grant.state, createdAt: grant.createdAt };
}

function createFolderGrantService({
	store,
	referenceStore,
	showOpenDialog,
	fsApi = fs,
	now = Date.now,
	randomUUID: random = randomUUID,
}) {
	function referenceStatus(state) {
		if (state === "active") return "active";
		if (state === "revoked") return "revoked";
		return "stale";
	}

	function installReference(grant) {
		referenceStore.setGrant({
			id: grant.id,
			path: grant.path,
			status: referenceStatus(grant.state),
			revision: grant.revision,
		});
	}

	function check(grant) {
		if (grant.state === "revoked") return grant;
		let canonical;
		let stat;
		try {
			// Preserve TCC/permission denial as a distinct state. W3 deliberately
			// coarsens realpath failures for capability callers.
			fsApi.accessSync(grant.path, fs.constants.R_OK);
			canonical = canonicalizePath(grant.path, fsApi);
			stat = fsApi.statSync(canonical);
		} catch (error) {
			const state =
				error instanceof CapabilityAuthorizationError ||
				error?.code === "ENOENT" ||
				error?.code === "ENOTDIR"
					? "missing"
					: "revoked";
			return { ...grant, state };
		}
		if (
			canonical !== grant.path ||
			stat.dev !== grant.identity.dev ||
			stat.ino !== grant.identity.ino
		) {
			return { ...grant, state: "moved" };
		}
		return { ...grant, state: "active" };
	}

	function restore() {
		const restored = [];
		for (const saved of store.list()) {
			const checked = check(saved);
			if (checked.state !== saved.state) store.put(checked);
			installReference(checked);
			restored.push(publicGrant(checked));
		}
		return restored;
	}

	async function selectFolder() {
		const result = await showOpenDialog({ properties: ["openDirectory"] });
		if (result.canceled || result.filePaths.length === 0)
			return { grantId: null };
		const canonicalPath = canonicalizePath(result.filePaths[0], fsApi);
		const stat = fsApi.statSync(canonicalPath);
		fsApi.accessSync(canonicalPath, fs.constants.R_OK);
		const existing = store
			.list()
			.find(
				(grant) =>
					grant.state !== "revoked" &&
					grant.identity.dev === stat.dev &&
					grant.identity.ino === stat.ino,
			);
		const grant = existing ?? {
			id: newGrantId(random),
			path: canonicalPath,
			identity: { dev: stat.dev, ino: stat.ino },
			createdAt: now(),
			revision: 1,
			state: "active",
		};
		const active = { ...grant, path: canonicalPath, state: "active" };
		store.put(active);
		installReference(active);
		return { grantId: active.id };
	}

	function listGrants() {
		return { grants: restore() };
	}

	function revokeGrant({ grantId }) {
		const grant = store.get(grantId);
		if (!grant || grant.state === "revoked") return { revoked: false };
		const revoked = {
			...grant,
			state: "revoked",
			revision: grant.revision + 1,
		};
		store.put(revoked);
		installReference(revoked);
		return { revoked: true };
	}

	return { restore, selectFolder, listGrants, revokeGrant };
}

module.exports = {
	GRANT_ID_PATTERN,
	GrantStoreError,
	createFolderGrantService,
	createGrantStore,
};
