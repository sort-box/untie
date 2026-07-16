import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { createFolderScanner } = require("./folder-scanner.cjs");
const {
	DEFAULT_RISK_THRESHOLDS,
	RISK_REASONS,
	TOOL_MANAGED_EXACT_MARKERS,
	TOOL_MANAGED_SUFFIXES,
	classifySortRisk,
	createRiskAcknowledgmentStore,
} = require("./sort-risk.cjs");

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
	const directory = await mkdtemp(path.join(tmpdir(), "untie-risk-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function scan(directory: string) {
	const appDataDirectory = await temporaryDirectory();
	return createFolderScanner({ appDataDirectory }).scanFolder(directory);
}

describe("pre-sort risk classification", () => {
	it("defines documented production thresholds and detection inputs", () => {
		expect(DEFAULT_RISK_THRESHOLDS).toEqual({
			fileCount: 10_000,
			totalBytes: 20 * 1024 * 1024 * 1024,
		});
		expect(TOOL_MANAGED_EXACT_MARKERS).toEqual(
			expect.arrayContaining([".git", "node_modules"]),
		);
		expect(TOOL_MANAGED_SUFFIXES).toEqual(
			expect.arrayContaining([".xcodeproj", ".xcworkspace"]),
		);
	});

	it("warns independently above the configured count and size thresholds", () => {
		const countRisk = classifySortRisk(
			{
				files: [
					{ name: "a.txt", size: 1 },
					{ name: "b.txt", size: 1 },
				],
				candidateDestinations: [],
				skipped: [],
			},
			{ fileCount: 1, totalBytes: 100 },
		);
		const sizeRisk = classifySortRisk(
			{
				files: [{ name: "large.bin", size: 101 }],
				candidateDestinations: [],
				skipped: [],
			},
			{ fileCount: 10, totalBytes: 100 },
		);

		expect(countRisk.risks).toContainEqual({
			code: "FILE_COUNT_TOO_LARGE",
			reason: RISK_REASONS.FILE_COUNT_TOO_LARGE,
		});
		expect(sizeRisk.risks).toContainEqual({
			code: "TOTAL_SIZE_TOO_LARGE",
			reason: RISK_REASONS.TOTAL_SIZE_TOO_LARGE,
		});
	});

	it.each([
		".git",
		"node_modules",
		"Example.xcodeproj",
	])("detects the top-level tool marker %s from the main-process scan", async (marker) => {
		const folder = await temporaryDirectory();
		await mkdir(path.join(folder, marker));

		const result = classifySortRisk(await scan(folder));

		expect(result.risky).toBe(true);
		expect(result.toolMarkers).toEqual([marker]);
		expect(result.risks).toContainEqual({
			code: "TOOL_MANAGED_FOLDER",
			reason: RISK_REASONS.TOOL_MANAGED_FOLDER,
		});
	});

	it("returns no risks for a benign folder", async () => {
		const folder = await temporaryDirectory();
		await writeFile(path.join(folder, "notes.txt"), "hello");

		expect(classifySortRisk(await scan(folder))).toMatchObject({
			risky: false,
			risks: [],
			metrics: { fileCount: 1, totalBytes: 5 },
			toolMarkers: [],
		});
	});
});

describe("one-use risk acknowledgments", () => {
	const binding = {
		grantId: "grant-one",
		scanFingerprint: "scan-one",
		riskCodes: ["TOOL_MANAGED_FOLDER"],
	};

	it("issues a token that is consumed exactly once", () => {
		const store = createRiskAcknowledgmentStore({
			randomUUID: () => "00000000-0000-0000-0000-000000000001",
		});
		const token = store.issue(binding);

		expect(token).toBe("risk_ack_00000000000000000000000000000001");
		expect(store.consume(token, binding)).toEqual(binding);
		expect(() => store.consume(token, binding)).toThrowError(
			expect.objectContaining({ code: "ACKNOWLEDGMENT_TOKEN_CONSUMED" }),
		);
	});

	it("rejects unknown and mismatched tokens without consuming a mismatch", () => {
		const store = createRiskAcknowledgmentStore();
		const token = store.issue(binding);

		expect(() => store.consume("risk_ack_unknown", binding)).toThrowError(
			expect.objectContaining({ code: "UNKNOWN_ACKNOWLEDGMENT_TOKEN" }),
		);
		expect(() =>
			store.consume(token, { ...binding, scanFingerprint: "different" }),
		).toThrowError(
			expect.objectContaining({ code: "ACKNOWLEDGMENT_TOKEN_MISMATCH" }),
		);
		expect(store.consume(token, binding)).toEqual(binding);
	});
});
