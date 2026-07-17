const fs = require("node:fs");
const path = require("node:path");

function isContained(parentDirectory, candidatePath) {
	const relative = path.relative(parentDirectory, candidatePath);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function assertContainedLocalPath(localDataDirectory, candidatePath) {
	const boundary = path.resolve(localDataDirectory);
	const candidate = path.resolve(candidatePath);
	if (
		!path.isAbsolute(localDataDirectory) ||
		!isContained(boundary, candidate)
	) {
		throw new Error(
			"Refusing to erase a path outside Untie's local-data directory.",
		);
	}
	return candidate;
}

function createLocalDataEraser({
	localDataDirectory,
	fsApi = fs,
	services = {},
}) {
	if (
		typeof localDataDirectory !== "string" ||
		!path.isAbsolute(localDataDirectory)
	) {
		throw new TypeError("localDataDirectory must be an absolute path");
	}
	const boundary = path.resolve(localDataDirectory);
	const storesDirectory = assertContainedLocalPath(
		boundary,
		services.storesDirectory || path.join(boundary, "stores"),
	);

	async function call(callback) {
		if (typeof callback === "function") await callback();
	}

	function removeContained(candidatePath) {
		const contained = assertContainedLocalPath(boundary, candidatePath);
		fsApi.rmSync(contained, { recursive: true, force: true });
	}

	async function eraseAll() {
		// Quiesce every producer before closing the database and removing its files.
		await call(services.stopFilesystemWatcher);
		await call(services.stopIndexSync);
		await call(services.stopExtractionWorkers);
		await call(services.closeFileIndex);

		removeContained(storesDirectory);

		await call(services.recreateStores);
		await call(services.clearOpaqueReferences);
		await call(services.clearRestoredGrants);
		return { erased: true };
	}

	return { eraseAll, removeContained };
}

module.exports = {
	assertContainedLocalPath,
	createLocalDataEraser,
};
