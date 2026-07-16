const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MANIFEST_FILE = "store.json";
const STORE_DEFINITIONS = Object.freeze({
	db: Object.freeze({ version: 1, entries: ["index.sqlite"] }),
	journal: Object.freeze({ version: 1, entries: ["operations"] }),
	chat: Object.freeze({ version: 2, entries: ["history", "attachments"] }),
});

const STORE_MIGRATIONS = Object.freeze({
	chat: Object.freeze({
		1: (directory) => {
			fs.mkdirSync(path.join(directory, "attachments"), { mode: 0o700 });
		},
	}),
});

class LocalStoreError extends Error {
	constructor(code, store, message, options = {}) {
		super(message, options);
		this.name = "LocalStoreError";
		this.code = code;
		this.store = store;
	}

	toJSON() {
		return {
			name: this.name,
			code: this.code,
			store: this.store,
			message: this.message,
		};
	}
}

function storeError(code, store, message, cause) {
	return new LocalStoreError(
		code,
		store,
		message,
		cause ? { cause } : undefined,
	);
}

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
}

function createStore(directory, store, definition) {
	const staging = `${directory}.initializing-${randomUUID()}`;
	try {
		fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
		for (const entry of definition.entries) {
			const entryPath = path.join(staging, entry);
			if (path.extname(entry)) {
				fs.writeFileSync(entryPath, "", { flag: "wx", mode: 0o600 });
			} else {
				fs.mkdirSync(entryPath, { mode: 0o700 });
			}
		}
		writeJson(path.join(staging, MANIFEST_FILE), {
			store,
			version: definition.version,
		});
		fs.renameSync(staging, directory);
	} catch (cause) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw storeError(
			"STORE_INITIALIZATION_FAILED",
			store,
			`Could not initialize the ${store} store.`,
			cause,
		);
	}
}

function readManifest(directory, store) {
	let raw;
	try {
		raw = fs.readFileSync(path.join(directory, MANIFEST_FILE), "utf8");
	} catch (cause) {
		throw storeError(
			"STORE_UNREADABLE",
			store,
			`The ${store} store manifest is unreadable.`,
			cause,
		);
	}

	let manifest;
	try {
		manifest = JSON.parse(raw);
	} catch (cause) {
		throw storeError(
			"STORE_CORRUPT",
			store,
			`The ${store} store manifest is corrupt.`,
			cause,
		);
	}

	if (
		manifest === null ||
		typeof manifest !== "object" ||
		manifest.store !== store ||
		!Number.isSafeInteger(manifest.version) ||
		manifest.version < 1
	) {
		throw storeError(
			"STORE_CORRUPT",
			store,
			`The ${store} store manifest is invalid.`,
		);
	}
	return manifest;
}

function migrateStore(directory, store, fromVersion, definition, migrations) {
	const staging = `${directory}.migrating-${randomUUID()}`;
	const backup = `${directory}.backup-${randomUUID()}`;
	try {
		fs.cpSync(directory, staging, { recursive: true, errorOnExist: true });
		let version = fromVersion;
		while (version < definition.version) {
			const migrate = migrations[store]?.[version];
			if (typeof migrate !== "function") {
				throw new Error(`Missing migration from version ${version}.`);
			}
			migrate(staging);
			version += 1;
			fs.writeFileSync(
				path.join(staging, MANIFEST_FILE),
				`${JSON.stringify({ store, version }, null, 2)}\n`,
				"utf8",
			);
		}

		fs.renameSync(directory, backup);
		try {
			fs.renameSync(staging, directory);
		} catch (cause) {
			fs.renameSync(backup, directory);
			throw cause;
		}
		try {
			fs.rmSync(backup, { recursive: true, force: true });
		} catch {
			// A stale backup is safer than turning successful migration into data loss.
		}
	} catch (cause) {
		try {
			fs.rmSync(staging, { recursive: true, force: true });
		} catch {
			// Cleanup failure must not hide the migration error or touch the original.
		}
		try {
			if (fs.existsSync(backup) && !fs.existsSync(directory))
				fs.renameSync(backup, directory);
		} catch (restoreCause) {
			throw storeError(
				"STORE_RECOVERY_FAILED",
				store,
				`The ${store} store migration failed and its backup could not be restored.`,
				new AggregateError([cause, restoreCause]),
			);
		}
		throw storeError(
			"STORE_MIGRATION_FAILED",
			store,
			`The ${store} store could not be migrated.`,
			cause,
		);
	}
}

function removeQuietly(targetPath) {
	try {
		fs.rmSync(targetPath, { recursive: true, force: true });
	} catch {
		// A stale sibling directory is harmless; never fail init over cleanup.
	}
}

