const fs = require("node:fs");
const path = require("node:path");

const AUTHORIZATION_ERROR_CODES = Object.freeze([
	"UNAUTHORIZED",
	"REVOKED_GRANT",
	"STALE_REFERENCE",
	"NOT_CONTAINED",
	"PATH_SUPPLIED",
	"EXPIRED_ID",
	"INVALIDATED_ID",
]);

class CapabilityAuthorizationError extends Error {
	constructor(code, message, details) {
		super(message);
		this.name = "CapabilityAuthorizationError";
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

function authorizationError(code, message, details) {
	return new CapabilityAuthorizationError(code, message, details);
}

function looksLikePath(value) {
	return (
		typeof value === "string" &&
		(path.isAbsolute(value) ||
			value.includes("/") ||
			value.includes("\\") ||
			value.startsWith("file:"))
	);
}

function containsRendererPath(value, key = "") {
	if (key.toLowerCase().includes("path")) return true;
	if (Array.isArray(value))
		return value.some((entry) => containsRendererPath(entry));
	if (value && typeof value === "object") {
		return Object.entries(value).some(([entryKey, entry]) =>
			containsRendererPath(entry, entryKey),
		);
	}
	return key.toLowerCase().endsWith("id") && looksLikePath(value);
}

function canonicalizePath(candidate, fsApi = fs) {
	if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
		throw authorizationError(
			"UNAUTHORIZED",
			"Trusted store contained a non-absolute filesystem reference",
		);
	}
	try {
		// realpath.native collapses dot segments and resolves every symlink in the
		// existing path. NFC gives stable comparisons across common APFS Unicode
		// representations; realpath supplies the filesystem's actual casing.
		return fsApi.realpathSync.native(path.resolve(candidate)).normalize("NFC");
	} catch {
		throw authorizationError(
			"STALE_REFERENCE",
			"The filesystem reference is no longer available",
		);
	}
}

function isContained(grantPath, targetPath) {
	const relative = path.relative(grantPath, targetPath);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function identityFor(canonicalPath, fsApi = fs) {
	try {
		const stat = fsApi.statSync(canonicalPath);
		return Object.freeze({ dev: stat.dev, ino: stat.ino });
	} catch {
		throw authorizationError(
			"STALE_REFERENCE",
			"The filesystem reference changed during authorization",
		);
	}
}

class CapabilityReferenceStore {
	#grants = new Map();
	#items = new Map();

	setGrant(grant) {
		let boundary = {};
		if (grant.status === "active") {
			const canonicalPath = canonicalizePath(grant.path);
			boundary = { canonicalPath, identity: identityFor(canonicalPath) };
		}
		this.#grants.set(grant.id, Object.freeze({ ...grant, ...boundary }));
	}

	setItem(item) {
		this.#items.set(item.id, Object.freeze({ ...item }));
	}

	getGrant(grantId) {
		return this.#grants.get(grantId);
	}

	getItem(itemId) {
		return this.#items.get(itemId);
	}
}

function createCapabilityAuthorizer({ store, fsApi = fs, now = Date.now }) {
	function resolveGrant(grantId) {
		if (looksLikePath(grantId)) {
			throw authorizationError(
				"PATH_SUPPLIED",
				"Filesystem paths are not capabilities",
			);
		}
		const grant = store.getGrant(grantId);
		if (!grant || grant.status === "revoked") {
			throw authorizationError(
				"REVOKED_GRANT",
				"The backing folder grant is missing or revoked",
			);
		}
		if (
			grant.status !== "active" ||
			(grant.expiresAt !== undefined && grant.expiresAt <= now())
		) {
			throw authorizationError("STALE_REFERENCE", "The folder grant is stale");
		}
		const canonicalPath = canonicalizePath(grant.path, fsApi);
		const identity = identityFor(canonicalPath, fsApi);
		if (
			grant.canonicalPath !== undefined &&
			(grant.canonicalPath !== canonicalPath ||
				grant.identity.dev !== identity.dev ||
				grant.identity.ino !== identity.ino)
		) {
			throw authorizationError(
				"STALE_REFERENCE",
				"The granted folder changed after it was authorized",
			);
		}
		return {
			grant,
			canonicalPath,
			identity,
		};
	}

	function resolveItem(itemId, expectedGrantId) {
		if (looksLikePath(itemId)) {
			throw authorizationError(
				"PATH_SUPPLIED",
				"Filesystem paths are not capabilities",
			);
		}
		const item = store.getItem(itemId);
		if (!item) {
			throw authorizationError("UNAUTHORIZED", "The opaque item is unknown");
		}
		if (item.status === "invalidated") {
			throw authorizationError(
				"INVALIDATED_ID",
				"The opaque item was invalidated",
			);
		}
		if (item.expiresAt !== undefined && item.expiresAt <= now()) {
			throw authorizationError("EXPIRED_ID", "The opaque item expired");
		}
		const resolvedGrant = resolveGrant(item.grantId);
		if (expectedGrantId !== undefined && item.grantId !== expectedGrantId) {
			throw authorizationError(
				"UNAUTHORIZED",
				"The item belongs to another grant",
			);
		}
		if (item.grantRevision !== resolvedGrant.grant.revision) {
			throw authorizationError("STALE_REFERENCE", "The opaque item is stale");
		}
		let canonicalPath;
		try {
			canonicalPath = canonicalizePath(item.path, fsApi);
		} catch (error) {
			if (item.snapshot !== undefined) {
				throw authorizationError(
					"INVALIDATED_ID",
					"The opaque item's source changed",
				);
			}
			throw error;
		}
		if (!isContained(resolvedGrant.canonicalPath, canonicalPath)) {
			throw authorizationError(
				"NOT_CONTAINED",
				"The item resolves outside its granted folder",
			);
		}
		const identity = identityFor(canonicalPath, fsApi);
		if (item.snapshot !== undefined) {
			let stat;
			try {
				stat = fsApi.statSync(canonicalPath);
			} catch {
				throw authorizationError(
					"INVALIDATED_ID",
					"The opaque item's source changed",
				);
			}
			if (
				item.snapshot.canonicalPath !== canonicalPath ||
				item.snapshot.size !== stat.size ||
				item.snapshot.mtimeMs !== stat.mtimeMs ||
				item.snapshot.dev !== identity.dev ||
				item.snapshot.ino !== identity.ino
			) {
				throw authorizationError(
					"INVALIDATED_ID",
					"The opaque item's source changed",
				);
			}
		}
		return Object.freeze({
			itemId,
			grantId: item.grantId,
			canonicalPath,
			identity,
			grant: resolvedGrant,
		});
	}

	function authorize(capability, input) {
		if (containsRendererPath(input)) {
			throw authorizationError(
				"PATH_SUPPLIED",
				"Filesystem paths are not capabilities",
			);
		}
		switch (capability) {
			case "scanFolder":
			case "classifyFolderRisk":
				return Object.freeze({ grant: resolveGrant(input.grantId) });
			case "preparePlan":
				return Object.freeze({
					grant: resolveGrant(input.grantId),
					items: Object.freeze(
						input.operations.map(({ itemId, destination }) => ({
							item: resolveItem(itemId, input.grantId),
							destination:
								destination.existingFolderId === undefined
									? undefined
									: resolveItem(destination.existingFolderId, input.grantId),
						})),
					),
				});
			case "openItem":
			case "revealItem":
				return Object.freeze({ item: resolveItem(input.itemId) });
			default:
				return Object.freeze({});
		}
	}

	return { authorize, resolveGrant, resolveItem };
}

module.exports = {
	AUTHORIZATION_ERROR_CODES,
	CapabilityAuthorizationError,
	CapabilityReferenceStore,
	canonicalizePath,
	containsRendererPath,
	createCapabilityAuthorizer,
	isContained,
	looksLikePath,
};
