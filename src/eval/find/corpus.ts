import { extname } from "node:path";
import type {
	FindCorpus,
	FindCorpusFile,
	FindLabeledQuery,
	FindQueryKind,
} from "./types.ts";

const DEFAULT_SEED = 0xf13_5eed;

interface Target {
	id: string;
	path: string;
	kind: Exclude<FindQueryKind, "no-match">;
	query: string;
	content: string;
}

interface Competitor {
	targetId: string;
	path: string;
	content: string;
}

const TARGETS: Target[] = [
	{
		id: "lease",
		path: "Personal/Housing/apartment-lease-2025.pdf",
		kind: "metadata-only",
		query: "apartment lease",
		content: "",
	},
	{
		id: "tax",
		path: "Finance/Taxes/2024-federal-tax-return.pdf",
		kind: "metadata-only",
		query: "2024 federal tax return",
		content: "",
	},
	{
		id: "resume",
		path: "Career/Applications/Gabriel-Product-Resume.docx",
		kind: "metadata-only",
		query: "product resume",
		content: "",
	},
	{
		id: "receipt",
		path: "Finance/Receipts/macbook-repair-receipt.pdf",
		kind: "metadata-only",
		query: "macbook repair receipt",
		content: "",
	},
	{
		id: "syllabus",
		path: "School/CS-401/distributed-systems-syllabus.pdf",
		kind: "metadata-only",
		query: "distributed systems syllabus",
		content: "",
	},
	{
		id: "kickoff",
		path: "Notes/Meetings/acme-kickoff-notes.md",
		kind: "metadata-only",
		query: "acme kickoff notes",
		content: "",
	},
	{
		id: "insurance",
		path: "Personal/Insurance/dental-policy-renewal.pdf",
		kind: "metadata-only",
		query: "dental policy renewal",
		content: "",
	},
	{
		id: "budget",
		path: "Work/Planning/phoenix-budget-forecast.xlsx",
		kind: "metadata-only",
		query: "phoenix budget forecast",
		content: "",
	},
	{
		id: "passport",
		path: "Travel/Documents/passport-renewal-checklist.txt",
		kind: "metadata-only",
		query: "passport renewal checklist",
		content: "",
	},
	{
		id: "vet",
		path: "Personal/Pets/Juniper-rabies-vaccination-visit-summary.pdf",
		kind: "content",
		query: "Juniper rabies vaccination",
		content:
			"Juniper received a rabies vaccination and should return to the veterinarian in October.",
	},
	{
		id: "warranty",
		path: "Documents/espresso-machine-warranty.pdf",
		kind: "content",
		query: "espresso machine warranty",
		content:
			"The espresso machine warranty expires in November 2027. Serial number Barista 8841.",
	},
	{
		id: "research",
		path: "School/Research/Byzantine-quorum-certificates-reading-notes.md",
		kind: "content",
		query: "Byzantine quorum certificates",
		content:
			"The paper studies Byzantine fault tolerance using quorum certificates and view changes.",
	},
	{
		id: "travel",
		path: "Travel/Europe/night-train-Vienna-Krakow-confirmation.txt",
		kind: "content",
		query: "night train Vienna Krakow",
		content:
			"Night train reservation from Vienna to Krakow, sleeper cabin 12, departing 18 June.",
	},
	{
		id: "benefits",
		path: "Work/HR/sixteen-weeks-parental-leave-handbook.docx",
		kind: "content",
		query: "sixteen weeks parental leave",
		content:
			"Parental leave provides sixteen paid weeks after twelve months of employment.",
	},
	{
		id: "recipe",
		path: "Personal/Recipes/lemon-olive-oil-cake-favorites.md",
		kind: "content",
		query: "lemon olive oil cake",
		content:
			"Grandmother's lemon olive oil cake uses almond flour and three Meyer lemons.",
	},
	{
		id: "conference",
		path: "Downloads/document-118.pdf",
		kind: "content",
		query: "conference accessibility reimbursement",
		content:
			"Accessibility expenses for the Horizon conference are eligible for reimbursement.",
	},
	{
		id: "garden",
		path: "Documents/notes-7.txt",
		kind: "content",
		query: "tomatoes drip irrigation",
		content:
			"The balcony tomatoes need drip irrigation every second morning during summer.",
	},
	{
		id: "interview",
		path: "Career/Archive/transcript.docx",
		kind: "content",
		query: "Kestrel design interview",
		content:
			"Interview notes for the Kestrel design systems role and portfolio discussion.",
	},
	{
		id: "icloud-thesis",
		path: "iCloud Drive/School/final-thesis-urban-forestry.pdf",
		kind: "icloud",
		query: "urban forestry thesis",
		content: "",
	},
	{
		id: "icloud-invoice",
		path: "iCloud Drive/Finance/northstar-consulting-invoice.docx",
		kind: "icloud",
		query: "northstar consulting invoice",
		content: "",
	},
	{
		id: "icloud-ticket",
		path: "iCloud Drive/Travel/tokyo-museum-tickets.pdf",
		kind: "icloud",
		query: "Tokyo museum tickets",
		content: "",
	},
	{
		id: "icloud-rental",
		path: "iCloud Drive/Personal/kayak-rental-confirmation.pdf",
		kind: "icloud",
		query: "kayak rental confirmation",
		content: "",
	},
	{
		id: "icloud-sketch",
		path: "iCloud Drive/Design/solstice-logo-sketch.png",
		kind: "icloud",
		query: "solstice logo sketch",
		content: "",
	},
	{
		id: "icloud-agenda",
		path: "iCloud Drive/Work/meridian-retreat-agenda.docx",
		kind: "icloud",
		query: "meridian retreat agenda",
		content: "",
	},
	{
		id: "icloud-certificate",
		path: "iCloud Drive/Records/scuba-certification-card.jpg",
		kind: "icloud",
		query: "scuba certification card",
		content: "",
	},
	{
		id: "icloud-furniture",
		path: "iCloud Drive/Home/walnut-desk-assembly.pdf",
		kind: "icloud",
		query: "walnut desk assembly",
		content: "",
	},
	{
		id: "icloud-audio",
		path: "iCloud Drive/Media/aurora-podcast-outline.md",
		kind: "icloud",
		query: "aurora podcast outline",
		content: "",
	},
];

