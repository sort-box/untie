import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeDocx, makePdf } from "../src/spikes/r3/formats.ts";

const require = createRequire(import.meta.url);
const { extractFile, truncateUtf8 } = require("./extraction.cjs");
const temporaryDirectories = [];
const fixtureDirectory = path.join(
	import.meta.dirname,
	"fixtures",
	"extraction",
);

function temporaryFile(name, contents) {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "untie-extraction-test-"),
	);
	temporaryDirectories.push(directory);
	const filename = path.join(directory, name);
	fs.writeFileSync(filename, contents);
	return filename;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe("bounded extraction", () => {
	test.each([
		["txt", Buffer.from("shared bound text")],
		["md", Buffer.from("# shared bound text")],
		["pdf", makePdf("shared bound text")],
		["docx", makeDocx("shared bound text")],
	])("extracts %s and applies the shared output byte cap", async (extension, contents) => {
		const result = await extractFile(
			temporaryFile(`document.${extension}`, contents),
			{
				maxTextBytes: 8,
			},
		);

		expect(result).toEqual({
			status: "extracted",
			text: expect.any(String),
			truncated: true,
		});
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8);
	});

	test("truncates UTF-8 only at a complete code point", () => {
		expect(truncateUtf8("ab😀cd", 5)).toEqual({ text: "ab", truncated: true });
		expect(truncateUtf8("ab😀cd", 6)).toEqual({
			text: "ab😀",
			truncated: true,
		});
	});

	test.each([
		"txt",
		"md",
	])("never reads beyond the source cap for %s", async (extension) => {
		const result = await extractFile(
			temporaryFile(`large.${extension}`, "abcdefghij"),
			{
				maxFileBytes: 5,
				maxTextBytes: 20,
			},
		);
		expect(result).toEqual({
			status: "extracted",
			text: "abcde",
			truncated: true,
		});
	});

	test.each([
		"pdf",
		"docx",
	])("degrades oversized %s to metadata only", async (extension) => {
		const contents = extension === "pdf" ? makePdf("text") : makeDocx("text");
		expect(
			await extractFile(temporaryFile(`large.${extension}`, contents), {
				maxFileBytes: 16,
			}),
		).toEqual({ status: "metadata-only", reason: "too-large" });
	});

	test.each([
		["corrupt.pdf", "corrupt"],
		["password-protected.pdf", "password-protected"],
		["corrupt.docx", "corrupt"],
	])("safely degrades fixture %s", async (name, reason) => {
		expect(await extractFile(path.join(fixtureDirectory, name))).toEqual({
			status: "metadata-only",
			reason,
		});
	});

	test("safely degrades an encrypted OOXML compound-document fixture", async () => {
		const encoded = fs.readFileSync(
			path.join(fixtureDirectory, "password-protected.docx.b64"),
			"utf8",
		);
		const filename = temporaryFile(
			"password-protected.docx",
			Buffer.from(encoded.trim(), "base64"),
		);
		expect(await extractFile(filename)).toEqual({
			status: "metadata-only",
			reason: "password-protected",
		});
	});

	test("enforces the parser deadline by terminating its worker", async () => {
		const result = await extractFile(temporaryFile("deadline.txt", "text"), {
			timeoutMs: 0,
		});
		expect(result).toEqual({ status: "metadata-only", reason: "timeout" });
	});

	test("unsupported and unreadable files never throw", async () => {
		expect(await extractFile(temporaryFile("image.png", "png"))).toEqual({
			status: "metadata-only",
			reason: "unsupported",
		});
		expect(
			await extractFile(path.join(os.tmpdir(), "untie-missing-file.txt")),
		).toEqual({
			status: "metadata-only",
			reason: "read-error",
		});
	});
});
