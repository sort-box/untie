# Untie v1 — GitHub Issue Plan

> Status: FINAL (Gabriel × Claude × Codex, 2026-07-16)
> Source of truth for scope: `docs/PRD.md`
>
> Structure follows Codex's restructure of the first draft: risk gates first,
> then a **walking skeleton** that proves the entire sort loop end-to-end on one
> folder, then safety completion, then find, then product shell, then release
> qualification. One issue = one independently reviewable PR. Tests ship inside
> the implementation issue they verify — there is no late "add tests" umbrella.

**Milestones:** `M0 Risk gates` → `M1 Walking skeleton` → `M2 Safety-complete sort`
→ `M3 Index & find` → `M4 Shell, onboarding & privacy` → `M5 Release qualification`

**Labels:** `area:main-process` `area:renderer` `area:server` `type:spike`
`type:infra` `type:feature` `type:test` `type:design`

---

## M0 — Risk gates

All four run in parallel and produce explicit go/no-go evidence before broad
implementation.

### R1 — Signed & notarized filesystem-access spike
`type:spike` · Deps: none
Build a signed, notarized DMG (hardened runtime + entitlements) and test folder
access against a pass/fail matrix: Downloads, Desktop, Documents, an external
folder, an iCloud-managed folder, relaunch persistence, revocation, and
security-scoped bookmark restoration. Record whether placeholder inspection
triggers iCloud downloads.
**Done:** matrix results + final entitlements + known limitations documented.
"A DMG was produced" is not done.

### R2 — Sort-plan quality & prompt-injection spike
`type:spike` · Deps: existing LLM service only
Labeled messy-folder fixtures; experiment with prompt/schema/model until plan
quality is acceptable. Include adversarial fixtures (malicious filenames and
document text that resemble instructions).
**Done:** baseline report of precision, coverage, severe errors, regeneration
behavior, latency, and cost; documented model + schema choice.

### R3 — FTS5 relevance & extraction spike
`type:spike` · Deps: none
Realistic ~5k-file corpus; evaluate FTS5 tokenizer/query strategies for
metadata-only and extracted-content retrieval; measure extraction throughput.
**Done:** retrieval quality numbers, latency targets, tokenizer/query approach,
and go/no-go on the find architecture. Groundwork for the find eval corpus.

### R4 — Safety state-machine design
`type:design` · Deps: none
Design doc (reviewed, in `docs/`) for the journal/apply/undo lifecycle:
state transitions, crash points, preflight atomicity rule (whole-batch
authorization or no moves), recovery decision table, undo conflict matrix.
**Done:** reviewed document exists before journal/apply implementation starts.

---

## M1 — Walking sort skeleton

Goal: one granted folder can be scanned, planned, reviewed, approved, applied,
and immediately undone in a development build. Broad indexing, sidebar polish,
and find are deliberately excluded.

### W1 — Local store foundation
`area:main-process` `type:infra` · Deps: none
App data directory layout with separated stores (DB, journal, chat), versioning
and migrations, startup failure handling.
**Done:** versioned stores initialize, migrate, and fail safely, with tests.

### W2 — Typed capability IPC scaffold
`area:main-process` `type:infra` · Deps: none
Preload bridge + main-process handler registry with typed request/response
schemas, structured errors, and cancellation plumbing. No generic fs primitives.
**Done:** includes a test proving no raw path-based read/move primitive is
exposed to the sandboxed renderer.

### W3 — Capability authorization & grant-boundary enforcement
`area:main-process` `type:infra` · Deps: W2
Reusable authorization layer: path canonicalization, symlink-safe containment,
opaque item resolution, revoked/stale grant rejection.
**Done:** adversarial containment tests pass (string-prefix tricks and
renderer-supplied paths must fail).

### W4 — Folder picker & persistent macOS grants
`area:main-process` `type:feature` · Deps: R1, W1, W3
`selectFolder()` via system dialog, stable grant IDs, security-scoped bookmark
persistence, relaunch restoration, unavailable-grant states.
**Done:** grant survives relaunch; unavailable bookmarks surfaced, not silent.

### W5 — Safe top-level scan contract
`area:main-process` `type:feature` · Deps: W4
Scan of top-level regular files with deterministic skip reasons: hidden files,
symlinks/aliases, package bundles, temp/partial downloads, app's own data.
Existing top-level directories reported as candidate destinations.
**Done:** scan contract matches PRD §7.4 with representative filesystem tests;
cancellable.

