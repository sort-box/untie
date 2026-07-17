import { runFindQualityGate } from "./quality-gate.ts";

const result = runFindQualityGate();
console.log(
	JSON.stringify(
		{
			verdict: result.verdict,
			pass: result.pass,
			threshold: result.threshold,
			actual: {
				overallTop3Rate: result.evaluation.overall.top3Rate,
				byKindTop3Rate: {
					content: result.evaluation.byKind.content.top3Rate,
					"metadata-only": result.evaluation.byKind.metadataOnly.top3Rate,
					icloud: result.evaluation.byKind.iCloud.top3Rate,
				},
				noMatchAccuracy: result.evaluation.noMatch.accuracy,
			},
			failures: result.failures,
		},
		null,
		2,
	),
);
if (!result.pass) process.exitCode = 1;
