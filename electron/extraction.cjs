const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const SUPPORTED_EXTENSIONS = new Set(["txt", "md", "pdf", "docx"]);
const DEFAULT_EXTRACTION_LIMITS = Object.freeze({
	maxFileBytes: 8 * 1024 * 1024,
	maxTextBytes: 256 * 1024,
	timeoutMs: 2_000,
});

function metadataOnly(reason) {
	return { status: "metadata-only", reason };
}

function truncateUtf8(text, maxBytes) {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

async function readBounded(filename, maxBytes) {
	let handle;
	try {
		handle = await fs.promises.open(filename, "r");
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return {
			bytes: buffer.subarray(0, Math.min(bytesRead, maxBytes)),
			oversized: bytesRead > maxBytes,
		};
	} finally {
		await handle?.close();
	}
}

function parseIsolated(extension, bytes, limits) {
	return new Promise((resolve) => {
		const worker = new Worker(path.join(__dirname, "extraction-worker.cjs"));
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			resolve(result);
		};
		const timer = setTimeout(
			() => finish(metadataOnly("timeout")),
			limits.timeoutMs,
		);
		worker.once("message", (message) =>
			finish(
				message.ok
					? { status: "parsed", text: message.text }
					: metadataOnly(message.reason),
			),
		);
		worker.once("error", () => finish(metadataOnly("parser-error")));
		worker.once("exit", (code) => {
			if (code !== 0) finish(metadataOnly("parser-error"));
		});
		worker.postMessage({
			extension,
			bytes,
			maxInflatedBytes: limits.maxFileBytes,
		});
	});
}

async function extractFile(filename, options = {}) {
	const limits = { ...DEFAULT_EXTRACTION_LIMITS, ...options };
	const extension = path.extname(filename).slice(1).toLocaleLowerCase("en-US");
	if (!SUPPORTED_EXTENSIONS.has(extension)) return metadataOnly("unsupported");
	try {
		const { bytes, oversized } = await readBounded(
			filename,
			limits.maxFileBytes,
		);
		if (oversized && extension !== "txt" && extension !== "md")
			return metadataOnly("too-large");
		const parsed = await parseIsolated(extension, bytes, limits);
		if (parsed.status === "metadata-only") return parsed;
		const bounded = truncateUtf8(parsed.text, limits.maxTextBytes);
		return {
			status: "extracted",
			text: bounded.text,
			truncated: oversized || bounded.truncated,
		};
	} catch {
		return metadataOnly("read-error");
	}
}

module.exports = {
	DEFAULT_EXTRACTION_LIMITS,
	SUPPORTED_EXTENSIONS,
	extractFile,
	truncateUtf8,
};
