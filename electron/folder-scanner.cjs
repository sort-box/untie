const fs = require("node:fs");
const path = require("node:path");

const SCAN_SKIP_REASONS = Object.freeze([
	"HIDDEN",
	"SYMLINK_OR_ALIAS",
	"PACKAGE_BUNDLE",
	"TEMPORARY_DOWNLOAD",
	"APP_DATA",
	"UNSUPPORTED_TYPE",
]);

const PACKAGE_EXTENSIONS = new Set([
	".app",
	".bundle",
	".framework",
	".key",
	".numbers",
	".pages",
	".photoslibrary",
	".pkg",
	".playground",
	".plugin",
	".rtfd",
	".xcodeproj",
	".xcworkspace",
]);

const TEMPORARY_SUFFIXES = [
	".crdownload",
	".download",
	".filepart",
	".opdownload",
	".partial",
	".part",
	".tmp",
];

class FolderScanCancelledError extends Error {
	constructor() {
		super("Folder scan was cancelled");
		this.name = "FolderScanCancelledError";
		this.code = "CANCELLED";
	}
}

function throwIfCancelled(signal) {
	if (signal?.aborted) throw new FolderScanCancelledError();
}

function normalizedExtension(name) {
	return path.extname(name).normalize("NFC").toLocaleLowerCase("en-US");
}

function isPackageBundle(name) {
	return PACKAGE_EXTENSIONS.has(normalizedExtension(name));
}

function isTemporaryDownload(name) {
	// Temp/partial-download markers are trailing suffixes (e.g. ".crdownload",
	// ".part"). Match only the final suffix so legitimately-named files that
	// merely embed the token (e.g. "draft.part.docx") are not over-skipped.
	const lower = name.normalize("NFC").toLocaleLowerCase("en-US");
	return TEMPORARY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isInside(candidate, boundary) {
	const relative = path.relative(boundary, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function createFolderScanner({ appDataDirectory, fsApi = fs }) {
	const canonicalAppData = fsApi.realpathSync.native(appDataDirectory);

	async function scanFolder(canonicalFolderPath, { signal } = {}) {
		throwIfCancelled(signal);
		const scanRoot = await fsApi.promises.realpath(canonicalFolderPath);
		throwIfCancelled(signal);
		const files = [];
		const candidateDestinations = [];
		const skipped = [];
		const directory = await fsApi.promises.opendir(scanRoot);

		try {
			for await (const entry of directory) {
				throwIfCancelled(signal);
				const name = entry.name.normalize("NFC");
				const entryPath = path.join(scanRoot, entry.name);
				let reason;

				if (name.startsWith(".")) reason = "HIDDEN";
				else if (entry.isSymbolicLink()) reason = "SYMLINK_OR_ALIAS";
				else if (isPackageBundle(name)) reason = "PACKAGE_BUNDLE";
				else if (isTemporaryDownload(name)) reason = "TEMPORARY_DOWNLOAD";
				else {
					const resolvedEntry = path.resolve(entryPath);
					if (isInside(resolvedEntry, canonicalAppData)) {
						reason = "APP_DATA";
					}
				}

				if (reason) skipped.push({ name, reason });
				else if (entry.isFile()) {
					const stat = await fsApi.promises.stat(entryPath);
					files.push({ name, size: stat.size });
				} else if (entry.isDirectory()) candidateDestinations.push({ name });
				else skipped.push({ name, reason: "UNSUPPORTED_TYPE" });
			}
		} finally {
			await directory.close().catch(() => {});
		}

		throwIfCancelled(signal);
		const byName = (left, right) =>
			left.name.localeCompare(right.name, "en-US");
		files.sort(byName);
		candidateDestinations.sort(byName);
		skipped.sort(byName);
		return { files, candidateDestinations, skipped };
	}

	return { scanFolder };
}

module.exports = {
	FolderScanCancelledError,
	SCAN_SKIP_REASONS,
	createFolderScanner,
	isPackageBundle,
	isTemporaryDownload,
};
