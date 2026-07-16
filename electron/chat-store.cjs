const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { privacyLogger } = require("../privacy-log.cjs");

// Local chat persistence (P2). Chat sessions live as one JSON document per
// session inside the W1 `chat` store's `history/` directory. Each document
// carries its own `schemaVersion` so a session written by an older build can be
// migrated forward the first time it is read — independent of the W1 store
// container versioning in local-store.cjs, which owns the directory layout.
//
// The renderer never sees a filesystem path: it addresses sessions by opaque id
// through the typed capability IPC surface. This module resolves those ids to
// files inside a single history directory and refuses anything that is not a
// safe, path-free token.

const CHAT_SCHEMA_VERSION = 2;

// A session id must be a path-free opaque token. Mirrors the identical guard in
// capabilities/contracts.cjs (kept independent so the sandboxed preload never
// has to require this fs-backed module).
const CHAT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Per-document migrations. Each entry upgrades a session from version N to N+1.
const CHAT_MIGRATIONS = Object.freeze({
	// v1 → v2: the earliest builds stored only `{ id, createdAt, messages }` and
	// derived the chat title and last-activity time at render time. v2 persists
	// both so the recent-chats list can be rendered without loading every
	// message of every chat.
	1: (session) => ({
		...session,
		title:
			typeof session.title === "string" && session.title.length > 0
				? session.title
				: deriveTitle(session.messages),
		updatedAt: Number.isInteger(session.updatedAt)
			? session.updatedAt
			: latestTimestamp(
					session.messages,
					Number.isInteger(session.createdAt) ? session.createdAt : 0,
				),
	}),
});

class ChatStoreError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "ChatStoreError";
		this.code = code;
	}
}

function chatError(code, message, cause) {
	return new ChatStoreError(code, message, cause ? { cause } : undefined);
}

function assertSafeId(id) {
	if (typeof id !== "string" || !CHAT_SESSION_ID_PATTERN.test(id)) {
		throw chatError("CHAT_INVALID_ID", "The chat session id is not a safe id.");
	}
}

function firstUserText(messages) {
	if (!Array.isArray(messages)) return undefined;
	for (const message of messages) {
		if (
			message &&
			typeof message === "object" &&
			message.kind === "user" &&
			typeof message.text === "string"
		) {
			return message.text;
		}
	}
	return undefined;
}

function deriveTitle(messages) {
	const text = firstUserText(messages);
	if (typeof text !== "string") return "New chat";
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return "New chat";
	return normalized.length > 60 ? `${normalized.slice(0, 59)}…` : normalized;
}

function latestTimestamp(messages, fallback) {
	let latest = fallback;
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (
				message &&
				typeof message === "object" &&
				Number.isInteger(message.createdAt) &&
				message.createdAt > latest
			) {
				latest = message.createdAt;
			}
		}
	}
	return latest;
}

// Build the full on-disk document from the renderer's write payload. Title and
// last-activity time are derived here so the store is the single source of truth
// for that metadata (the v1 → v2 migration reuses the same derivation).
function buildStoredSession(input) {
	const createdAt = Number.isInteger(input.createdAt)
		? input.createdAt
		: Date.now();
	const messages = Array.isArray(input.messages) ? input.messages : [];
	return {
		schemaVersion: CHAT_SCHEMA_VERSION,
		id: input.id,
		title: deriveTitle(messages),
		createdAt,
		updatedAt: latestTimestamp(messages, createdAt),
		messages,
	};
}

// Strip the on-disk-only `schemaVersion` before it crosses the capability
// boundary; version is an internal storage concern, not part of the API shape.
function toApiSession(stored) {
	return {
		id: stored.id,
		title: stored.title,
		createdAt: stored.createdAt,
		updatedAt: stored.updatedAt,
		messages: stored.messages,
	};
}

function toSummary(stored) {
	return {
		id: stored.id,
		title: stored.title,
		createdAt: stored.createdAt,
		updatedAt: stored.updatedAt,
		messageCount: Array.isArray(stored.messages) ? stored.messages.length : 0,
	};
}

function migrateSession(raw, id) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw chatError(
			"CHAT_SESSION_CORRUPT",
			`Chat session ${id} is not a JSON object.`,
		);
	}
	let version = Number.isSafeInteger(raw.schemaVersion) ? raw.schemaVersion : 1;
	if (version < 1) {
		throw chatError(
			"CHAT_SESSION_CORRUPT",
			`Chat session ${id} has an invalid schema version.`,
		);
	}
	if (version > CHAT_SCHEMA_VERSION) {
		throw chatError(
			"CHAT_VERSION_UNSUPPORTED",
			`Chat session ${id} was written by a newer version of Untie.`,
		);
	}
	let session = raw;
	while (version < CHAT_SCHEMA_VERSION) {
		const migrate = CHAT_MIGRATIONS[version];
		if (typeof migrate !== "function") {
			throw chatError(
				"CHAT_MIGRATION_FAILED",
				`Missing chat migration from version ${version}.`,
			);
		}
		session = migrate(session);
		version += 1;
	}
	// The filename is authoritative for the id, never the (untrusted) payload.
	return { ...session, schemaVersion: CHAT_SCHEMA_VERSION, id };
}

