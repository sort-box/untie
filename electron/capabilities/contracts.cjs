const capabilityNames = Object.freeze([
	"ping",
	"cancellableDelay",
	"selectFolder",
	"scanFolder",
	"queryIndex",
	"preparePlan",
	"applyPlan",
	"undo",
	"revealItem",
	"openItem",
]);

const errorCodes = Object.freeze([
	"INVALID_REQUEST",
	"INVALID_RESPONSE",
	"CANCELLED",
	"NOT_IMPLEMENTED",
	"INTERNAL",
	"UNKNOWN_CAPABILITY",
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
const stringArray = (value) =>
	Array.isArray(value) && value.every((item) => nonEmptyString(item));

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
		response: exactResponse({ grantId: nonEmptyString }),
	},
	scanFolder: {
		request: opaqueIdRequest("grantId"),
		response: exactResponse({ scanId: nonEmptyString, itemIds: stringArray }),
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
});

module.exports = { capabilityNames, contracts, errorCodes };
