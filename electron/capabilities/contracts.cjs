const capabilityNames = Object.freeze([
	"ping",
	"cancellableDelay",
	"selectFolder",
	"listFolderGrants",
	"revokeFolderGrant",
	"scanFolder",
	"queryIndex",
	"preparePlan",
	"applyPlan",
	"undo",
	"revealItem",
	"openItem",
	"listChatSessions",
	"loadChatSession",
	"saveChatSession",
	"deleteChatSession",
	"deleteAllChatData",
]);

const errorCodes = Object.freeze([
	"INVALID_REQUEST",
	"INVALID_RESPONSE",
	"CANCELLED",
	"NOT_IMPLEMENTED",
	"INTERNAL",
	"UNKNOWN_CAPABILITY",
	"UNAUTHORIZED",
	"REVOKED_GRANT",
	"STALE_REFERENCE",
	"NOT_CONTAINED",
	"PATH_SUPPLIED",
]);

function validationError(message) {
	return { ok: false, message };
}

function valid(value) {
	return { ok: true, value };
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return validationError(`${label} must be an object`);
	}
	return valid(value);
}

function exactKeys(value, keys, label) {
	const checked = object(value, label);
	if (!checked.ok) return checked;
	const unexpected = Object.keys(value).find((key) => !keys.includes(key));
	return unexpected
		? validationError(`${label} contains unexpected field '${unexpected}'`)
		: checked;
}

function emptyObject(value) {
	const checked = exactKeys(value, [], "request");
	return checked.ok ? valid({}) : checked;
}

function opaqueIdRequest(field) {
	return (value) => {
		const checked = exactKeys(value, [field], "request");
		if (!checked.ok) return checked;
		if (typeof value[field] !== "string" || value[field].length === 0) {
			return validationError(`${field} must be a non-empty opaque ID`);
		}
		return valid({ [field]: value[field] });
	};
}

function exactFields(fields, label) {
	return (value) => {
		const checked = exactKeys(value, Object.keys(fields), label);
		if (!checked.ok) return checked;
		for (const [field, validate] of Object.entries(fields)) {
			if (!validate(value[field])) {
				return validationError(`${label}.${field} has an invalid value`);
			}
		}
		return valid(value);
	};
}

const exactResponse = (fields) => exactFields(fields, "response");

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
const boolean = (value) => typeof value === "boolean";
const nullableString = (value) => value === null || nonEmptyString(value);
const stringArray = (value) =>
	Array.isArray(value) && value.every((item) => nonEmptyString(item));
const scanNamedEntries = (value) =>
	Array.isArray(value) &&
	value.every((entry) => exactResponse({ name: nonEmptyString })(entry).ok);
const scanSkipReasons = Object.freeze([
	"HIDDEN",
	"SYMLINK_OR_ALIAS",
	"PACKAGE_BUNDLE",
	"TEMPORARY_DOWNLOAD",
	"APP_DATA",
	"UNSUPPORTED_TYPE",
]);
const scanSkippedEntries = (value) =>
	Array.isArray(value) &&
	value.every(
		(entry) =>
			exactResponse({
				name: nonEmptyString,
				reason: (reason) => scanSkipReasons.includes(reason),
			})(entry).ok,
	);

// Chat persistence (P2). A session id is a path-free opaque token; the pattern
// mirrors CHAT_SESSION_ID_PATTERN in chat-store.cjs (kept independent so this
// module stays free of the fs-backed store in the sandboxed preload).
const CHAT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CHAT_MESSAGE_KINDS = Object.freeze([
	"user",
	"pending",
	"progress",
	"plan",
	"result",
	"undo",
	"failed",
]);
const MAX_CHAT_MESSAGES = 5000;

const timestamp = (value) => Number.isInteger(value) && value >= 0;
const chatSessionId = (value) =>
	typeof value === "string" && CHAT_SESSION_ID_PATTERN.test(value);

// Messages are validated structurally, not exhaustively: every entry must be a
// plain object carrying the shared base fields with a known kind. Kind-specific
// fields are owned by the renderer message model and the store, so extra keys
// are allowed here on purpose.
const chatMessage = (value) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	nonEmptyString(value.id) &&
	CHAT_MESSAGE_KINDS.includes(value.kind) &&
	Number.isInteger(value.createdAt);
const chatMessages = (value) =>
	Array.isArray(value) &&
	value.length <= MAX_CHAT_MESSAGES &&
	value.every(chatMessage);

const chatSessionValue = (value) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	chatSessionId(value.id) &&
	typeof value.title === "string" &&
	timestamp(value.createdAt) &&
	timestamp(value.updatedAt) &&
	chatMessages(value.messages);
const nullableChatSession = (value) =>
	value === null || chatSessionValue(value);

const chatSummary = (value) =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	chatSessionId(value.id) &&
	typeof value.title === "string" &&
	timestamp(value.createdAt) &&
	timestamp(value.updatedAt) &&
	Number.isInteger(value.messageCount) &&
	value.messageCount >= 0;
const chatSummaries = (value) =>
	Array.isArray(value) && value.every(chatSummary);

// A request addressing one session by opaque id. Stricter than opaqueIdRequest:
// the id must also be path-free per CHAT_SESSION_ID_PATTERN.
function opaqueChatSessionRequest(value) {
	const checked = exactKeys(value, ["sessionId"], "request");
	if (!checked.ok) return checked;
	if (!chatSessionId(value.sessionId)) {
		return validationError("sessionId must be a safe opaque chat id");
	}
	return valid({ sessionId: value.sessionId });
}

