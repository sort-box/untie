const { createHash, randomUUID } = require("node:crypto");

// These defaults are intentionally conservative: Untie warns before sending a
// very broad or very large top-level sort to planning, but never refuses it.
const DEFAULT_RISK_THRESHOLDS = Object.freeze({
	fileCount: 10_000,
	totalBytes: 20 * 1024 * 1024 * 1024,
});

// Exact directory markers and package/bundle suffixes inspected at the granted
// folder's top level. Names are matched case-insensitively after NFC normalization.
const TOOL_MANAGED_EXACT_MARKERS = Object.freeze([
	".git",
	".hg",
	".svn",
	"node_modules",
	"vendor",
	"Pods",
	"Carthage",
	".build",
	"DerivedData",
]);
const TOOL_MANAGED_SUFFIXES = Object.freeze([".xcodeproj", ".xcworkspace"]);

const RISK_CODES = Object.freeze([
	"FILE_COUNT_TOO_LARGE",
	"TOTAL_SIZE_TOO_LARGE",
	"TOOL_MANAGED_FOLDER",
]);

const RISK_REASONS = Object.freeze({
	FILE_COUNT_TOO_LARGE:
		"This folder contains an unusually large number of top-level files. Sorting it may take a long time and affect many files.",
	TOTAL_SIZE_TOO_LARGE:
		"The top-level files in this folder use an unusually large amount of storage. Moving them may take a long time or disrupt syncing and backups.",
	TOOL_MANAGED_FOLDER:
		"This looks like a code project or tool-managed folder. Moving files may break imports, builds, package managers, or Xcode projects.",
});

class RiskAcknowledgmentError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "RiskAcknowledgmentError";
		this.code = code;
	}
}

function normalizedMarker(name) {
	return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function toolMarkers(scan) {
	const exact = new Set(
		TOOL_MANAGED_EXACT_MARKERS.map((name) => normalizedMarker(name)),
	);
	const suffixes = TOOL_MANAGED_SUFFIXES.map((name) => normalizedMarker(name));
	return [...scan.files, ...scan.candidateDestinations, ...scan.skipped]
		.map(({ name }) => name)
		.filter((name) => {
			const normalized = normalizedMarker(name);
			return (
				exact.has(normalized) ||
				suffixes.some((suffix) => normalized.endsWith(suffix))
			);
		})
		.sort((left, right) => left.localeCompare(right, "en-US"));
}

function classifySortRisk(scan, thresholds = DEFAULT_RISK_THRESHOLDS) {
	const fileCount = scan.files.length;
	const totalBytes = scan.files.reduce((sum, file) => sum + file.size, 0);
	const markers = toolMarkers(scan);
	const codes = [];
	if (fileCount > thresholds.fileCount) codes.push("FILE_COUNT_TOO_LARGE");
	if (totalBytes > thresholds.totalBytes) codes.push("TOTAL_SIZE_TOO_LARGE");
	if (markers.length > 0) codes.push("TOOL_MANAGED_FOLDER");
	return Object.freeze({
		risky: codes.length > 0,
		risks: Object.freeze(
			codes.map((code) => Object.freeze({ code, reason: RISK_REASONS[code] })),
		),
		metrics: Object.freeze({ fileCount, totalBytes }),
		toolMarkers: Object.freeze(markers),
	});
}

function scanFingerprint(scan) {
	const stableEntries = [
		...scan.files.map(({ name, size }) => [
			"file",
			name.normalize("NFC"),
			size,
		]),
		...scan.candidateDestinations.map(({ name }) => [
			"directory",
			name.normalize("NFC"),
		]),
		...scan.skipped.map(({ name, reason }) => [
			"skipped",
			name.normalize("NFC"),
			reason,
		]),
	].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
	return createHash("sha256")
		.update(JSON.stringify(stableEntries))
		.digest("hex");
}

function sameBinding(left, right) {
	return (
		left.grantId === right.grantId &&
		left.scanFingerprint === right.scanFingerprint &&
		JSON.stringify(left.riskCodes) === JSON.stringify(right.riskCodes)
	);
}

function createRiskAcknowledgmentStore({
	randomUUID: random = randomUUID,
} = {}) {
	const tokens = new Map();

	function issue(binding) {
		const token = `risk_ack_${random().replaceAll("-", "")}`;
		tokens.set(token, { binding: structuredClone(binding), consumed: false });
		return token;
	}

	function consume(token, expectedBinding) {
		const record = tokens.get(token);
		if (!record) {
			throw new RiskAcknowledgmentError(
				"UNKNOWN_ACKNOWLEDGMENT_TOKEN",
				"The risk acknowledgment token is unknown.",
			);
		}
		if (record.consumed) {
			throw new RiskAcknowledgmentError(
				"ACKNOWLEDGMENT_TOKEN_CONSUMED",
				"The risk acknowledgment token has already been consumed.",
			);
		}
		if (!sameBinding(record.binding, expectedBinding)) {
			throw new RiskAcknowledgmentError(
				"ACKNOWLEDGMENT_TOKEN_MISMATCH",
				"The risk acknowledgment token does not match this folder scan.",
			);
		}
		record.consumed = true;
		return Object.freeze({ ...record.binding });
	}

	return { issue, consume };
}

function createSortRiskService({
	scanner,
	acknowledgmentStore,
	randomUUID: random = randomUUID,
}) {
	const classifications = new Map();

	async function classify({ grantId, canonicalPath, signal }) {
		const scan = await scanner.scanFolder(canonicalPath, { signal });
		const result = classifySortRisk(scan);
		const classificationId = `risk_${random().replaceAll("-", "")}`;
		const binding = Object.freeze({
			grantId,
			scanFingerprint: scanFingerprint(scan),
			riskCodes: Object.freeze(result.risks.map(({ code }) => code)),
		});
		classifications.set(classificationId, binding);
		return { classificationId, ...result };
	}

	function acknowledge({ classificationId }) {
		const binding = classifications.get(classificationId);
		if (!binding) {
			throw new RiskAcknowledgmentError(
				"UNKNOWN_RISK_CLASSIFICATION",
				"The risk classification is unknown or no longer current.",
			);
		}
		return { acknowledgmentToken: acknowledgmentStore.issue(binding) };
	}

	return { classify, acknowledge };
}

module.exports = {
	DEFAULT_RISK_THRESHOLDS,
	RISK_CODES,
	RISK_REASONS,
	RiskAcknowledgmentError,
	TOOL_MANAGED_EXACT_MARKERS,
	TOOL_MANAGED_SUFFIXES,
	classifySortRisk,
	createRiskAcknowledgmentStore,
	createSortRiskService,
	scanFingerprint,
};
