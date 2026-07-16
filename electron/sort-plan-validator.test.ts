import { describe, expect, it } from "vitest";

const {
	MAX_APFS_NAME_BYTES,
	PLAN_VALIDATION_ERROR_CODES,
	comparisonKey,
	validateSortPlan,
}: typeof import("./sort-plan-validator.cjs") = require("./sort-plan-validator.cjs");

type Destination = { kind: "new" | "existing"; name: string };
type Operation = { itemId: string; destination: Destination };
type Context = {
	files: { itemId: string; name: string }[];
	existingDestinations: { name: string; entries?: string[] }[];
};

const baseContext: Context = {
	files: [
		{ itemId: "file_a", name: "report.pdf" },
		{ itemId: "file_b", name: "photo.jpg" },
	],
	existingDestinations: [{ name: "School", entries: [] }],
};

function validate(operations: Operation[], context = baseContext) {
	return validateSortPlan({ operations }, context);
}

function codes(result: ReturnType<typeof validateSortPlan>) {
	return result.ok ? [] : result.errors.map((error) => error.code);
}

// A small deterministic property runner keeps generated tests reproducible and
// dependency-free. Each property receives 250 pseudo-random inputs and reports
// the seed/case through Vitest if it fails.
function property(run: (next: () => number, caseIndex: number) => void) {
	let state = 0x16a5f00d;
	const next = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state;
	};
	for (let caseIndex = 0; caseIndex < 250; caseIndex++) run(next, caseIndex);
}

function asciiName(next: () => number, prefix = "Folder") {
	return `${prefix}${next().toString(36)}`;
}

