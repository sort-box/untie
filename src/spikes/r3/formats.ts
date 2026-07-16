import { inflateRawSync } from "node:zlib";

function crc32(input: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function xmlUnescape(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function zipStored(name: string, contents: Buffer): Buffer {
	const nameBytes = Buffer.from(name);
	const crc = crc32(contents);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(contents.length, 18);
	local.writeUInt32LE(contents.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(contents.length, 20);
	central.writeUInt32LE(contents.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	const body = Buffer.concat([local, nameBytes, contents]);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + nameBytes.length, 12);
	end.writeUInt32LE(body.length, 16);
	return Buffer.concat([body, central, nameBytes, end]);
}

export function makeDocx(text: string): Buffer {
	const paragraphs = text
		.split("\n")
		.map((line) => `<w:p><w:r><w:t>${xmlEscape(line)}</w:t></w:r></w:p>`)
		.join("");
	return zipStored(
		"word/document.xml",
		Buffer.from(
			`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
		),
	);
}

export function extractDocx(input: Buffer): string {
	let offset = 0;
	while (
		offset + 30 <= input.length &&
		input.readUInt32LE(offset) === 0x04034b50
	) {
		const method = input.readUInt16LE(offset + 8);
		const compressedSize = input.readUInt32LE(offset + 18);
		const nameLength = input.readUInt16LE(offset + 26);
		const extraLength = input.readUInt16LE(offset + 28);
		const nameStart = offset + 30;
		const dataStart = nameStart + nameLength + extraLength;
		const name = input.subarray(nameStart, nameStart + nameLength).toString();
		if (name === "word/document.xml") {
			const compressed = input.subarray(dataStart, dataStart + compressedSize);
			const xml = (
				method === 0 ? compressed : inflateRawSync(compressed)
			).toString();
			return xmlUnescape(
				xml
					.replaceAll(/<w:tab\s*\/>/g, "\t")
					.replaceAll(/<\/w:p>/g, "\n")
					.replaceAll(/<[^>]+>/g, " ")
					.replaceAll(/\s+/g, " ")
					.trim(),
			);
		}
		offset = dataStart + compressedSize;
	}
	throw new Error("DOCX has no word/document.xml entry");
}

function pdfEscape(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("(", "\\(")
		.replaceAll(")", "\\)");
}

export function makePdf(text: string): Buffer {
	const stream = `BT /F1 11 Tf 72 720 Td (${pdfEscape(text.replaceAll("\n", " "))}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1))
		pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}

export function extractPdf(input: Buffer): string {
	const source = input.toString("latin1");
	const chunks: string[] = [];
	for (const match of source.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
		chunks.push(
			(match[1] ?? "").replaceAll(/\\([\\()])/g, "$1").replaceAll(/\\n/g, "\n"),
		);
	}
	return chunks.join(" ").replaceAll(/\s+/g, " ").trim();
}