// These unlabeled near-misses deliberately satisfy the same prefix-AND query as
// their target. The target carries the query terms in its high-weight filename,
// while the competitor carries them only in lower-weight content or path fields.
// This makes the production BM25 weights responsible for the correct ordering.
const COMPETITORS: Competitor[] = [
	{
		targetId: "lease",
		path: "Personal/Housing/archive/scan-2019.pdf",
		content: "Superseded apartment lease checklist retained for reference.",
	},
	{
		targetId: "tax",
		path: "Finance/Taxes/archive/accountant-notes.txt",
		content: "Draft notes about the 2024 federal tax return filing.",
	},
	{
		targetId: "receipt",
		path: "Finance/Receipts/archive/service-log.txt",
		content: "Old MacBook repair receipt reconciliation notes.",
	},
	{
		targetId: "syllabus",
		path: "School/CS-401/archive/course-notes.md",
		content: "Comments copied from the distributed systems syllabus draft.",
	},
	{
		targetId: "budget",
		path: "Work/Planning/archive/meeting-notes.md",
		content: "Discussion of an obsolete Phoenix budget forecast scenario.",
	},
	{
		targetId: "vet",
		path: "Personal/Pets/archive/reminder-2024.pdf",
		content:
			"Draft Juniper rabies vaccination reminder; verify against the signed veterinary visit summary.",
	},
	{
		targetId: "warranty",
		path: "Documents/archive/shopping-notes.txt",
		content:
			"Espresso machine warranty shopping notes copied before the final warranty was scanned.",
	},
	{
		targetId: "research",
		path: "School/Research/archive/outline.md",
		content:
			"Early Byzantine quorum certificates outline without the final paper annotations.",
	},
	{
		targetId: "travel",
		path: "Travel/Europe/archive/route-idea.txt",
		content:
			"Unconfirmed night train Vienna Krakow route idea; not the booked reservation.",
	},
	{
		targetId: "benefits",
		path: "Work/HR/archive/personal-notes.md",
		content:
			"Personal notes about sixteen weeks parental leave; consult the current employee handbook.",
	},
	{
		targetId: "recipe",
		path: "Personal/Recipes/archive/untested-variation.md",
		content:
			"An incomplete lemon olive oil cake variation missing the tested measurements.",
	},
	{
		targetId: "icloud-thesis",
		path: "Documents/archive/research-summary.txt",
		content: "Notes reviewing an older urban forestry thesis proposal.",
	},
	{
		targetId: "icloud-invoice",
		path: "Work/Archive/bookkeeping-notes.txt",
		content: "Reconciliation notes for a void Northstar consulting invoice.",
	},
	{
		targetId: "icloud-ticket",
		path: "Travel/Plans/archive-itinerary.md",
		content: "Draft itinerary mentioning possible Tokyo museum tickets.",
	},
	{
		targetId: "icloud-agenda",
		path: "Work/Archive/retreat-notes.md",
		content: "Comments on the superseded Meridian retreat agenda.",
	},
];

const NO_MATCH_QUERIES: FindLabeledQuery[] = [
	{
		id: "query-no-match-1",
		kind: "no-match",
		query: "xylophonic quasar memorandum",
		relevantIds: [],
	},
	{
		id: "query-no-match-2",
		kind: "no-match",
		query: "zephyrite submarine affidavit",
		relevantIds: [],
	},
	{
		id: "query-no-match-3",
		kind: "no-match",
		query: "quokka observatory notarization",
		relevantIds: [],
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

export function generateFindCorpus(
	count = 5_000,
	seed = DEFAULT_SEED,
): FindCorpus {
	const minimumFiles = TARGETS.length + COMPETITORS.length;
	if (count < minimumFiles)
		throw new Error(`Corpus needs at least ${minimumFiles} files`);
	const rng = random(seed);
	const files: FindCorpusFile[] = TARGETS.map((target) => ({
		id: `target-${target.id}`,
		relativePath: target.path,
		name: target.path.split("/").at(-1) ?? target.path,
		extension: extname(target.path).slice(1),
		content: target.content,
		isPlaceholder: target.kind === "icloud",
	}));
	for (const [index, competitor] of COMPETITORS.entries()) {
		files.push({
			id: `competitor-${competitor.targetId}`,
			relativePath: competitor.path,
			name: competitor.path.split("/").at(-1) ?? competitor.path,
			extension: extname(competitor.path).slice(1),
			content: competitor.content,
			isPlaceholder: false,
		});
		if (!TARGETS.some((target) => target.id === competitor.targetId))
			throw new Error(`Unknown competitor target at index ${index}`);
	}
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
			content: hasContent
				? `${pick(WORDS, rng)} ${pick(WORDS, rng)} ${pick(STEMS, rng)} working document ${index}`
				: "",
			isPlaceholder: false,
		});
	}
	const queries: FindLabeledQuery[] = TARGETS.map((target) => ({
		id: `query-${target.id}`,
		kind: target.kind,
		query: target.query,
		relevantIds: [`target-${target.id}`],
	}));
	queries.push(...NO_MATCH_QUERIES);
	return { seed, files, queries };
}