function findStoreLeftovers(rootDirectory, store) {
	let entries;
	try {
		entries = fs.readdirSync(rootDirectory);
	} catch {
		return { backups: [], stagings: [], initializing: [] };
	}
	const backups = [];
	const stagings = [];
	const initializing = [];
	for (const entry of entries) {
		const full = path.join(rootDirectory, entry);
		if (entry.startsWith(`${store}.backup-`)) backups.push(full);
		else if (entry.startsWith(`${store}.migrating-`)) stagings.push(full);
		else if (entry.startsWith(`${store}.initializing-`))
			initializing.push(full);
	}
	return { backups, stagings, initializing };
}

// Recover from a crash during createStore/migrateStore. The migration swap
// (rename directory -> backup, then rename staging -> directory) is not atomic:
// a crash between the two renames leaves `directory` absent with a full backup
// beside it. Without reconciliation, openStore would treat the store as new and
// silently create an empty one, orphaning real user data. Reconcile instead
// restores the known-good backup (or fails loudly) and never resets on its own.
function reconcileStore(rootDirectory, store, directory) {
	const { backups, stagings, initializing } = findStoreLeftovers(
		rootDirectory,
		store,
	);

	if (fs.existsSync(directory)) {
		// The store is present and authoritative: leftovers are from a swap or
		// initialization whose cleanup was interrupted. Discard them; never touch
		// `directory`.
		for (const leftover of [...backups, ...stagings, ...initializing])
			removeQuietly(leftover);
		return;
	}

	// `directory` is absent. A single backup means an interrupted migration swap;
	// restore the pre-migration data and let the migration re-run on next open.
	if (backups.length === 1) {
		try {
			fs.renameSync(backups[0], directory);
		} catch (cause) {
			throw storeError(
				"STORE_RECOVERY_FAILED",
				store,
				`The ${store} store is missing and its backup could not be restored.`,
				cause,
			);
		}
		for (const leftover of [...stagings, ...initializing])
			removeQuietly(leftover);
		return;
	}
	if (backups.length > 1) {
		throw storeError(
			"STORE_RECOVERY_FAILED",
			store,
			`The ${store} store is missing and has multiple recovery backups; manual attention is required.`,
		);
	}

	// No backup. An orphaned staging with no live store cannot be reconstructed
	// safely (its source is gone) — fail loudly rather than guess or reset.
	if (stagings.length > 0) {
		throw storeError(
			"STORE_RECOVERY_FAILED",
			store,
			`The ${store} store is missing with an incomplete migration and no backup; manual attention is required.`,
		);
	}

	// Only an interrupted first-time initialization can remain: no committed data
	// ever existed, so it is safe to discard and create the store fresh below.
	for (const leftover of initializing) removeQuietly(leftover);
}

function openStore(rootDirectory, store, definition, migrations) {
	const directory = path.join(rootDirectory, store);
	reconcileStore(rootDirectory, store, directory);
	if (!fs.existsSync(directory)) {
		createStore(directory, store, definition);
		return { directory, version: definition.version };
	}

	let stat;
	try {
		stat = fs.statSync(directory);
	} catch (cause) {
		throw storeError(
			"STORE_UNREADABLE",
			store,
			`The ${store} store is unreadable.`,
			cause,
		);
	}
	if (!stat.isDirectory())
		throw storeError(
			"STORE_CORRUPT",
			store,
			`The ${store} store path is not a directory.`,
		);

	const manifest = readManifest(directory, store);
	if (manifest.version > definition.version) {
		throw storeError(
			"STORE_VERSION_UNSUPPORTED",
			store,
			`The ${store} store was created by a newer version of Untie.`,
		);
	}
	if (manifest.version < definition.version) {
		migrateStore(directory, store, manifest.version, definition, migrations);
	}
	return { directory, version: definition.version };
}

function initializeLocalStores(appDataDirectory, options = {}) {
	const definitions = options.definitions || STORE_DEFINITIONS;
	const migrations = options.migrations || STORE_MIGRATIONS;
	try {
		fs.mkdirSync(appDataDirectory, { recursive: true, mode: 0o700 });
		const stat = fs.statSync(appDataDirectory);
		if (!stat.isDirectory())
			throw new Error("App data path is not a directory.");
		fs.accessSync(appDataDirectory, fs.constants.R_OK | fs.constants.W_OK);
	} catch (cause) {
		throw storeError(
			"APP_DATA_UNAVAILABLE",
			"root",
			"Untie's app data directory is unavailable.",
			cause,
		);
	}

	const stores = {};
	for (const [store, definition] of Object.entries(definitions)) {
		stores[store] = openStore(appDataDirectory, store, definition, migrations);
	}
	return { rootDirectory: appDataDirectory, stores };
}

module.exports = {
	LocalStoreError,
	STORE_DEFINITIONS,
	STORE_MIGRATIONS,
	initializeLocalStores,
};
