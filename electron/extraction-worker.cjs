const { parentPort } = require("node:worker_threads");
const { inflateRawSync } = require("node:zlib");

class ExtractionParserError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

// Reasons the worker is allowed to report — a subset of ExtractionMetadataReason
// in extraction.d.cts. Any other thrown error (native zlib/buffer codes, etc.)
// must be mapped into this set so internal codes never leak to the typed result.
const WORKER_REASONS = new Set([
	"unsupported",
	"too-large",
	"corrupt",
	"password-protected",
	"parser-error",
]);

function normalizeReason(error) {
	const code = error?.code;
	if (typeof code === "string" && WORKER_REASONS.has(code)) return code;
	// Decompression / buffer-cap aborts (e.g. zip-bomb guard) → too-large.
	if (code === "ERR_BUFFER_TOO_LARGE") return "too-large";
	// zlib inflate failures on malformed compressed data → corrupt.
	if (typeof code === "string" && code.startsWith("Z_")) return "corrupt";
	return "parser-error";
}

function protectedFile(message) {
	throw new ExtractionParserError("password-protected", message);
}

function malformed(message) {
	throw new ExtractionParserError("corrupt", message);
}

function decodePdfString(value) {
	return value
		.replaceAll(/\\([\\()])/g, "$1")
		.replaceAll(
			/\\([nrtbf])/g,
			(_, escapeCode) =>
				({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[escapeCode],
		)
		.replaceAll(/\\([0-7]{1,3})/g, (_, octal) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		);
}

function extractPdf(input) {
	const source = input.toString("latin1");
	if (!source.startsWith("%PDF-")) malformed("Missing PDF header.");
	if (!source.includes("%%EOF")) malformed("Missing PDF end marker.");
	if (/\/Encrypt\b/.test(source)) protectedFile("Encrypted PDF.");
	const chunks = [];
	for (const match of source.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g))
		chunks.push(decodePdfString(match[1] ?? ""));
	for (const match of source.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) {
		for (const part of match[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g))
			chunks.push(decodePdfString(part[1] ?? ""));
	}
	return chunks.join(" ").replaceAll(/\s+/g, " ").trim();
}

function xmlUnescape(value) {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function extractDocx(input, maxInflatedBytes) {
	if (
		input.length >= 8 &&
		input
			.subarray(0, 8)
			.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
	)
		protectedFile("Encrypted OOXML compound document.");
	if (input.length < 4 || input.readUInt32LE(0) !== 0x04034b50)
		malformed("Missing DOCX ZIP header.");
	let offset = 0;
	while (
		offset + 30 <= input.length &&
		input.readUInt32LE(offset) === 0x04034b50
	) {
		const flags = input.readUInt16LE(offset + 6);
		const method = input.readUInt16LE(offset + 8);
		const compressedSize = input.readUInt32LE(offset + 18);
		const uncompressedSize = input.readUInt32LE(offset + 22);
		const nameLength = input.readUInt16LE(offset + 26);
		const extraLength = input.readUInt16LE(offset + 28);
		const nameStart = offset + 30;
		const dataStart = nameStart + nameLength + extraLength;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > input.length) malformed("Truncated DOCX ZIP entry.");
		if (flags & 1) protectedFile("Encrypted DOCX ZIP entry.");
		const name = input.subarray(nameStart, nameStart + nameLength).toString();
		if (name === "word/document.xml") {
			if (uncompressedSize > maxInflatedBytes)
				throw new ExtractionParserError(
					"too-large",
					"DOCX XML exceeds extraction bound.",
				);
			let contents;
			if (method === 0) contents = input.subarray(dataStart, dataEnd);
			else if (method === 8)
				contents = inflateRawSync(input.subarray(dataStart, dataEnd), {
					maxOutputLength: maxInflatedBytes,
				});
			else malformed("Unsupported DOCX ZIP compression.");
			const xml = contents.toString("utf8");
			if (!/<w:document(?:\s|>)/.test(xml) || !/<\/w:document>/.test(xml))
				malformed("Invalid DOCX document XML.");
			return xmlUnescape(
				xml
					.replaceAll(/<w:tab\s*\/>/g, "\t")
					.replaceAll(/<\/w:p>/g, "\n")
					.replaceAll(/<[^>]+>/g, " ")
					.replaceAll(/[ \t]+/g, " ")
					.replaceAll(/ *\n */g, "\n")
					.trim(),
			);
		}
		offset = dataEnd;
	}
	malformed("DOCX has no word/document.xml entry.");
}

parentPort.on("message", ({ extension, bytes, maxInflatedBytes }) => {
	try {
		const input = Buffer.from(bytes);
		let text;
		if (extension === "txt" || extension === "md")
			text = input.toString("utf8");
		else if (extension === "pdf") text = extractPdf(input);
		else if (extension === "docx") text = extractDocx(input, maxInflatedBytes);
		else throw new ExtractionParserError("unsupported", "Unsupported format.");
		parentPort.postMessage({ ok: true, text });
	} catch (error) {
		parentPort.postMessage({
			ok: false,
			reason: normalizeReason(error),
		});
	}
});
