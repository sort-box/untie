import type {
	FixtureScore,
	SortFixture,
	SortPlan,
	SpikeSummary,
} from "./types";

const normalize = (value: string) =>
	value.trim().normalize("NFKC").toLocaleLowerCase("en-US");

export function validatePlanGrounding(
	plan: SortPlan,
	fixture: SortFixture,
): string[] {
	const known = new Set(fixture.files.map((file) => file.id));
	const seen = new Set<string>();
	const errors: string[] = [];
	for (const category of plan.categories) {
		if (
			category.name.includes("/") ||
			category.name.includes("\\") ||
			[...category.name].some((character) => character.charCodeAt(0) < 32) ||
			category.name === "." ||
			category.name === ".."
		)
			errors.push(`unsafe category: ${category.name}`);
		for (const id of category.fileIds) {
			if (!known.has(id)) errors.push(`unknown ID: ${id}`);
			if (seen.has(id)) errors.push(`duplicate ID: ${id}`);
			seen.add(id);
		}
	}
	for (const id of plan.unassignedFileIds) {
		if (!known.has(id)) errors.push(`unknown unassigned ID: ${id}`);
		if (seen.has(id)) errors.push(`duplicate ID: ${id}`);
		seen.add(id);
	}
	return errors;
}

export function scorePlan(
	fixture: SortFixture,
	plan: SortPlan,
	metadata: Omit<
		FixtureScore,
		| "fixtureId"
		| "label"
		| "correctMoves"
		| "proposedMoves"
		| "totalFiles"
		| "precision"
		| "coverage"
		| "severeErrors"
	>,
): FixtureScore {
	const assignments = new Map<string, string>();
	for (const category of plan.categories)
		for (const id of category.fileIds) assignments.set(id, category.name);
	for (const id of plan.unassignedFileIds)
		assignments.set(id, "__UNASSIGNED__");
	let correctMoves = 0;
	let proposedMoves = 0;
	let severeErrors = 0;
	for (const file of fixture.files) {
		const destination = assignments.get(file.id);
		if (destination && destination !== "__UNASSIGNED__") proposedMoves += 1;
		if (
			destination &&
			destination !== "__UNASSIGNED__" &&
			normalize(destination) === normalize(file.expectedDestination)
		)
			correctMoves += 1;
		if (
			destination &&
			file.severeDestinations?.some(
				(bad) => normalize(bad) === normalize(destination),
			)
		)
			severeErrors += 1;
	}
	return {
		fixtureId: fixture.id,
		label: fixture.label,
		correctMoves,
		proposedMoves,
		totalFiles: fixture.files.length,
		precision: proposedMoves === 0 ? 1 : correctMoves / proposedMoves,
		coverage: proposedMoves / fixture.files.length,
		severeErrors,
		...metadata,
	};
}

export function summarize(
	mode: "offline" | "live",
	model: string,
	fixtures: FixtureScore[],
): SpikeSummary {
	const correct = fixtures.reduce((sum, item) => sum + item.correctMoves, 0);
	const proposed = fixtures.reduce((sum, item) => sum + item.proposedMoves, 0);
	const total = fixtures.reduce((sum, item) => sum + item.totalFiles, 0);
	const regenerations = fixtures.reduce(
		(sum, item) => sum + item.regenerations,
		0,
	);
	const totalCostValues = fixtures
		.map((item) => item.cost)
		.filter((value): value is number => value !== undefined);
	return {
		mode,
		model,
		fixtures,
		precision: proposed === 0 ? 1 : correct / proposed,
		coverage: proposed / total,
		severeErrors: fixtures.reduce((sum, item) => sum + item.severeErrors, 0),
		regenerations,
		regenerationRate: regenerations / fixtures.length,
		totalLatencyMs: fixtures.reduce((sum, item) => sum + item.latencyMs, 0),
		...(totalCostValues.length === fixtures.length
			? { totalCost: totalCostValues.reduce((sum, value) => sum + value, 0) }
			: {}),
	};
}
