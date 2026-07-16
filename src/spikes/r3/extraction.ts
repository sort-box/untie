import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { extractDocx, extractPdf } from "./formats.ts";

export function extractBuffer(extension: string, input: Buffer): string {
	switch (extension.toLowerCase()) {
		case "txt":
		case "md":
			return input.toString("utf8");
		case "docx":
			return extractDocx(input);
		case "pdf":
			return extractPdf(input);
		default:
			throw new Error(`Unsupported extraction format: ${extension}`);
	}
}

export async function extractFile(path: string): Promise<string> {
	return extractBuffer(extname(path).slice(1), await readFile(path));
}