describe("deterministic sort-plan validator", () => {
	it("rejects invalid plan shapes and malformed operations", () => {
		expect(codes(validateSortPlan({ operations: [] }, undefined))).toEqual([
			"INVALID_PLAN",
		]);
		expect(
			codes(validateSortPlan({ operations: "not-an-array" }, baseContext)),
		).toEqual(["INVALID_PLAN"]);

		for (const operation of [
			{ itemId: 42, destination: { kind: "new", name: "Safe" } },
			{ itemId: "file_a" },
			{
				itemId: "file_a",
				destination: { kind: "invented", name: "Safe" },
			},
		]) {
			expect(
				codes(validateSortPlan({ operations: [operation] }, baseContext)),
			).toEqual(["INVALID_PLAN"]);
		}
	});

	it("accepts new and fully-scanned existing top-level destinations", () => {
		expect(
			validate([
				{ itemId: "file_a", destination: { kind: "existing", name: "School" } },
				{ itemId: "file_b", destination: { kind: "new", name: "Photos" } },
			]),
		).toEqual({
			ok: true,
			operations: [
				{ itemId: "file_a", destination: { kind: "existing", name: "School" } },
				{ itemId: "file_b", destination: { kind: "new", name: "Photos" } },
			],
		});
	});

	it("returns exhaustive, typed errors instead of stopping at the first failure", () => {
		const result = validate([
			{ itemId: "invented", destination: { kind: "new", name: "../escape" } },
			{ itemId: "invented", destination: { kind: "new", name: "Missing" } },
		]);
		expect(codes(result)).toEqual([
			"UNKNOWN_FILE_ID",
			"PATH_ESCAPE",
			"UNKNOWN_FILE_ID",
			"DUPLICATE_FILE_ID",
		]);
		for (const code of codes(result)) {
			expect(PLAN_VALIDATION_ERROR_CODES).toContain(code);
		}
	});

	it.each([
		["", "INVALID_DESTINATION_NAME", "EMPTY"],
		[".", "RESERVED_DESTINATION_NAME", "DOT_SEGMENT"],
		["..", "RESERVED_DESTINATION_NAME", "DOT_SEGMENT"],
		["a/b", "PATH_ESCAPE", "PATH_SYNTAX"],
		["a:b", "PATH_ESCAPE", "PATH_SYNTAX"],
		["/tmp", "PATH_ESCAPE", "PATH_SYNTAX"],
		["C:tmp", "PATH_ESCAPE", "PATH_SYNTAX"],
		["a\0b", "INVALID_DESTINATION_NAME", "CONTROL_CHARACTER"],
		["a\nb", "INVALID_DESTINATION_NAME", "CONTROL_CHARACTER"],
		["a\u202eb", "INVALID_DESTINATION_NAME", "CONTROL_CHARACTER"],
		[" Hidden", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		["Hidden ", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		["\u00a0Hidden", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		["Hidden\u3000", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		["\u2028Hidden", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		["Hidden\u2029", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		[".Hidden", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		["Hidden.", "INVALID_DESTINATION_NAME", "EDGE_DOT_OR_SPACE"],
		["é".repeat(128), "INVALID_DESTINATION_NAME", "TOO_LONG"],
	])("rejects unsafe APFS destination %j", (name, code, reason) => {
		const result = validate([
			{ itemId: "file_a", destination: { kind: "new", name } },
		]);
		expect(result).toMatchObject({
			ok: false,
			errors: [{ code, operationIndex: 0, reason }],
		});
	});

	it("uses APFS's 255-byte limit, not JavaScript character count", () => {
		expect(MAX_APFS_NAME_BYTES).toBe(255);
		expect(
			validate([
				{
					itemId: "file_a",
					destination: { kind: "new", name: "a".repeat(255) },
				},
			]),
		).toMatchObject({ ok: true });
		expect(
			validate([
				{
					itemId: "file_a",
					destination: { kind: "new", name: "é".repeat(128) },
				},
			]),
		).toMatchObject({ ok: false });
	});

	it("accepts APFS-safe characters that are not macOS path separators", () => {
		for (const name of ["Back\\slash", "~Archive"]) {
			expect(
				validate([{ itemId: "file_a", destination: { kind: "new", name } }]),
			).toMatchObject({ ok: true });
		}
	});

	it("classifies exact new/existing conflicts and missing existing folders", () => {
		expect(
			codes(
				validate([
					{ itemId: "file_a", destination: { kind: "new", name: "School" } },
				]),
			),
		).toContain("NEW_DESTINATION_CONFLICT");
		expect(
			codes(
				validate([
					{
						itemId: "file_a",
						destination: { kind: "existing", name: "Absent" },
					},
				]),
			),
		).toContain("DESTINATION_NOT_FOUND");
	});

	it("rejects case-only collisions among proposed and existing destinations", () => {
		expect(
			codes(
				validate([
					{ itemId: "file_a", destination: { kind: "new", name: "school" } },
				]),
			),
		).toContain("CASE_COLLISION");
		expect(
			codes(
				validate([
					{ itemId: "file_a", destination: { kind: "new", name: "Photos" } },
					{ itemId: "file_b", destination: { kind: "new", name: "photos" } },
				]),
			),
		).toContain("CASE_COLLISION");
	});

	it("rejects NFC/NFD collisions among proposed and existing destinations", () => {
		const nfc = "Café";
		const nfd = nfc.normalize("NFD");
		expect(
			codes(
				validate(
					[{ itemId: "file_a", destination: { kind: "new", name: nfd } }],
					{
						...baseContext,
						existingDestinations: [{ name: nfc, entries: [] }],
					},
				),
			),
		).toContain("UNICODE_COLLISION");
		expect(
			codes(
				validate([
					{ itemId: "file_a", destination: { kind: "new", name: nfc } },
					{ itemId: "file_b", destination: { kind: "new", name: nfd } },
				]),
			),
		).toContain("UNICODE_COLLISION");
	});

	it("fails closed when existing-folder contents were not supplied", () => {
		const result = validate(
			[{ itemId: "file_a", destination: { kind: "existing", name: "School" } }],
			{ ...baseContext, existingDestinations: [{ name: "School" }] },
		);
		expect(codes(result)).toContain("DESTINATION_CONTENTS_UNKNOWN");
	});

	it("rejects destination overwrite clashes case- and normalization-insensitively", () => {
		for (const existingName of ["REPORT.PDF", "réport.pdf"]) {
			const fileName = existingName.includes("́") ? "réport.pdf" : "report.pdf";
			const result = validate(
				[
					{
						itemId: "file_a",
						destination: { kind: "existing", name: "School" },
					},
				],
				{
					files: [{ itemId: "file_a", name: fileName }],
					existingDestinations: [{ name: "School", entries: [existingName] }],
				},
			);
			expect(codes(result)).toContain("DESTINATION_FILE_COLLISION");
		}
	});

	it("rejects moving a supplied source into itself", () => {
		const result = validate(
			[{ itemId: "file_a", destination: { kind: "existing", name: "School" } }],
			{
				files: [{ itemId: "file_a", name: "school" }],
				existingDestinations: [{ name: "School", entries: [] }],
			},
		);
		expect(codes(result)).toContain("MOVE_INTO_SELF");
	});

	it("rejects new destinations colliding with any scanned top-level file", () => {
		for (const destinationName of ["Taxes", "taxes", "Taxe\u0301s"]) {
			const fileName = destinationName.includes("\u0301") ? "Taxés" : "Taxes";
			const result = validate(
				[
					{
						itemId: "file_a",
						destination: { kind: "new", name: destinationName },
					},
				],
				{
					files: [
						{ itemId: "file_a", name: "report.pdf" },
						{ itemId: "file_b", name: fileName },
					],
					existingDestinations: [],
				},
			);
			expect(codes(result)).toContain("DESTINATION_FILE_COLLISION");
			expect(codes(result)).not.toContain("MOVE_INTO_SELF");
		}
	});

	it("property: every unknown ID and every duplicate assignment is rejected", () => {
		property((next) => {
			const known = `file_${next().toString(16)}`;
			const unknown = `${known}_unknown`;
			const context = {
				files: [{ itemId: known, name: "x.txt" }],
				existingDestinations: [],
			};
			expect(
				codes(
					validate(
						[{ itemId: unknown, destination: { kind: "new", name: "Safe" } }],
						context,
					),
				),
			).toContain("UNKNOWN_FILE_ID");
			expect(
				codes(
					validate(
						[
							{ itemId: known, destination: { kind: "new", name: "One" } },
							{ itemId: known, destination: { kind: "new", name: "Two" } },
						],
						context,
					),
				),
			).toContain("DUPLICATE_FILE_ID");
		});
	});

	it("property: separators, controls, dot edges, and oversized names never pass", () => {
		property((next) => {
			const safe = asciiName(next);
			const invalidNames = [
				`${safe}/${asciiName(next)}`,
				`${safe}:${asciiName(next)}`,
				`${safe}${String.fromCharCode(next() % 32)}`,
				`.${safe}`,
				`${safe} `,
				"é".repeat(128 + (next() % 30)),
			];
			for (const name of invalidNames) {
				expect(
					validate([{ itemId: "file_a", destination: { kind: "new", name } }])
						.ok,
				).toBe(false);
			}
		});
	});

	it("property: new/existing classification is exact and collision-safe", () => {
		property((next) => {
			const name = asciiName(next);
			const context = {
				...baseContext,
				existingDestinations: [{ name, entries: [] }],
			};
			expect(
				codes(
					validate(
						[{ itemId: "file_a", destination: { kind: "new", name } }],
						context,
					),
				),
			).toContain("NEW_DESTINATION_CONFLICT");
			expect(
				validate(
					[{ itemId: "file_a", destination: { kind: "existing", name } }],
					context,
				).ok,
			).toBe(true);
		});
	});

	it("property: case and Unicode-equivalent destination pairs always collide", () => {
		property((next) => {
			const stem = asciiName(next, "Café");
			const caseVariant = stem.toUpperCase();
			const nfdVariant = stem.normalize("NFD");
			expect(comparisonKey(stem)).toBe(comparisonKey(caseVariant));
			expect(comparisonKey(stem)).toBe(comparisonKey(nfdVariant));
			for (const variant of [caseVariant, nfdVariant]) {
				const result = validate([
					{ itemId: "file_a", destination: { kind: "new", name: stem } },
					{ itemId: "file_b", destination: { kind: "new", name: variant } },
				]);
				expect(result.ok).toBe(false);
			}
		});
	});

	it("property: any equivalent destination entry blocks an overwrite", () => {
		property((next) => {
			const fileName = `${asciiName(next)}.txt`;
			const entryName =
				next() % 2 === 0 ? fileName.toUpperCase() : fileName.normalize("NFD");
			const result = validate(
				[
					{
						itemId: "file_a",
						destination: { kind: "existing", name: "School" },
					},
				],
				{
					files: [{ itemId: "file_a", name: fileName }],
					existingDestinations: [{ name: "School", entries: [entryName] }],
				},
			);
			expect(codes(result)).toContain("DESTINATION_FILE_COLLISION");
		});
	});

	it("property: any equivalent scanned file name blocks a new destination", () => {
		property((next) => {
			const fileName = `${asciiName(next, "Café")}.txt`;
			const destinationName =
				next() % 2 === 0 ? fileName.toUpperCase() : fileName.normalize("NFD");
			const result = validate(
				[
					{
						itemId: "moving_file",
						destination: { kind: "new", name: destinationName },
					},
				],
				{
					files: [
						{ itemId: "moving_file", name: "source.pdf" },
						{ itemId: "blocking_file", name: fileName },
					],
					existingDestinations: [],
				},
			);
			expect(codes(result)).toContain("DESTINATION_FILE_COLLISION");
		});
	});
});
