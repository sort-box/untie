const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { validateSortPlan } = require("./sort-plan-validator.cjs");

const PREPARED_PLAN_SCHEMA_VERSION = 1;
const DEFAULT_PREPARED_PLAN_TTL_MS = 15 * 60 * 1000;
const SNAPSHOT_ID_PATTERN = /^plan_[0-9a-f]{32}$/;

class PreparedPlanError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "PreparedPlanError";
		this.code = code;
	}
}

function fail(code, message, cause) {
	return new PreparedPlanError(code, message, cause ? { cause } : undefined);
}

function newSnapshotId(random = randomUUID) {
	return `plan_${random().replaceAll("-", "")}`;
}

function canonicalJson(value) {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new TypeError("Prepared plan values must be JSON-serializable");
}

function immutableCopy(value) {
	const copy = JSON.parse(canonicalJson(value));
	function freeze(current) {
		if (current && typeof current === "object") {
			for (const child of Object.values(current)) freeze(child);
			Object.freeze(current);
		}
		return current;
	}
	return freeze(copy);
}

function fingerprint(content) {
	return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function assertSnapshotIntegrity(snapshot) {
	const { id, fingerprint: stored, ...content } = snapshot;
	if (fingerprint(content) !== stored)
		throw fail("STORE_CORRUPT", "Prepared plan snapshot is corrupt");
}

function createPreparedPlanStore({
	directory,
	authorizer,
	now = Date.now,
	ttlMs = DEFAULT_PREPARED_PLAN_TTL_MS,
	randomUUID: random = randomUUID,
}) {
	if (!directory || !authorizer)
		throw new TypeError("directory and authorizer are required");
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
		throw new TypeError("Prepared plan TTL must be a positive integer");

	const file = path.join(directory, "prepared-plans.json");
	let document = { schemaVersion: PREPARED_PLAN_SCHEMA_VERSION, snapshots: [] };

	function load() {
		let raw;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch (cause) {
			if (cause?.code === "ENOENT") return;
			throw fail("STORE_UNREADABLE", "Prepared plans could not be read", cause);
		}
		if (raw.trim() === "") return;
		try {
			const parsed = JSON.parse(raw);
			if (
				parsed?.schemaVersion !== PREPARED_PLAN_SCHEMA_VERSION ||
				!Array.isArray(parsed.snapshots)
			)
				throw new Error("Invalid prepared plan document");
			for (const { snapshot } of parsed.snapshots)
				assertSnapshotIntegrity(snapshot);
			document = parsed;
		} catch (cause) {
			throw fail("STORE_CORRUPT", "Prepared plans are corrupt", cause);
		}
	}

	function persist(nextDocument) {
		const temporary = path.join(
			directory,
			`.prepared-plans.tmp-${randomUUID()}`,
		);
		try {
			fs.writeFileSync(
				temporary,
				`${JSON.stringify(nextDocument, null, 2)}\n`,
				{
					encoding: "utf8",
					mode: 0o600,
				},
			);
			fs.renameSync(temporary, file);
			document = nextDocument;
		} catch (cause) {
			fs.rmSync(temporary, { force: true });
			throw fail(
				"STORE_WRITE_FAILED",
				"Prepared plans could not be saved",
				cause,
			);
		}
	}

	function find(snapshotId) {
		const record = document.snapshots.find(
			({ snapshot }) => snapshot.id === snapshotId,
		);
		if (!record)
			throw fail("SNAPSHOT_NOT_FOUND", "Prepared plan snapshot was not found");
		return record;
	}

	function assertUsable(record, expectedFingerprint) {
		const { snapshot } = record;
		assertSnapshotIntegrity(snapshot);
		if (expectedFingerprint !== snapshot.fingerprint)
			throw fail(
				"BINDING_MISMATCH",
				"Approval does not match this prepared plan snapshot",
			);
		if (record.status === "superseded")
			throw fail(
				"SUPERSEDED",
				"Prepared plan was replaced by an edited snapshot",
			);
		if (snapshot.expiresAt <= now())
			throw fail("EXPIRED", "Prepared plan snapshot expired");
		try {
			const grant = authorizer.resolveGrant(snapshot.grantId);
			if (grant.grant.revision !== snapshot.grantRevision)
				throw fail("GRANT_CHANGED", "The backing folder grant changed");
			for (const itemId of snapshot.referencedItemIds)
				authorizer.resolveItem(itemId, snapshot.grantId);
		} catch (cause) {
			if (cause instanceof PreparedPlanError) throw cause;
			if (
				["REVOKED_GRANT", "STALE_REFERENCE", "NOT_CONTAINED"].includes(
					cause?.code,
				)
			)
				throw fail("GRANT_CHANGED", "The backing folder grant changed", cause);
			throw fail("SOURCE_CHANGED", "A referenced source file changed", cause);
		}
		return snapshot;
	}

	function buildSnapshot({
		grantId,
		plan,
		validationContext,
		disclosureManifest,
		exclusions = [],
	}) {
		const validationResult = validateSortPlan(plan, validationContext);
		if (!validationResult.ok)
			throw fail("PLAN_NOT_VALIDATED", "The sort plan did not pass validation");
		if (
			!Array.isArray(exclusions) ||
			exclusions.some((id) => typeof id !== "string")
		)
			throw fail("INVALID_EXCLUSIONS", "Exclusions must be opaque file IDs");
		const operations = immutableCopy(validationResult.operations);
		const excluded = [...new Set(exclusions)];
		if (excluded.length !== exclusions.length)
			throw fail("INVALID_EXCLUSIONS", "Exclusions must be unique");
		const moved = new Set(operations.map(({ itemId }) => itemId));
		if (excluded.some((itemId) => moved.has(itemId)))
			throw fail("INVALID_EXCLUSIONS", "A file cannot be moved and excluded");

		const resolvedGrant = authorizer.resolveGrant(grantId);
		const referencedItemIds = [...moved, ...excluded];
		for (const itemId of referencedItemIds)
			authorizer.resolveItem(itemId, grantId);
		const createdDestinations = new Set(
			operations
				.filter(({ destination }) => destination.kind === "new")
				.map(({ destination }) => destination.name),
		);
		const createdAt = now();
		const content = immutableCopy({
			schemaVersion: PREPARED_PLAN_SCHEMA_VERSION,
			grantId,
			grantRevision: resolvedGrant.grant.revision,
			operations,
			operationCounts: {
				createFolder: createdDestinations.size,
				move: operations.length,
			},
			disclosureManifest: disclosureManifest ?? null,
			exclusions: excluded,
			referencedItemIds,
			createdAt,
			expiresAt: createdAt + ttlMs,
		});
		return immutableCopy({
			id: newSnapshotId(random),
			...content,
			fingerprint: fingerprint(content),
		});
	}

	function prepare(input) {
		const snapshot = buildSnapshot(input);
		persist({
			...document,
			snapshots: [...document.snapshots, { snapshot, status: "prepared" }],
		});
		return snapshot;
	}

	function replace(snapshotId, input) {
		const prior = find(snapshotId);
		if (prior.status === "superseded")
			throw fail("SUPERSEDED", "Prepared plan was already replaced");
		const snapshot = buildSnapshot(input);
		const snapshots = document.snapshots.map((record) =>
			record === prior
				? { ...record, status: "superseded", supersededBy: snapshot.id }
				: record,
		);
		persist({
			...document,
			snapshots: [...snapshots, { snapshot, status: "prepared" }],
		});
		return snapshot;
	}

	function approve({ snapshotId, fingerprint: expectedFingerprint }) {
		const record = find(snapshotId);
		const snapshot = assertUsable(record, expectedFingerprint);
		if (record.status !== "approved") {
			persist({
				...document,
				snapshots: document.snapshots.map((entry) =>
					entry === record
						? { ...entry, status: "approved", approvedAt: now() }
						: entry,
				),
			});
		}
		return immutableCopy({ snapshotId, fingerprint: snapshot.fingerprint });
	}

	function getApproved(binding) {
		const record = find(binding.snapshotId);
		if (record.status !== "approved")
			throw fail("NOT_APPROVED", "Prepared plan is not approved");
		return assertUsable(record, binding.fingerprint);
	}

	load();
	return { prepare, replace, approve, getApproved };
}

module.exports = {
	DEFAULT_PREPARED_PLAN_TTL_MS,
	PREPARED_PLAN_SCHEMA_VERSION,
	SNAPSHOT_ID_PATTERN,
	PreparedPlanError,
	canonicalJson,
	createPreparedPlanStore,
	fingerprint,
	newSnapshotId,
};
