const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
	comparisonKey,
	destinationNameIssue,
} = require("./sort-plan-validator.cjs");

const JOURNAL_SCHEMA_VERSION = 1;
const BATCH_STATES = Object.freeze([
	"prepared",
	"applying",
	"applied",
	"rolling_back",
	"rolled_back",
	"needs_attention",
]);

class JournaledApplyError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "JournaledApplyError";
		this.code = code;
		if (options.batchId) this.batchId = options.batchId;
	}
}

class InjectedApplyCrash extends Error {
	constructor(point) {
		super(`Injected crash at ${point}`);
		this.name = "InjectedApplyCrash";
		this.point = point;
	}
}

function applyError(code, message, cause, batchId) {
	return new JournaledApplyError(code, message, {
		...(cause ? { cause } : {}),
		...(batchId ? { batchId } : {}),
	});
}

function fingerprint(stat, canonicalPath) {
	return {
		canonicalPath,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		dev: stat.dev,
		ino: stat.ino,
	};
}

function isSkipClass(name, stat) {
	const lower = name.toLocaleLowerCase("en-US");
	return (
		name.startsWith(".") ||
		stat.isSymbolicLink() ||
		[
			".app",
			".photoslibrary",
			".download",
			".part",
			".partial",
			".crdownload",
		].some((suffix) => lower.endsWith(suffix))
	);
}

function createJournalStore({
	directory,
	fsApi = fs,
	randomUUID: random = randomUUID,
}) {
	if (!directory) throw new TypeError("Journal directory is required");
	fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });

	function fileFor(batchId) {
		if (!/^batch_[0-9a-f]{32}$/.test(batchId))
			throw applyError("INVALID_BATCH_ID", "Journal batch ID is invalid");
		return path.join(directory, `${batchId}.json`);
	}

	function persist(batch) {
		const file = fileFor(batch.id);
		const temporary = path.join(directory, `.${batch.id}.${random()}.tmp`);
		let descriptor;
		try {
			descriptor = fsApi.openSync(temporary, "wx", 0o600);
			fsApi.writeFileSync(
				descriptor,
				`${JSON.stringify(batch, null, 2)}\n`,
				"utf8",
			);
			fsApi.fsyncSync(descriptor);
			fsApi.closeSync(descriptor);
			descriptor = undefined;
			fsApi.renameSync(temporary, file);
			const directoryDescriptor = fsApi.openSync(directory, "r");
			try {
				fsApi.fsyncSync(directoryDescriptor);
			} finally {
				fsApi.closeSync(directoryDescriptor);
			}
		} catch (cause) {
			if (descriptor !== undefined) fsApi.closeSync(descriptor);
			try {
				fsApi.rmSync(temporary, { force: true });
			} catch {}
			throw applyError(
				"JOURNAL_WRITE_FAILED",
				"Apply journal could not be saved",
				cause,
				batch.id,
			);
		}
		return batch;
	}

	function read(batchId) {
		try {
			const batch = JSON.parse(fsApi.readFileSync(fileFor(batchId), "utf8"));
			if (
				batch?.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
				!BATCH_STATES.includes(batch.state)
			)
				throw new Error("Invalid journal record");
			return batch;
		} catch (cause) {
			if (cause instanceof JournaledApplyError) throw cause;
			throw applyError(
				"JOURNAL_READ_FAILED",
				"Apply journal could not be read",
				cause,
				batchId,
			);
		}
	}

	return { persist, read };
}