### W6 — Opaque file IDs & source snapshots
`area:main-process` `type:feature` · Deps: W5
ID↔path mapping with immutable source fingerprints (canonical path, size,
mtime), expiry, and invalidation on grant or scan change. Not the plan store.
**Done:** renderer/model never receive paths usable as capabilities; IDs
expire/invalidate correctly under tests.

### W7 — Clerk authentication & server identity
`area:server` `type:feature` · Deps: none
Wire Clerk sign-in through to verified server identity for server functions;
typed expired/unauthorized states.
**Done:** signed-in renderer produces authenticated server calls; auth failure
states are typed and testable.

### W8 — Authenticated usage-limited LLM gateway
`area:server` `type:feature` · Deps: W7
Connect the existing usage-limited OpenRouter service to Clerk identity and
Convex quota accounting (quota = cost control for the free prototype).
**Done:** quota enforced per account; logs contain no sensitive payload data.

### W9 — Production sort-plan generation
`area:server` `type:feature` · Deps: R2, W6, W8
Typed `generateObject` sort endpoint using R2's chosen model/schema: bounded
prompt construction, untrusted-content delimiters, optional regeneration
instruction, cancellation/timeout. Payload limits; the endpoint cannot be made
to request arbitrary filesystem content.
**Done:** plans reference only supplied opaque IDs; injection fixtures from R2
pass; cancellation works end-to-end.

### W10 — Deterministic plan validator
`area:main-process` `type:feature` · Deps: W6 (parallel with W9)
Model-independent validation: ID completeness/uniqueness, destination name
validity, new-vs-existing top-level destinations, path escape prevention,
reserved names, case-only and Unicode-normalization collisions, source/dest
conflicts.
**Done:** exhaustive unit + property tests for every rule and collision class.

### W11 — Immutable prepared-plan store
`area:main-process` `type:feature` · Deps: W10, W1
Validated plan snapshots: versioning, exact operation counts, disclosure
manifest hook, exclusions, expiry, filesystem-change invalidation, approval
binding.
**Done:** approval binds to a snapshot that becomes unusable after edit,
expiry, grant change, or source change — under tests.

### W12 — Minimal chat shell & structured message model
`area:renderer` `type:feature` · Deps: W2
Main chat pane + "new chat" with a structured message model able to render
pending, failed, plan, progress, result, and undo messages. No persistence,
pins, or recents yet.
**Done:** a sort request round-trips through all message states in dev.

### W13 — Minimal plan review & exact approval
`area:renderer` `type:feature` · Deps: W11, W12
First plan card: complete move set visible, exact-counts approval copy
("Create N folders and move M files… nothing renamed, overwritten, deleted"),
approve disabled for invalid/stale plans.
**Done:** every move reviewable; stale/invalid plans cannot be approved.

### W14 — Minimal journaled apply
`area:main-process` `type:feature` · Deps: R4, W11, W1
Write-ahead journal (durable states per R4) + apply engine: whole-plan
preflight before any mutation, create dirs + move files, never overwrite,
journal each transition, partial failure → explicit durable state.
**Done:** state-machine tests + fault injection on moves ship in this PR.

### W15 — Minimal immediate undo
`area:main-process` `type:feature` · Deps: W14
Deterministic reverse replay from journal: never overwrite, remove only
created-and-still-empty folders, per-file outcomes.
**Done:** controlled tests restore 100% of eligible files; conflicts surfaced.