function sessionFilePath(directory, id) {
	return path.join(directory, `${id}.json`);
}

// Atomic replace: write a uniquely-named temp file, then rename over the target
// so a crash mid-write can never leave a partially written session behind. The
// temp name is dotted and non-".json" so it is ignored by listing and cleanup.
function writeSessionFile(directory, session) {
	const target = sessionFilePath(directory, session.id);
	const temp = path.join(directory, `.${session.id}.tmp-${randomUUID()}`);
	try {
		fs.writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		fs.renameSync(temp, target);
	} catch (cause) {
		fs.rmSync(temp, { force: true });
		throw chatError(
			"CHAT_WRITE_FAILED",
			`Chat session ${session.id} could not be saved.`,
			cause,
		);
	}
}

function readSessionFile(directory, id) {
	let raw;
	try {
		raw = fs.readFileSync(sessionFilePath(directory, id), "utf8");
	} catch (cause) {
		if (cause && cause.code === "ENOENT") return null;
		throw chatError(
			"CHAT_SESSION_UNREADABLE",
			`Chat session ${id} could not be read.`,
			cause,
		);
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw chatError(
			"CHAT_SESSION_CORRUPT",
			`Chat session ${id} is corrupt.`,
			cause,
		);
	}

	const onDiskVersion =
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		Number.isSafeInteger(parsed.schemaVersion)
			? parsed.schemaVersion
			: 1;
	const session = migrateSession(parsed, id);
	// Persist the upgrade once so a session is only ever migrated a single time.
	if (onDiskVersion < CHAT_SCHEMA_VERSION) writeSessionFile(directory, session);
	return session;
}

function createChatStore(directory) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

	function readIds() {
		let entries;
		try {
			entries = fs.readdirSync(directory);
		} catch (cause) {
			if (cause && cause.code === "ENOENT") return [];
			throw chatError(
				"CHAT_STORE_UNREADABLE",
				"The chat history directory could not be read.",
				cause,
			);
		}
		const ids = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const id = entry.slice(0, -".json".length);
			if (CHAT_SESSION_ID_PATTERN.test(id)) ids.push(id);
		}
		return ids;
	}

	function listSessions() {
		const summaries = [];
		for (const id of readIds()) {
			try {
				const session = readSessionFile(directory, id);
				if (session) summaries.push(toSummary(session));
			} catch (error) {
				// A single corrupt or unreadable chat must not hide every other one.
				privacyLogger.reportCrash("chat_session_read_failed", error);
			}
		}
		summaries.sort(
			(a, b) =>
				b.updatedAt - a.updatedAt ||
				b.createdAt - a.createdAt ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		return { sessions: summaries };
	}

	function loadSession(sessionId) {
		assertSafeId(sessionId);
		const session = readSessionFile(directory, sessionId);
		return { session: session ? toApiSession(session) : null };
	}

	function saveSession(input) {
		assertSafeId(input.id);
		const stored = buildStoredSession(input);
		writeSessionFile(directory, stored);
		return { session: toApiSession(stored) };
	}

	function deleteSession(sessionId) {
		assertSafeId(sessionId);
		try {
			fs.rmSync(sessionFilePath(directory, sessionId), { force: false });
			return { deleted: true };
		} catch (cause) {
			if (cause && cause.code === "ENOENT") return { deleted: false };
			throw chatError(
				"CHAT_DELETE_FAILED",
				`Chat session ${sessionId} could not be deleted.`,
				cause,
			);
		}
	}

	function deleteAll() {
		let deletedCount = 0;
		for (const id of readIds()) {
			fs.rmSync(sessionFilePath(directory, id), { force: true });
			deletedCount += 1;
		}
		return { deletedCount };
	}

	return {
		directory,
		schemaVersion: CHAT_SCHEMA_VERSION,
		listSessions,
		loadSession,
		saveSession,
		deleteSession,
		deleteAll,
	};
}

module.exports = {
	CHAT_MIGRATIONS,
	CHAT_SCHEMA_VERSION,
	CHAT_SESSION_ID_PATTERN,
	ChatStoreError,
	createChatStore,
};
