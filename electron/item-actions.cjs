const {
	CapabilityAuthorizationError,
} = require("./capabilities/authorization.cjs");

function createItemActions({ shell, fsApi }) {
	function requireExistingCanonicalPath(authorization) {
		const canonicalPath = authorization.item.canonicalPath;
		try {
			fsApi.statSync(canonicalPath);
		} catch {
			throw new CapabilityAuthorizationError(
				"STALE_REFERENCE",
				"The filesystem reference is no longer available",
			);
		}
		return canonicalPath;
	}

	async function openItem(_input, { authorization }) {
		const canonicalPath = requireExistingCanonicalPath(authorization);
		const error = await shell.openPath(canonicalPath);
		return { opened: error === "" };
	}

	function revealItem(_input, { authorization }) {
		const canonicalPath = requireExistingCanonicalPath(authorization);
		shell.showItemInFolder(canonicalPath);
		return { revealed: true };
	}

	return { openItem, revealItem };
}

module.exports = { createItemActions };
