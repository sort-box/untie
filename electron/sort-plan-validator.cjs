const { Buffer } = require("node:buffer");

const MAX_APFS_NAME_BYTES = 255;

const PLAN_VALIDATION_ERROR_CODES = Object.freeze([
	"INVALID_PLAN",
	"UNKNOWN_FILE_ID",
	"DUPLICATE_FILE_ID",
	"INVALID_DESTINATION_NAME",
	"RESERVED_DESTINATION_NAME",
	"PATH_ESCAPE",
	"DESTINATION_NOT_FOUND",
	"NEW_DESTINATION_CONFLICT",
	"CASE_COLLISION",
	"UNICODE_COLLISION",
	"DESTINATION_CONTENTS_UNKNOWN",
	"DESTINATION_FILE_COLLISION",
	"MOVE_INTO_SELF",
]);

function comparisonKey(name) {
	return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function issue(code, operationIndex, details) {
	return Object.freeze({ code, operationIndex, ...details });
}

function destinationNameIssue(name) {
	if (typeof name !== "string" || name.length === 0) {
		return { code: "INVALID_DESTINATION_NAME", reason: "EMPTY" };
	}
	if (name === "." || name === "..") {
		return { code: "RESERVED_DESTINATION_NAME", reason: "DOT_SEGMENT" };
	}
	if (name.includes("/") || name.includes(":")) {
		return { code: "PATH_ESCAPE", reason: "PATH_SYNTAX" };
	}
	if (/[\p{Cc}\p{Cf}]/u.test(name)) {
		return { code: "INVALID_DESTINATION_NAME", reason: "CONTROL_CHARACTER" };
	}
	if (/^[.\p{Zs}\p{Zl}\p{Zp}]|[.\p{Zs}\p{Zl}\p{Zp}]$/u.test(name)) {
		return { code: "INVALID_DESTINATION_NAME", reason: "EDGE_DOT_OR_SPACE" };
	}
	if (Buffer.byteLength(name, "utf8") > MAX_APFS_NAME_BYTES) {
		return { code: "INVALID_DESTINATION_NAME", reason: "TOO_LONG" };
	}
	return undefined;
}

function validateSortPlan(plan, context) {
	const errors = [];
	if (!plan || !Array.isArray(plan.operations) || !context) {
		return Object.freeze({
			ok: false,
			errors: Object.freeze([issue("INVALID_PLAN", undefined, {})]),
		});
	}

	const files = Array.isArray(context.files) ? context.files : [];
	const existingDestinations = Array.isArray(context.existingDestinations)
		? context.existingDestinations
		: [];
	const fileById = new Map(files.map((file) => [file.itemId, file]));
	const filesByKey = new Map(
		files.map((file) => [comparisonKey(file.name), file]),
	);
	const existingByName = new Map(
		existingDestinations.map((destination) => [destination.name, destination]),
	);
	const existingByKey = new Map();
	for (const destination of existingDestinations) {
		const key = comparisonKey(destination.name);
		const prior = existingByKey.get(key);
		if (prior && prior.name !== destination.name) {
			const code =
				prior.name.normalize("NFC") === destination.name.normalize("NFC")
					? "UNICODE_COLLISION"
					: "CASE_COLLISION";
			errors.push(
				issue(code, undefined, {
					destination: destination.name,
					conflictsWith: prior.name,
				}),
			);
		} else if (!prior) existingByKey.set(key, destination);
	}

	const seenIds = new Map();
	const proposedByKey = new Map();
	const validOperations = [];

	for (const [operationIndex, operation] of plan.operations.entries()) {
		if (
			!operation ||
			typeof operation.itemId !== "string" ||
			!operation.destination ||
			!["new", "existing"].includes(operation.destination.kind)
		) {
			errors.push(issue("INVALID_PLAN", operationIndex, {}));
			continue;
		}

		const { itemId, destination } = operation;
		const file = fileById.get(itemId);
		if (!file)
			errors.push(issue("UNKNOWN_FILE_ID", operationIndex, { itemId }));
		if (seenIds.has(itemId)) {
			errors.push(
				issue("DUPLICATE_FILE_ID", operationIndex, {
					itemId,
					firstOperationIndex: seenIds.get(itemId),
				}),
			);
		} else seenIds.set(itemId, operationIndex);

		const nameProblem = destinationNameIssue(destination.name);
		if (nameProblem) {
			errors.push(
				issue(nameProblem.code, operationIndex, {
					destination: destination.name,
					reason: nameProblem.reason,
				}),
			);
			continue;
		}

		const exactExisting = existingByName.get(destination.name);
		const equivalentExisting = existingByKey.get(
			comparisonKey(destination.name),
		);
		if (destination.kind === "existing" && !exactExisting) {
			errors.push(
				issue(
					equivalentExisting
						? destination.name.normalize("NFC") ===
							equivalentExisting.name.normalize("NFC")
							? "UNICODE_COLLISION"
							: "CASE_COLLISION"
						: "DESTINATION_NOT_FOUND",
					operationIndex,
					{
						destination: destination.name,
						...(equivalentExisting && {
							conflictsWith: equivalentExisting.name,
						}),
					},
				),
			);
		} else if (destination.kind === "new" && equivalentExisting) {
			const code = exactExisting
				? "NEW_DESTINATION_CONFLICT"
				: destination.name.normalize("NFC") ===
						equivalentExisting.name.normalize("NFC")
					? "UNICODE_COLLISION"
					: "CASE_COLLISION";
			errors.push(
				issue(code, operationIndex, {
					destination: destination.name,
					conflictsWith: equivalentExisting.name,
				}),
			);
		}
		if (destination.kind === "new") {
			const conflictingFile = filesByKey.get(comparisonKey(destination.name));
			if (conflictingFile) {
				errors.push(
					issue("DESTINATION_FILE_COLLISION", operationIndex, {
						itemId,
						destination: destination.name,
						fileName: conflictingFile.name,
					}),
				);
			}
		}

		const key = comparisonKey(destination.name);
		const prior = proposedByKey.get(key);
		if (prior && prior.name !== destination.name) {
			const code =
				prior.name.normalize("NFC") === destination.name.normalize("NFC")
					? "UNICODE_COLLISION"
					: "CASE_COLLISION";
			errors.push(
				issue(code, operationIndex, {
					destination: destination.name,
					conflictsWith: prior.name,
					firstOperationIndex: prior.operationIndex,
				}),
			);
		} else if (!prior) {
			proposedByKey.set(key, { name: destination.name, operationIndex });
		}

		if (file && comparisonKey(file.name) === key) {
			errors.push(
				issue("MOVE_INTO_SELF", operationIndex, {
					itemId,
					destination: destination.name,
				}),
			);
		}

		if (destination.kind === "existing" && exactExisting) {
			if (!Array.isArray(exactExisting.entries)) {
				errors.push(
					issue("DESTINATION_CONTENTS_UNKNOWN", operationIndex, {
						destination: destination.name,
					}),
				);
			} else if (
				file &&
				exactExisting.entries.some(
					(entryName) => comparisonKey(entryName) === comparisonKey(file.name),
				)
			) {
				errors.push(
					issue("DESTINATION_FILE_COLLISION", operationIndex, {
						itemId,
						destination: destination.name,
						fileName: file.name,
					}),
				);
			}
		}

		validOperations.push(
			Object.freeze({
				itemId,
				destination: Object.freeze({
					kind: destination.kind,
					name: destination.name.normalize("NFC"),
				}),
			}),
		);
	}

	if (errors.length > 0) {
		return Object.freeze({ ok: false, errors: Object.freeze(errors) });
	}
	return Object.freeze({
		ok: true,
		operations: Object.freeze(validOperations),
	});
}

module.exports = {
	MAX_APFS_NAME_BYTES,
	PLAN_VALIDATION_ERROR_CODES,
	comparisonKey,
	destinationNameIssue,
	validateSortPlan,
};
