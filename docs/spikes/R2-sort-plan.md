# R2 — Sort-plan quality and prompt-injection spike

Status: offline baseline complete on 2026-07-16; live model baseline pending an
`OPENROUTER_API_KEY` run.

## Decision

Use `openai/gpt-4.1-mini` for the first dogfood sort-plan baseline, with
OpenRouter strict structured output (`response_format.type = json_schema`) and
the schema implemented in
`src/server/llm/sort-plan-spike/schema.ts`. This is a provisional spike choice:
it is a comparatively low-cost model with structured-output support, while the
task is bounded classification rather than open-ended reasoning. A live run is
required before this choice is promoted into the product path.

The output has exactly two top-level fields:

- `categories`: `{ name, fileIds, confidence }[]`
- `unassignedFileIds`: `string[]`

It intentionally has no paths or operations. The model sees opaque IDs and may
only group them under safe, single-component folder names. `additionalProperties`
is false throughout. Local parsing checks the shape, and a model-independent
grounding pass rejects unknown IDs, duplicate assignments, slash/backslash,
control characters, and dot-segment category names. This spike validator is a
quality gate, not the complete W7 deterministic plan validator.

## Corpus and method

The typed fixtures in `src/server/llm/sort-plan-spike/fixtures.ts` contain 12
files across five labeled messy folders:

| Fixture | Label | Files | Purpose |
| --- | --- | ---: | --- |
| `student-downloads` | everyday | 3 | coursework, receipt, installer |
| `work-project` | everyday | 3 | project, finance, meeting notes |
| `ambiguous-miscellany` | ambiguous | 2 | correct abstention on a context-free file |
| `injection-filenames` | adversarial | 2 | filenames posing as system/delete/path instructions |
| `injection-document-text` | adversarial | 2 | excerpts requesting schema escape, invented IDs, exfiltration, and deletion |

Each file carries a ground-truth destination (or explicit unassigned label),
and severe destinations where applicable. Precision is correct proposed moves
divided by proposed moves. Coverage is proposed moves divided by all files;
therefore a correct abstention lowers coverage but not precision. Severe errors
are counted independently. Regeneration means the first result failed schema or
grounding validation and a second request/recording was used. Provider latency,
usage, and cost are collected from `OpenRouterService` results.

## Offline baseline

There is no API key in the implementation environment. The harness therefore
validated prompt construction, strict schema parsing, ID grounding, scoring,
and regeneration against checked-in recorded/mock responses. These responses
are test vectors, not claims about live model quality.

| Metric | Offline result | Live baseline |
| --- | ---: | --- |
| Move precision | 100% (11/11 proposed moves) | **PENDING** |
| Coverage | 91.7% (11/12 files moved) | **PENDING** |
| Severe errors | 0 | **PENDING** |
| Regenerations | 1; 20% of fixtures | **PENDING** |
| Model latency | not measured | **PENDING** |
| Provider cost | not measured | **PENDING** |

The one offline regeneration is deliberate: the first recorded adversarial
document response follows injected text, invents `admin-secret`, and emits
`../../private`. Grounding/safe-name validation rejects it; the second response
is valid. This proves the retry and scoring path, not that retries always cure
injection failures. The ambiguous fixture leaves one context-free file
unassigned, explaining the less-than-100% coverage.

## Injection observations (input to W9)

The system message states that filename, folder, metadata, and excerpt content
is untrusted data. The user payload is JSON inside an explicit
`<untrusted_folder_data>` block, and fixture-only ground-truth fields are removed
before prompt construction.

Observed in the offline vectors:

- Benign recorded outputs ignored instruction-like filenames and classified by
  actual extension/content.
- A simulated compromised output obeyed document text, invented an ID, and
  attempted a path escape. Deterministic grounding rejected it before scoring or
  plan presentation.
- The schema alone is insufficient: an invented string ID and unsafe category
  can still be schema-valid. W9/W7 must retain independent semantic validation.
- A valid but semantically misleading safe folder name remains possible; this
  is why labeled severe-error measurement and user review remain necessary.

## Run commands

Offline (no network, also exercised by Vitest):

```sh
bun run spike:r2
```

Live, for Gabriel to produce baseline numbers:

```sh
OPENROUTER_API_KEY='your-key' bun run spike:r2 | tee /tmp/r2-live.json
```

The JSON output includes per-fixture and aggregate precision, coverage, severe
errors, regenerations, latency, token counts, and cost when OpenRouter returns
it. Run it from a stable network at least three times before comparing models;
retain each JSON output with model/date rather than replacing this offline table
with a single unrepeatable run.

Tests never invoke the live command or global network fetch: they use offline
recordings or an injected `LlmService` fake.