const contracts = Object.freeze({
	ping: {
		request: exactFields({ message: nonEmptyString }, "request"),
		response: exactResponse({ message: nonEmptyString }),
	},
	cancellableDelay: {
		request(value) {
			const checked = exactKeys(value, ["milliseconds"], "request");
			if (!checked.ok) return checked;
			if (
				!Number.isInteger(value.milliseconds) ||
				value.milliseconds < 0 ||
				value.milliseconds > 30_000
			) {
				return validationError(
					"milliseconds must be an integer from 0 to 30000",
				);
			}
			return valid({ milliseconds: value.milliseconds });
		},
		response: exactResponse({ completed: boolean }),
	},
	selectFolder: {
		request: emptyObject,
		response: exactResponse({ grantId: nullableString }),
	},
	listFolderGrants: {
		request: emptyObject,
		response: exactResponse({
			grants: (value) =>
				Array.isArray(value) &&
				value.every(
					(grant) =>
						exactResponse({
							grantId: nonEmptyString,
							state: (state) =>
								["active", "missing", "moved", "revoked"].includes(state),
							createdAt: timestamp,
						})(grant).ok,
				),
		}),
	},
	revokeFolderGrant: {
		request: opaqueIdRequest("grantId"),
		response: exactResponse({ revoked: boolean }),
	},
	scanFolder: {
		request: opaqueIdRequest("grantId"),
		response: exactResponse({
			files: scanNamedEntries,
			candidateDestinations: scanNamedEntries,
			skipped: scanSkippedEntries,
		}),
	},
	queryIndex: {
		request(value) {
			const checked = exactKeys(value, ["query", "limit"], "request");
			if (!checked.ok) return checked;
			if (typeof value.query !== "string" || value.query.length === 0) {
				return validationError("query must be a non-empty string");
			}
			if (
				value.limit !== undefined &&
				(!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)
			) {
				return validationError("limit must be an integer from 1 to 100");
			}
			return valid({ query: value.query, limit: value.limit });
		},
		response: exactResponse({ itemIds: stringArray }),
	},
	preparePlan: {
		request(value) {
			const checked = exactKeys(value, ["grantId", "operations"], "request");
			if (!checked.ok) return checked;
			if (typeof value.grantId !== "string" || value.grantId.length === 0) {
				return validationError("grantId must be a non-empty opaque ID");
			}
			if (!Array.isArray(value.operations)) {
				return validationError("operations must be an array");
			}
			for (const operation of value.operations) {
				const operationCheck = exactKeys(
					operation,
					["itemId", "destination"],
					"operation",
				);
				if (!operationCheck.ok) return operationCheck;
				if (
					typeof operation.itemId !== "string" ||
					operation.itemId.length === 0
				) {
					return validationError(
						"operation.itemId must be a non-empty opaque ID",
					);
				}
				const destinationCheck = exactKeys(
					operation.destination,
					["existingFolderId", "newFolderName"],
					"operation.destination",
				);
				if (!destinationCheck.ok) return destinationCheck;
				const values = [
					operation.destination.existingFolderId,
					operation.destination.newFolderName,
				].filter((candidate) => candidate !== undefined);
				if (
					values.length !== 1 ||
					typeof values[0] !== "string" ||
					values[0].length === 0
				) {
					return validationError(
						"destination needs exactly one opaque folder ID or new folder name",
					);
				}
			}
			return valid({ grantId: value.grantId, operations: value.operations });
		},
		response: exactResponse({ planId: nonEmptyString }),
	},
	applyPlan: {
		request: opaqueIdRequest("planId"),
		response: exactResponse({ operationId: nonEmptyString }),
	},
	undo: {
		request: opaqueIdRequest("operationId"),
		response: exactResponse({ undone: boolean }),
	},
	revealItem: {
		request: opaqueIdRequest("itemId"),
		response: exactResponse({ revealed: boolean }),
	},
	openItem: {
		request: opaqueIdRequest("itemId"),
		response: exactResponse({ opened: boolean }),
	},
	listChatSessions: {
		request: emptyObject,
		response: exactResponse({ sessions: chatSummaries }),
	},
	loadChatSession: {
		request: opaqueChatSessionRequest,
		response: exactResponse({ session: nullableChatSession }),
	},
	saveChatSession: {
		request(value) {
			const checked = exactKeys(value, ["session"], "request");
			if (!checked.ok) return checked;
			const session = value.session;
			const sessionCheck = exactKeys(
				session,
				["id", "createdAt", "messages"],
				"session",
			);
			if (!sessionCheck.ok) return sessionCheck;
			if (!chatSessionId(session.id)) {
				return validationError("session.id must be a safe opaque chat id");
			}
			if (!timestamp(session.createdAt)) {
				return validationError(
					"session.createdAt must be a non-negative integer",
				);
			}
			if (!chatMessages(session.messages)) {
				return validationError(
					"session.messages must be structured chat messages",
				);
			}
			return valid({
				session: {
					id: session.id,
					createdAt: session.createdAt,
					messages: session.messages,
				},
			});
		},
		response: exactResponse({ session: chatSessionValue }),
	},
	deleteChatSession: {
		request: opaqueChatSessionRequest,
		response: exactResponse({ deleted: boolean }),
	},
	deleteAllChatData: {
		request: emptyObject,
		response: exactResponse({ deletedCount: (value) => timestamp(value) }),
	},
});

module.exports = { capabilityNames, contracts, errorCodes };
