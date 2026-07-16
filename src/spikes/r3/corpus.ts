import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { makeDocx, makePdf } from "./formats.ts";
import type { Corpus, CorpusFile, LabeledQuery } from "./types.ts";

interface Target {
	id: string;
	path: string;
	content: string;
	kind: "metadata" | "content";
	query: string;
}

const TARGETS: Target[] = [
	{
		id: "target-lease",
		path: "Personal/Housing/apartment-lease-2025.pdf",
		content:
			"Residential tenancy agreement for the Cedar Avenue apartment and security deposit.",
		kind: "metadata",
		query: "apartment lease",
	},
	{
		id: "target-tax",
		path: "Finance/Taxes/2024-federal-tax-return.pdf",
		content: "Federal income tax return and filing worksheet.",
		kind: "metadata",
		query: "2024 federal tax return",
	},
	{
		id: "target-resume",
		path: "Career/Applications/Gabriel_Product_Resume.docx",
		content: "Product engineering resume with work experience and education.",
		kind: "metadata",
		query: "product resume",
	},
	{
		id: "target-receipt",
		path: "Finance/Receipts/macbook-repair-receipt.pdf",
		content: "Repair invoice for laptop display replacement.",
		kind: "metadata",
		query: "macbook repair receipt",
	},
	{
		id: "target-syllabus",
		path: "School/CS-401/distributed-systems-syllabus.pdf",
		content: "Course schedule for consensus replication and fault tolerance.",
		kind: "metadata",
		query: "distributed systems syllabus",
	},
	{
		id: "target-notes",
		path: "Notes/meetings/acme-kickoff.md",
		content: "Project Acme kickoff decisions and owners.",
		kind: "metadata",
		query: "acme kickoff notes",
	},
	{
		id: "target-vet",
		path: "Personal/Pets/visit-summary.pdf",
		content:
			"Juniper received a rabies vaccination and should return to the veterinarian in October.",
		kind: "content",
		query: "Juniper rabies vaccination",
	},
	{
		id: "target-warranty",
		path: "Documents/scanned-document-42.pdf",
		content:
			"The espresso machine warranty expires in November 2027. Serial number Barista 8841.",
		kind: "content",
		query: "espresso machine warranty",
	},
	{
		id: "target-research",
		path: "School/Research/reading-notes.md",
		content:
			"The paper studies Byzantine fault tolerance using quorum certificates and view changes.",
		kind: "content",
		query: "Byzantine quorum certificates",
	},
	{
		id: "target-travel",
		path: "Travel/Europe/confirmation.txt",
		content:
			"Night train reservation from Vienna to Krakow, sleeper cabin 12, departing 18 June.",
		kind: "content",
		query: "night train Vienna Krakow",
	},
	{
		id: "target-benefits",
		path: "Work/HR/handbook.docx",
		content:
			"Parental leave provides sixteen paid weeks after twelve months of employment.",
		kind: "content",
		query: "sixteen weeks parental leave",
	},
	{
		id: "target-recipe",
		path: "Personal/Recipes/favorites.md",
		content:
			"Grandmother's lemon olive oil cake uses almond flour and three Meyer lemons.",
		kind: "content",
		query: "lemon olive oil cake",
	},
];

const FOLDERS = [
	"Downloads",
	"Documents",
	"School/Biology",
	"School/History",
	"Work/Projects",
	"Work/Archive",
	"Finance/Statements",
	"Photos/Exports",
	"Travel/Plans",
	"Personal/Misc",
];
const STEMS = [
	"report",
	"notes",
	"summary",
	"draft",
	"meeting",
	"invoice",
	"statement",
	"assignment",
	"presentation",
	"archive",
	"scan",
	"download",
	"outline",
	"schedule",
	"reference",
];
const EXTENSIONS = [
	"pdf",
	"docx",
	"txt",
	"md",
	"png",
	"jpg",
	"xlsx",
	"zip",
	"dmg",
	"csv",
];
const WORDS = [
	"project",
	"quarterly",
	"planning",
	"review",
	"budget",
	"research",
	"customer",
	"design",
	"analysis",
	"course",
	"travel",
	"personal",
];

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function pick<T>(values: readonly T[], rng: () => number): T {
	return values[Math.floor(rng() * values.length)] as T;
}

export function generateCorpus(count = 5_000, seed = 0x5eed): Corpus {
	if (count < TARGETS.length)
		throw new Error(`Corpus needs at least ${TARGETS.length} files`);
	const rng = random(seed);
	const files: CorpusFile[] = TARGETS.map((target, index) => ({
		id: target.id,
		relativePath: target.path,
		name: target.path.split("/").at(-1) ?? target.path,
		extension: extname(target.path).slice(1),
		size: 2_000 + index * 137,
		modifiedAt: new Date(
			Date.UTC(2024 + (index % 3), index % 12, 2 + index),
		).toISOString(),
		content: target.content,
	}));
	for (let index = files.length; index < count; index += 1) {
		const extension = pick(EXTENSIONS, rng);
		const stem = `${pick(STEMS, rng)}-${pick(WORDS, rng)}-${2020 + Math.floor(rng() * 7)}-${String(index).padStart(4, "0")}`;
		const name = `${stem}.${extension}`;
		const hasContent =
			["pdf", "docx", "txt", "md"].includes(extension) && index % 7 === 0;
		files.push({
			id: `file-${String(index).padStart(5, "0")}`,
			relativePath: `${pick(FOLDERS, rng)}/${name}`,
			name,
			extension,
			size: 512 + Math.floor(rng() * 8_000_000),
			modifiedAt: new Date(
				Date.UTC(
					2020 + Math.floor(rng() * 7),
					Math.floor(rng() * 12),
					1 + Math.floor(rng() * 27),
				),
			).toISOString(),
			content: hasContent
				? `${pick(WORDS, rng)} ${pick(WORDS, rng)} ${pick(STEMS, rng)} working document ${index}`
				: "",
		});
	}
	const queries: LabeledQuery[] = TARGETS.map((target) => ({
		id: `query-${target.id}`,
		kind: target.kind,
		query: target.query,
		relevantIds: [target.id],
	}));
	queries.push(
		{
			id: "query-prefix-lease",
			kind: "metadata",
			query: "apartment leas",
			relevantIds: ["target-lease"],
		},
		{
			id: "query-prefix-syllabus",
			kind: "metadata",
			query: "distributed systems syllab",
			relevantIds: ["target-syllabus"],
		},
		{
			id: "query-stem-vaccinate",
			kind: "content",
			query: "Juniper vaccinate",
			relevantIds: ["target-vet"],
		},
		{
			id: "query-stem-certificate",
			kind: "content",
			query: "Byzantine quorum certificate",
			relevantIds: ["target-research"],
		},
	);
	return { files, queries };
}

function encodedFile(file: CorpusFile): Buffer {
	if (file.extension === "pdf") return makePdf(file.content || file.name);
	if (file.extension === "docx") return makeDocx(file.content || file.name);
	return Buffer.from(file.content || file.name);
}

export async function writeCorpus(corpus: Corpus, root: string): Promise<void> {
	for (const file of corpus.files) {
		const path = join(root, file.relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, encodedFile(file));
	}
}