### W16 — Walking-skeleton E2E
`type:test` · Deps: W4–W15
Automated grant → scan → plan → review → apply → undo in a packaged dev build.
**Done:** green in CI (or a reproducible script if CI can't run Electron yet).

---

## M2 — Safety-complete sort

### S1 — Pre-sort risk classification & acknowledgment
`area:main-process` `type:feature` · Deps: W5
Heavy warning — never refusal (decided) — for absurdly large folders (file
count/size thresholds) and tool-managed/code-project folders (`.git`,
`node_modules`, Xcode projects). One-use acknowledgment token consumed by
approval.
**Done:** thresholds + detection inputs defined and tested; copy-ready reasons.

### S2 — Request data manifest
`area:server` `type:feature` · Deps: W9
Deterministically compute what leaves the device (filename, metadata, snippet,
document counts) from the exact outbound payload.
**Done:** manifest provably matches transmitted payload in tests.

### S3 — Per-request sort disclosure UI
`area:renderer` `type:feature` · Deps: S2, W13
"This will send 84 filenames + metadata…" shown before transmission; user can
cancel without sending.
**Done:** displayed counts equal sent counts (tested); updates on exclusion.

### S4 — Full plan card review & exclusions
`area:renderer` `type:feature` · Deps: W13
Progressive disclosure: summary → grouped destinations with representative
examples → expandable full list; low-confidence flags; exclusion checkboxes;
keyboard operability.
**Done:** complete against PRD §7.3 step 4 including accessibility behavior.

### S5 — Regenerate with optional instruction
`area:renderer` `area:server` `type:feature` · Deps: S4, W9, S2
"Regenerate" with optional corrective instruction; replacement semantics (new
plan, old approval invalidated, stale card marked, disclosure recomputed).
**Done:** regeneration never mutates an existing snapshot.

### S6 — Full approval orchestration
`area:renderer` `type:feature` · Deps: S1, S3, S4, W11
Exact mutation copy, risk-warning acknowledgment, disabled states with
reasons, double-submit prevention, snapshot/version binding.
**Done:** all listed behaviors tested, incl. stale-plan blocking.

### S7 — Apply progress & result summary
`area:renderer` `type:feature` · Deps: W14, W12
Live per-operation progress and final summary in chat, driven by journal
state.
**Done:** durable progress survives renderer reload mid-apply.

### S8 — Crash recovery engine & startup gate
`area:main-process` `type:feature` · Deps: R4, W14
Deterministic behavior per journal state on launch (R4 decision table);
idempotent repeated launches; startup gate before normal shell renders
(also covers DB migration failure, unavailable grants, expired auth,
interrupted onboarding).
**Done:** fault-injection tests for every journal state.

### S9 — Recovery & `needs_attention` UI
`area:renderer` `type:feature` · Deps: S8, W12
Users can distinguish completed / pending / conflicted operations and see safe
next actions; support details never leak paths into logs.
**Done:** every `needs_attention` cause has a user-comprehensible presentation.

### S10 — Full undo engine & UI
`area:main-process` `area:renderer` `type:feature` · Deps: S7, S8
Complete conflict matrix (occupied original location, missing destination,
modified file, missing parent, partially applied plan, created-folder cleanup)
+ UI stating the honest guarantee, per-file conflict display, duplicate-undo
prevention, complete/partial/unavailable outcomes.
**Done:** conflict matrix passes; UI distinguishes all three outcomes.

### S11 — Destructive & recovery E2E suite
`type:test` · Deps: S6–S10
Stale snapshot, collision, injected move failure, crash/relaunch recovery,
partial undo.
**Done:** all scenarios automated and green.

---

## M3 — Local index & find

### F1 — SQLite/FTS5 schema & migrations
`area:main-process` `type:infra` · Deps: W1, R3
Transactional schema, migrations, tokenizer config from R3, corruption/startup
behavior, indexed file identity separated from mutable paths.
**Done:** schema + corruption recovery tested.

### F2 — Index synchronization engine
`area:main-process` `type:feature` · Deps: F1, W5
Launch/on-demand scans upsert/remove grant-scoped records transactionally;
cancellation; index status. App DB/journal excluded from indexing.
**Done:** add/update/remove proven consistent under interrupted scans.

### F3 — Index progress & partial-readiness contract
`area:main-process` `area:renderer` `type:feature` · Deps: F2
Progress events, per-grant partial/complete/error status, renderer
subscription, explicit `partial` marker consumable by find/chat UI.
**Done:** renderer can always answer "how fresh is this index?"

### F4 — Bounded extraction framework & parsers
`area:main-process` `type:feature` · Deps: F2, R3
One shared framework (byte/time caps, truncation, parser isolation, fallback
to metadata-only) + TXT, Markdown, PDF, DOCX adapters with fixtures for
corrupt and password-protected files.
**Done:** all four formats obey shared bounds; failures degrade safely.

### F5 — iCloud placeholder classification
`area:main-process` `type:feature` · Deps: R1, F2
Detect undownloaded placeholders; index name-only; label in UI; never hydrate.
**Done:** verified in a signed build (R1 matrix follow-up).

### F6 — Query interpretation
`area:server` `type:feature` · Deps: W8, R3
Natural query → validated filters (dates, extensions, name patterns) + search
terms; empty/ambiguous query behavior; cancellation; prompt-injection fixtures.
**Done:** typed find endpoint with payload limits, per W9's standards.

### F7 — Production FTS retrieval
`area:main-process` `type:feature` · Deps: F3, F4, F6
Grant-scoped, filter-aware candidate retrieval (top ~20) with snippets,
deterministic tie-breaking, bounded results, partial-index marker.
**Done:** meets R3's latency and recall targets on the reference corpus.

### F8 — Grounded shortlist ranking
`area:server` `type:feature` · Deps: F7, W8
LLM ranks candidates; may only return supplied IDs; match reasons grounded in
provided snippets; confidence/no-match policy; malformed-output fallback.
**Done:** adversarial snippet tests pass; ungrounded outputs rejected.

### F9 — Find request disclosure
`area:renderer` `type:feature` · Deps: S2, F8
Exact metadata/snippet counts shown before ranking transmission.
**Done:** same displayed-equals-sent guarantee as S3.

### F10 — Opaque open & reveal capabilities
`area:main-process` `type:feature` · Deps: W3, F7
`openItem` / `revealItem` main-process capabilities with grant enforcement and
missing-item handling.
**Done:** no renderer paths; unauthorized/missing items fail safely.

### F11 — Find cards & drag export
`area:renderer` `type:feature` · Deps: F8, F10
File cards: name, path display policy, date, grounded why-it-matched,
open/reveal actions, platform-correct drag-out, inaccessible-file states.
**Done:** drag into Finder/Mail works in a packaged build.

### F12 — Honest find & partial-index states
`area:renderer` `type:feature` · Deps: F3, F8, F11
Distinct states: partial index, no confident match, indexing failed,
inaccessible result, refine-query suggestion. Never fabricate a file.
**Done:** each state has distinct, tested presentation.

### F13 — Find evaluation harness
`type:test` · Deps: F8 (corpus starts during R3)
Labeled ~30-query corpus over ~5k files; reproducible top-1/top-3/no-match and
latency metrics; metadata-only and iCloud cases included.
**Done:** one command produces the metrics report.

### F14 — Best-effort filesystem watching
`area:main-process` `type:feature` · Deps: F2
Coalesced events, overflow → mark index stale (never claim correctness without
full scan), teardown on revocation/deletion.
**Done:** listed behaviors tested; explicitly not a correctness dependency.

---

## M4 — Shell, onboarding & privacy

### P1 — Grant lifecycle & revocation
`area:main-process` `type:feature` · Deps: W4, F2, F14
List/revoke grants; relocated/deleted folder handling; revocation stops
watchers, invalidates items/plans, clears or marks indexed records per
documented policy.
**Done:** every capability rejects a revoked grant, under tests.

### P2 — Local chat persistence
`area:renderer` `type:feature` · Deps: W1, W12
Sessions/messages persisted locally with schema versioning, reload/resume,
retention/deletion.
**Done:** chats survive relaunch and migrate.

### P3 — Full chat orchestration
`area:renderer` `type:feature` · Deps: P2, S7, F11
Full message lifecycle: pending/streaming/completed/failed/cancelled, retries,
structured plan/result/file-card rendering.
**Done:** defined transitions for every state; no orphaned spinners.

### P4 — Granted-folder sidebar, pins & recents
`area:renderer` `type:feature` · Deps: P1
Pins, recency ordering, persisted state, unavailable/revoked grant
presentation.
**Done:** state survives relaunch; revoked folders visibly degraded.

### P5 — Recent chats & New Chat
`area:renderer` `type:feature` · Deps: P2
Chat list, title policy, resume, delete, empty states.
**Done:** matches PRD B3.

### P6 — Folder summary view
`area:renderer` `type:feature` · Deps: F3, P4, S7
Count, types, freshness, last-sorted, reveal + "Sort this folder"; loading,
empty, error, and unavailable-grant states.
**Done:** matches PRD B2 (summary, not a file browser).

### P7 — Onboarding: sign-in & folder grants
`area:renderer` `type:feature` · Deps: W7, W4, P4
Account rationale copy ("AI requests run through Untie's servers…"), suggested
folders with iCloud caveat, grant step, skip/resume, failure recovery.
**Done:** first-run flow completable and resumable after quit.

### P8 — Onboarding: privacy & indexing readiness
`area:renderer` `type:feature` · Deps: P7, F3
Provider disclosure, what-leaves-device policy, local-only index statement,
indexing progress, partial readiness, indexing failures.
**Done:** privacy posture from PRD §8 stated plainly in-product.

### P9 — LLM request lifecycle & error mapping
`area:server` `type:infra` · Deps: W8
Timeout, cancellation/abort propagation end-to-end, offline detection, retry
classification, quota mapping, request IDs.
**Done:** every failure class deterministically mapped and testable.

### P10 — User-facing request error states
`area:renderer` `type:feature` · Deps: P3, P9
Quota exhausted, offline, timeout, cancelled, unauthorized, malformed model
response — each with explicit retry/cancel behavior; user input preserved.
**Done:** every classified failure has a distinct tested presentation.

### P11 — Delete local data
`area:main-process` `area:renderer` `type:feature` · Deps: P1, P2, F2, S8
Stop services, close handles, wipe index/extracted text/chats/journal/pins/
recents, recreate clean stores.
**Done:** verified no sensitive residue remains after wipe.

### P12 — Privacy-safe logs & crash diagnostics
`type:infra` · Deps: W2, W8, F2 (start early; release gate)
Central redaction/allowlist layer: no paths, filenames, snippets, prompts, or
raw provider payloads by default.
**Done:** automated leakage tests over real log output.

### P13 — Privacy-safe dogfood event model
`type:infra` · Deps: P12, S7, F11
Allowlisted local events (no names/paths/text) with inspection/export/delete
controls.
**Done:** event schema reviewed against P12's allowlist.

### P14 — Dogfood evaluation workflow
`type:feature` · Deps: P13
Testers label correctness, coverage, exclusions, regeneration, severe
misplacements; aggregation for PRD §10 metrics.
**Done:** one dogfood session produces the metric set.

---

## M5 — Release qualification

### Q1 — Keyboard & accessibility pass
`type:test` · Deps: S6, S10, F11, P4, P5
Pragmatic pass over safety-critical interactions: plan expansion, exclusions,
approval, warnings, progress announcements, focus restoration, chat
navigation, file-card actions.
**Done:** documented checklist passes; approval flow fully keyboard-operable.

### Q2 — Activation instrumentation & timed dogfood script
`type:test` · Deps: P8, P13
Measure install → sign-in → grant → first approved sort (<10 min target)
without sensitive telemetry.
**Done:** funnel timings collected from at least 3 fresh-machine runs.

### Q3 — Find quality gate
`type:test` · Deps: F13
Top-3 threshold met on the frozen corpus; failures categorized.
**Done:** report reviewed; go/no-go recorded.

### Q4 — Sort quality & safety gate
`type:test` · Deps: S11, P14
Controlled undo 100% under stated preconditions; precision, coverage,
acceptance, exclusion, apply-failure, and severe-error rates reported
separately (never blended).
**Done:** report reviewed against PRD §10; go/no-go recorded.

### Q5 — Privacy & security audit
`type:test` · Deps: P11, P12, P13
Recorded checklist: renderer sandboxing, IPC surface, grant boundaries,
outbound payload manifests, injection defenses, local-data deletion, log
redaction, entitlements, packaged-app behavior.
**Done:** checklist passes in the packaged app, findings filed as issues.

### Q6 — Signed release-candidate E2E
`type:test` · Deps: Q1–Q5
Full pass in the signed/notarized artifact: onboarding, partial indexing,
sort, regeneration, disclosure, apply, recovery, undo, find,
open/reveal/drag, revocation, local-data deletion.
**Done:** RC build passes the full scenario list.

---

## Critical path & parallelization

Critical path (sort loop):
`R1 → W4 → W5 → W6 → W9 → W10 → W11 → W13 → W14 → W15 → W16 → S6 → S7 → S8 → S10 → S11 → Q4 → Q6`

Parallel feeders:
- Auth/LLM: `W7 → W8 → W9`
- Find (can start before sort UI completes): `R3 → F1 → F2 → F4 → F7 → F8 → F11 → F13 → Q3`

Safe concurrent tracks:
- R1–R4 all at once (first week).
- W1/W2, W7, and R2 concurrently.
- W9 and W10 concurrently after W6.
- Journal (W14) and plan-card UI (W13) concurrently once R4 and W11 settle.
- Sidebar/chat persistence (P2, P4, P5) alongside find backend (F-track).
- P12 (privacy-safe logging) starts with infrastructure, gates release.

Issue count: 65 (4 R + 16 W + 11 S + 14 F + 14 P + 6 Q).