function createJournaledApplyEngine({
	preparedPlanStore,
	authorizer,
	journalDirectory,
	fsApi = fs,
	now = Date.now,
	randomUUID: random = randomUUID,
	fault = () => {},
}) {
	if (!preparedPlanStore || !authorizer || !journalDirectory)
		throw new TypeError(
			"preparedPlanStore, authorizer, and journalDirectory are required",
		);
	const journal = createJournalStore({
		directory: journalDirectory,
		fsApi,
		randomUUID: random,
	});

	function crashPoint(point, context) {
		fault(point, context);
	}

	function failPreflight(code, message, cause, snapshotId) {
		preparedPlanStore.invalidate?.(snapshotId, code);
		throw applyError(code, message, cause);
	}

	function preflight(binding) {
		let snapshot;
		try {
			snapshot = preparedPlanStore.getApproved(binding);
		} catch (cause) {
			throw applyError(
				"APPROVED_SNAPSHOT_UNUSABLE",
				"Approved plan is no longer usable",
				cause,
			);
		}
		let resolvedGrant;
		try {
			resolvedGrant = authorizer.resolveGrant(snapshot.grantId);
		} catch (cause) {
			failPreflight(
				"GRANT_UNAVAILABLE",
				"The folder grant is unavailable",
				cause,
				snapshot.id,
			);
		}
		const grantPath = resolvedGrant.canonicalPath;
		let grantEntries;
		try {
			grantEntries = fsApi.readdirSync(grantPath);
			fsApi.accessSync(grantPath, fs.constants.R_OK | fs.constants.W_OK);
		} catch (cause) {
			failPreflight(
				"GRANT_UNWRITABLE",
				"The granted folder is not writable",
				cause,
				snapshot.id,
			);
		}
		const entryByKey = new Map(
			grantEntries.map((name) => [comparisonKey(name), name]),
		);
		const destinationByKey = new Map();
		for (const operation of snapshot.operations) {
			if (destinationNameIssue(operation.destination.name))
				failPreflight(
					"INVALID_DESTINATION",
					"A destination name is invalid",
					undefined,
					snapshot.id,
				);
			const key = comparisonKey(operation.destination.name);
			const actual = entryByKey.get(key);
			if (operation.destination.kind === "new" && actual !== undefined)
				failPreflight(
					"DESTINATION_CHANGED",
					"A new destination is no longer available",
					undefined,
					snapshot.id,
				);
			if (
				operation.destination.kind === "existing" &&
				actual !== operation.destination.name
			)
				failPreflight(
					"DESTINATION_CHANGED",
					"An existing destination changed",
					undefined,
					snapshot.id,
				);
			destinationByKey.set(key, operation.destination);
		}

		const folders = [];
		for (const destination of destinationByKey.values()) {
			const destinationPath = path.join(grantPath, destination.name);
			if (path.dirname(destinationPath) !== grantPath)
				failPreflight(
					"NOT_CONTAINED",
					"A destination escapes the grant",
					undefined,
					snapshot.id,
				);
			if (destination.kind === "existing") {
				let stat;
				let canonical;
				try {
					const lstat = fsApi.lstatSync(destinationPath);
					if (lstat.isSymbolicLink()) throw new Error("symlink destination");
					canonical = fsApi.realpathSync
						.native(destinationPath)
						.normalize("NFC");
					stat = fsApi.statSync(canonical);
				} catch (cause) {
					failPreflight(
						"DESTINATION_CHANGED",
						"An existing destination is unavailable",
						cause,
						snapshot.id,
					);
				}
				if (!stat.isDirectory() || path.dirname(canonical) !== grantPath)
					failPreflight(
						"NOT_CONTAINED",
						"A destination is not a real top-level folder",
						undefined,
						snapshot.id,
					);
				try {
					fsApi.accessSync(canonical, fs.constants.R_OK | fs.constants.W_OK);
				} catch (cause) {
					failPreflight(
						"DESTINATION_UNWRITABLE",
						"An existing destination is not writable",
						cause,
						snapshot.id,
					);
				}
				folders.push({
					type: "folder",
					id: `folder_${folders.length}`,
					path: canonical,
					state: "pending",
					existed: true,
				});
			} else {
				folders.push({
					type: "folder",
					id: `folder_${folders.length}`,
					path: destinationPath,
					state: "pending",
					existed: false,
				});
			}
		}

		const folderByKey = new Map(
			folders.map((item) => [comparisonKey(path.basename(item.path)), item]),
		);
		const moves = [];
		const sources = new Set();
		const targets = new Set();
		for (const operation of snapshot.operations) {
			let resolved;
			try {
				resolved = authorizer.resolveItem(operation.itemId, snapshot.grantId);
			} catch (cause) {
				failPreflight(
					"SOURCE_CHANGED",
					"A source file changed",
					cause,
					snapshot.id,
				);
			}
			const source = resolved.canonicalPath;
			let sourceStat;
			try {
				const lstat = fsApi.lstatSync(source);
				sourceStat = fsApi.statSync(source);
				if (!sourceStat.isFile() || isSkipClass(path.basename(source), lstat))
					throw new Error("skip class");
			} catch (cause) {
				failPreflight(
					"SOURCE_CHANGED",
					"A source is not an eligible regular file",
					cause,
					snapshot.id,
				);
			}
			if (path.dirname(source) !== grantPath)
				failPreflight(
					"NOT_CONTAINED",
					"A source is not a top-level granted file",
					undefined,
					snapshot.id,
				);
			const folder = folderByKey.get(comparisonKey(operation.destination.name));
			const target = path.join(folder.path, path.basename(source));
			const targetKey = `${comparisonKey(folder.path)}\0${comparisonKey(path.basename(source))}`;
			if (sources.has(source) || targets.has(targetKey))
				failPreflight(
					"DUPLICATE_OPERATION",
					"The plan contains duplicate operations",
					undefined,
					snapshot.id,
				);
			sources.add(source);
			targets.add(targetKey);
			if (folder.existed) {
				const entries = fsApi.readdirSync(folder.path);
				if (
					entries.some(
						(name) =>
							comparisonKey(name) === comparisonKey(path.basename(source)),
					)
				)
					failPreflight(
						"TARGET_EXISTS",
						"A move target already exists",
						undefined,
						snapshot.id,
					);
			}
			if (
				sourceStat.dev !==
				fsApi.statSync(folder.existed ? folder.path : grantPath).dev
			)
				failPreflight(
					"CROSS_VOLUME",
					"A move would cross filesystem volumes",
					undefined,
					snapshot.id,
				);
			moves.push({
				type: "move",
				id: `move_${moves.length}`,
				itemId: operation.itemId,
				source,
				target,
				sourceFingerprint: fingerprint(sourceStat, source),
				state: "pending",
			});
		}
		return { snapshot, items: [...folders, ...moves] };
	}

	function exclusiveMove(source, target) {
		fsApi.linkSync(source, target);
		crashPoint("after_move_link_before_unlink", {
			source,
			target,
			type: "move",
		});
		fsApi.unlinkSync(source);
	}

	function pathExists(candidate) {
		try {
			fsApi.lstatSync(candidate);
			return true;
		} catch (cause) {
			if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return false;
			throw cause;
		}
	}

	function sameIdentity(stat, expected) {
		return stat.dev === expected?.dev && stat.ino === expected?.ino;
	}

	function sameContentFingerprint(stat, expected) {
		return stat.size === expected?.size && stat.mtimeMs === expected?.mtimeMs;
	}

	function validateUndoBoundary(batch) {
		let grant;
		try {
			grant = authorizer.resolveGrant(batch.grantId).canonicalPath;
			fsApi.accessSync(grant, fs.constants.R_OK | fs.constants.W_OK);
		} catch (cause) {
			throw applyError(
				"UNDO_UNAVAILABLE",
				"The folder grant is unavailable for undo",
				cause,
				batch.id,
			);
		}
		for (const item of batch.items) {
			const candidates =
				item.type === "move" ? [item.source, item.target] : [item.path];
			for (const candidate of candidates) {
				if (
					typeof candidate !== "string" ||
					!path.isAbsolute(candidate) ||
					path.relative(grant, candidate) === ".." ||
					path.relative(grant, candidate).startsWith(`..${path.sep}`) ||
					path.isAbsolute(path.relative(grant, candidate))
				)
					throw applyError(
						"UNDO_UNAVAILABLE",
						"A journal item is outside the folder grant",
						undefined,
						batch.id,
					);
				const parent = path.dirname(candidate);
				if (pathExists(parent)) {
					let canonicalParent;
					try {
						canonicalParent = fsApi.realpathSync
							.native(parent)
							.normalize("NFC");
					} catch (cause) {
						throw applyError(
							"UNDO_UNAVAILABLE",
							"An undo path is unavailable",
							cause,
							batch.id,
						);
					}
					if (
						canonicalParent !== grant &&
						path.dirname(canonicalParent) !== grant
					)
						throw applyError(
							"UNDO_UNAVAILABLE",
							"An undo path escaped the folder grant",
							undefined,
							batch.id,
						);
				}
			}
		}
	}

	function markUndoFailure(item, reason) {
		item.state = "revert_conflict";
		item.undoOutcome =
			reason === "source_missing" ? "already_moved_away" : "conflict";
		item.reason = reason;
	}

	function undo(batchId) {
		const batch = journal.read(batchId);
		if (batch.state !== "applied")
			throw applyError(
				"UNDO_NOT_AVAILABLE",
				"This operation is not available to undo",
				undefined,
				batch.id,
			);
		// This is deliberately a complete read-only authorization pass. No journal
		// transition or filesystem mutation is allowed when the grant is unavailable.
		try {
			validateUndoBoundary(batch);
		} catch {
			batch.state = "needs_attention";
			batch.trigger = "user_undo";
			batch.reason = "unavailable";
			batch.updatedAt = now();
			journal.persist(batch);
			return {
				batchId: batch.id,
				state: batch.state,
				outcome: "unavailable",
				files: [],
				folders: [],
			};
		}
		batch.state = "rolling_back";
		batch.trigger = "user_undo";
		batch.updatedAt = now();
		journal.persist(batch);
		crashPoint("after_undo_started", { batchId: batch.id });

		const moveOutcomes = [];
		for (const item of [...batch.items].reverse()) {
			if (item.type !== "move" || item.state !== "moved") continue;
			item.state = "reverting";
			batch.updatedAt = now();
			journal.persist(batch);
			crashPoint("after_revert_intent", {
				batchId: batch.id,
				itemId: item.id,
				type: "move",
			});
			try {
				if (!pathExists(item.target)) {
					const targetParentExists = pathExists(path.dirname(item.target));
					markUndoFailure(
						item,
						targetParentExists ? "source_missing" : "destination_changed",
					);
				} else if (pathExists(item.source)) {
					markUndoFailure(item, "origin_occupied");
				} else {
					const targetLstat = fsApi.lstatSync(item.target);
					const targetStat = fsApi.statSync(item.target);
					if (
						targetLstat.isSymbolicLink() ||
						!targetStat.isFile() ||
						!sameIdentity(targetStat, item.postMoveFingerprint)
					) {
						markUndoFailure(item, "destination_replaced");
					} else {
						const modified = !sameContentFingerprint(
							targetStat,
							item.postMoveFingerprint,
						);
						fsApi.linkSync(item.target, item.source);
						crashPoint("after_revert_link_before_unlink", {
							batchId: batch.id,
							itemId: item.id,
							type: "move",
						});
						fsApi.unlinkSync(item.target);
						item.state = "reverted";
						item.undoOutcome = modified ? "restored_modified" : "restored";
						if (modified) item.reason = "modified_since_move";
					}
				}
			} catch (cause) {
				if (cause instanceof InjectedApplyCrash) throw cause;
				markUndoFailure(
					item,
					cause?.code === "EEXIST" ? "origin_occupied" : "filesystem_error",
				);
			}
			batch.updatedAt = now();
			journal.persist(batch);
			moveOutcomes.push({
				itemId: item.itemId,
				outcome: item.undoOutcome,
				reason: item.reason,
			});
			crashPoint("after_revert_result", {
				batchId: batch.id,
				itemId: item.id,
				type: "move",
			});
		}

		const folderOutcomes = [];
		for (const item of [...batch.items].reverse()) {
			if (item.type !== "folder" || !["created", "exists"].includes(item.state))
				continue;
			if (!item.createdByUs) {
				item.state = "remove_skipped";
				item.undoOutcome = "pre_existing";
			} else {
				item.state = "attempting";
				batch.updatedAt = now();
				journal.persist(batch);
				crashPoint("after_folder_remove_intent", {
					batchId: batch.id,
					itemId: item.id,
					type: "folder",
				});
				try {
					fsApi.rmdirSync(item.path);
					item.state = "removed";
					item.undoOutcome = "removed";
				} catch (cause) {
					if (cause instanceof InjectedApplyCrash) throw cause;
					item.state = "remove_skipped";
					item.undoOutcome =
						cause?.code === "ENOTEMPTY" || cause?.code === "EEXIST"
							? "non_empty"
							: "unavailable";
				}
			}
			batch.updatedAt = now();
			journal.persist(batch);
			folderOutcomes.push({ folderId: item.id, outcome: item.undoOutcome });
		}

		const partial = batch.items.some(
			(item) => item.type === "move" && item.state === "revert_conflict",
		);
		batch.state = partial ? "needs_attention" : "rolled_back";
		batch.updatedAt = now();
		journal.persist(batch);
		crashPoint("after_undo_finished", { batchId: batch.id });
		return {
			batchId: batch.id,
			state: batch.state,
			outcome: partial ? "partial" : "complete",
			files: moveOutcomes,
			folders: folderOutcomes,
		};
	}

	function apply(binding) {
		crashPoint("before_preflight", {});
		const { snapshot, items } = preflight(binding);
		crashPoint("after_preflight", { snapshotId: snapshot.id });
		const batch = {
			schemaVersion: JOURNAL_SCHEMA_VERSION,
			id: `batch_${random().replaceAll("-", "")}`,
			snapshotId: snapshot.id,
			snapshotFingerprint: snapshot.fingerprint,
			grantId: snapshot.grantId,
			state: "prepared",
			trigger: null,
			createdAt: now(),
			updatedAt: now(),
			items,
		};
		journal.persist(batch);
		crashPoint("after_prepared", { batchId: batch.id });
		batch.state = "applying";
		batch.updatedAt = now();
		journal.persist(batch);

		for (const item of batch.items) {
			item.state = "attempting";
			batch.updatedAt = now();
			journal.persist(batch);
			crashPoint("after_intent", {
				batchId: batch.id,
				itemId: item.id,
				type: item.type,
			});
			try {
				if (item.type === "folder") {
					if (!item.existed) fsApi.mkdirSync(item.path, { mode: 0o700 });
					crashPoint("after_mutation_before_result", {
						batchId: batch.id,
						itemId: item.id,
						type: item.type,
					});
					item.state = item.existed ? "exists" : "created";
					item.createdByUs = !item.existed;
				} else {
					exclusiveMove(item.source, item.target);
					crashPoint("after_mutation_before_result", {
						batchId: batch.id,
						itemId: item.id,
						type: item.type,
					});
					const stat = fsApi.statSync(item.target);
					item.postMoveFingerprint = fingerprint(stat, item.target);
					item.state = "moved";
				}
				batch.updatedAt = now();
				journal.persist(batch);
				crashPoint("after_result", {
					batchId: batch.id,
					itemId: item.id,
					type: item.type,
				});
			} catch (cause) {
				if (cause instanceof InjectedApplyCrash) throw cause;
				item.state = "failed";
				item.reason = cause?.code || "FILESYSTEM_ERROR";
				batch.state = "rolling_back";
				batch.trigger = "auto_failure";
				batch.updatedAt = now();
				journal.persist(batch);
				throw applyError(
					"APPLY_FAILED",
					"Apply failed and requires durable rollback",
					cause,
					batch.id,
				);
			}
		}
		crashPoint("after_last_result", { batchId: batch.id });
		batch.state = "applied";
		batch.updatedAt = now();
		journal.persist(batch);
		crashPoint("after_applied", { batchId: batch.id });
		return { batchId: batch.id, state: batch.state };
	}

	return { apply, undo, readBatch: journal.read, preflight };
}

module.exports = {
	BATCH_STATES,
	InjectedApplyCrash,
	JOURNAL_SCHEMA_VERSION,
	JournaledApplyError,
	createJournalStore,
	createJournaledApplyEngine,
};
