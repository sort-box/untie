import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { generateCorpus, writeCorpus } from "./corpus.ts";
import { evaluateStrategy, STRATEGIES } from "./evaluate.ts";
import { extractFile } from "./extraction.ts";
import { EXTRACTABLE_EXTENSIONS, type ExtractableExtension } from "./types.ts";

const corpus = generateCorpus();
const evaluation = STRATEGIES.map((strategy) =>
	evaluateStrategy(corpus, strategy),
);
const root = await mkdtemp(join(tmpdir(), "untie-r3-"));
try {
	const extractable = corpus.files.filter(
		(file) =>
			file.content &&
			EXTRACTABLE_EXTENSIONS.includes(file.extension as ExtractableExtension),
	);
	await writeCorpus({ files: extractable, queries: [] }, root);
	const extraction = [];
	for (const extension of EXTRACTABLE_EXTENSIONS) {
		const files = extractable
			.filter((file) => file.extension === extension)
			.slice(0, 100);
		const started = performance.now();
		let bytes = 0;
		for (const file of files) {
			const path = join(root, file.relativePath);
			await extractFile(path);
			bytes += (await stat(path)).size;
		}
		const durationMs = performance.now() - started;
		extraction.push({
			extension,
			files: files.length,
			durationMs,
			filesPerSecond: files.length / (durationMs / 1_000),
			megabytesPerSecond: bytes / 1_000_000 / (durationMs / 1_000),
		});
	}
	console.log(
		JSON.stringify(
			{
				runtime: process.version,
				sqlite: "node:sqlite",
				corpus: {
					files: corpus.files.length,
					contentFiles: extractable.length,
					queries: corpus.queries.length,
				},
				evaluation,
				extraction,
			},
			null,
			2,
		),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
