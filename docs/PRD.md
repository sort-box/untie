# Untie — Product Requirements (v1 Prototype)

> Status: v1 scope agreed (Gabriel × Claude × Codex, 2026-07-15)
> Decisions locked: chat shell + plan cards · full semantic find · metadata + text
> extraction · sort into new AND existing top-level folders · no cloud connectors.

## 1. One-liner

**Untie sorts your files.** A macOS desktop app with a ChatGPT-style interface
where your messy folders get organized by AI — and where you can ask for any
document instead of hunting for it yourself.

## 2. Vision vs. v1

The long-term vision (see `Untie_Executive_Summary.pdf`) is a **command layer above
all storage**: one intelligent system across local drives, Google Drive, Dropbox,
OneDrive, and email attachments — unified view, smart rules learned from behavior,
cloud agnostic. "The market has solved *where* to store files; it has not solved
*how to store and sort them*."

**v1 proves the core loop on local folders only.** If Untie can't delight a user
sorting and finding files in their local Downloads folder, connecting five clouds
won't save it. Cloud connectors, cross-storage dedup/version reconciliation, and
learned smart rules are roadmap, not v1.

## 3. Problem

People accumulate files faster than they organize them. Downloads, Desktop, and
Documents become junk drawers. The pains v1 attacks locally:

1. **"My folders are a mess"** — organizing is tedious, so nobody does it.
2. **"Where is that file?"** — finding a document means remembering filenames or
   paths that were never meaningful in the first place.

Deferred pains (need cloud connectors): fragmented storage across services,
cross-service version confusion, inconsistent per-cloud folder logic.

Existing tools fail because they either require manual effort (Finder, Hazel
rules) or are answer-blind (Spotlight can match content but can't answer "my
internship contract from last year").

## 4. Target user (v1)

One persona: **a student or knowledge worker on macOS** with a messy
Downloads/Desktop/Documents, comfortable installing an app and signing in.
Not targeting: teams, enterprises, Windows/Linux, mobile.

## 5. Product shape

A macOS desktop app (Electron) that looks and feels like ChatGPT:

- **Sidebar**: granted folders (pinnable, recents), recent chats, "New chat".
- **Main pane**: a chat. You talk to Untie about your files.
- **Plan cards**: structured, interactive UI rendered *inside* the chat. The
  chat never shows raw move lists as text (see §7.3 — this is the answer to
  approval fatigue).

Two hero capabilities:

| Intent | Example | What happens |
|---|---|---|
| **Sort** | "Sort my Downloads" | Untie scans the folder, proposes a plan (new/existing subfolder destinations), renders a reviewable plan card, user approves, files move. Undoable. |
| **Find** | "The PDF about my apartment lease" | Untie searches the local index (metadata + extracted content), LLM ranks candidates, returns file cards with open / reveal in Finder / drag out. |

## 6. User stories (v1 scope)

### Onboarding
- U1. I sign in (Clerk) and grant Untie access to one or more folders via the
  system folder picker. Suggested defaults: Downloads, Desktop, Documents —
  with an explicit iCloud caveat (see §9.6).
- U2. Sign-in is explained in-product: "AI requests run through Untie's servers
  with a usage allowance — that's why you need an account."
- U3. Untie indexes granted folders with visible progress; I can chat before
  indexing finishes (answers clearly labeled as partial until done).

### Sorting
- S1. I ask "sort my Downloads" (or click "Sort" on a sidebar folder) and get a
  **plan card**: summary first ("42 files into 6 folders"), grouped by
  destination, expandable to the complete file list. No hidden moves.
- S2. I can **exclude** files/groups and **regenerate** the whole plan
  (optionally with an instruction: "keep installers separate"). No arbitrary
  drag-and-drop plan editing in v1 — if plans routinely need manual repair,
  the model is failing and we want to see that signal.
- S3. The approval button states exactly what will happen: *"Create 4 folders
  and move 42 files within Downloads. Nothing will be renamed, overwritten,
  or deleted."*
- S4. On approval, files move with progress; a result summary lands in chat.
- S5. I can **undo** the last sort. Guarantee (honest version): *immediate undo
  restores every file whose original location is still available; conflicts
  are surfaced and never overwritten.*
- S6. Untie never deletes, never renames files (v1), never overwrites, and
  never touches folders I haven't granted.

### Finding
- F1. I ask for a document in natural language and get ranked file cards with
  name, path, date, and *why it matched* (snippet or reason).
- F2. From a file card I can open the file, reveal it in Finder, or drag it
  into another app.
- F3. If nothing matches confidently, Untie says so honestly and suggests how
  to refine — it never fabricates a file.

### Sidebar
- B1. I see granted folders; I can pin favorites; recents surface automatically.
- B2. Clicking a folder shows a lightweight summary (count, types, last sorted)
  and a "Sort this folder" button — *not* a full file browser; "Reveal in
  Finder" covers browsing.
- B3. Recent chats are listed and resumable (stored locally in v1).

## 7. How it works

### 7.1 Local index (needed for full semantic find)
- SQLite (+ FTS5) in the Electron main process: file metadata (name, path,
  extension, size, created/modified) plus extracted text for common types
  (pdf, docx, txt, md). The index never leaves the machine.
- Extraction is bounded: per-file size caps and parser timeouts; corrupt or
  password-protected files are indexed by metadata only; iCloud placeholder
  files that aren't downloaded are indexed name-only and labeled as such.
- Freshness: full scan at launch and on demand (before any sort); filesystem
  watching is best-effort, not a correctness requirement. The app's own
  database and journal are excluded from indexing.

### 7.2 Find pipeline
1. LLM interprets the query → structured filters (name patterns, extensions,
   date ranges) + search terms.
2. Local FTS retrieval over the index → top ~20 candidates.
3. LLM ranks the shortlist using filenames, metadata, and short snippets →
   ranked file references with match reasons.
4. Only the query, candidate metadata, and those snippets leave the machine —
   never the whole index.

### 7.3 Sort pipeline
1. On-demand scan of the selected folder (top-level regular files only).
2. Each file gets an **opaque ID**. The LLM receives IDs + metadata (+ extracted
   text snippets where available) and returns a typed plan via `generateObject`:
   category folders (new, or existing top-level subfolders) and an ID→category
   mapping. The model never authors raw filesystem paths.
3. A **deterministic validator** — independent of the model — rejects unknown
   IDs, duplicate assignments, path escapes, invalid names, and all collisions
   (including case-only and Unicode-normalization collisions). Approval is
   blocked until every operation is valid or excluded.
4. The plan card renders progressively: summary → groups with representative
   examples → expandable full list; low-confidence items are flagged.
5. Approval binds to an immutable, validated plan snapshot. Any edit or
   detected filesystem change invalidates and revalidates.
6. **Apply**: every source is revalidated immediately before the first move
   (precondition snapshot: canonical path, size, mtime). Execution writes a
   durable write-ahead journal with explicit states (`prepared`, `applying`,
   `applied`, `rolling_back`, `rolled_back`, `needs_attention`) so a crash
   mid-apply recovers cleanly on next launch. A failed operation mid-plan
   surfaces as `needs_attention` — no silent partial success.
7. **Undo** replays the journal in reverse deterministically. It never
   overwrites, and removes only folders it created that are still empty.

### 7.4 Sort boundary (v1)
- Scope: top-level regular files of the selected folder.
- Destinations: newly created subfolders AND existing top-level subfolders.
- Contents of existing subfolders are never reorganized.
- Skipped always: hidden files/dotfiles, symlinks/aliases (never followed),
  package bundles (`.app`, `.photoslibrary`, document bundles — treated as
  atomic and left in place), temporary/partial downloads, the app's own data.
- Operations: create folder + move only. No rename, no delete, no overwrite.

### 7.5 Platform plumbing
- All file access lives in the Electron main process behind **capability-
  oriented IPC** — the sandboxed renderer never gets generic primitives like
  `move(src, dst)` or `read(path)`. Surface: `selectFolder()`,
  `scanFolder(grantId)`, `queryIndex(...)`, `preparePlan(grantId, ops)`,
  `applyPlan(planId)`, `undo(operationId)`, `revealItem(itemId)`,
  `openItem(itemId)`. Main process resolves opaque IDs to canonical paths and
  enforces grant boundaries (canonicalized, symlink-safe — not string-prefix
  checks) on every call.
- LLM calls go through the existing usage-limited OpenRouter service (weekly
  token quotas per account via Convex). The UI has explicit states for quota
  exhausted, offline, timeout, and cancellation.
- Extracted document text and filenames included in prompts are **untrusted
  data, not instructions** (prompt injection defense): content is structurally
  delimited, and the validator rejects any operation not grounded in scanned
  file IDs regardless of what the model says.

## 8. Guardrails, privacy & trust

- Untie only reads folders the user explicitly granted; grants are revocable.
- Untie never deletes, never renames (v1), never overwrites.
- Every AI-proposed change is previewed and requires explicit, specific
  approval (exact counts and mutation types). No auto-apply in v1.
- **Per-request disclosure**: before a sort or find runs, the UI states what
  leaves the device, e.g. "This will send 84 filenames + metadata and content
  snippets from 12 documents to the AI." Filenames are treated as sensitive —
  they can reveal health, legal, and financial matters.
- The index, extracted text, chat history, and journal are stored locally in
  the app's data directory; "Delete my local data" wipes all of it. Logs and
  crash reports contain no paths, filenames, or document text by default.
- Onboarding states the privacy posture plainly: which provider receives data,
  that the full index never leaves the machine, and what a request sends.
- **Heavy warning on risky sorts**: sorting a folder that is absurdly large
  (file count / total size over a threshold) or looks like a code project or
  tool-managed directory (`.git`, `node_modules`, Xcode project) triggers a
  prominent warning the user must explicitly acknowledge. Warn, don't refuse.
- A caveat users must see: moving files can break things Untie can't see
  (project imports, app recent-file references, sync/backup expectations).
  V1 mitigates by skipping code-project folders it detects (e.g. a `.git`
  presence check) and warning on suspicious folders.

## 9. Explicitly out of scope for v1

1. **Cloud storage connectors** (Google Drive, Dropbox, OneDrive) and email
   attachments — confirmed deferred by Gabriel; this is the v2+ differentiator.
2. Automatic/scheduled sorting, rules engine, sort-on-arrival.
3. Duplicate detection, tagging, embeddings/vector search (FTS5 + LLM ranking
   only in v1).
4. File renaming as part of sort plans.
5. Full file browser in-app (Finder does this).
6. Arbitrary plan editing (drag files between proposed folders).
7. Windows/Linux builds, mobile, multi-user/shared folders.
8. OCR of images and scanned PDFs (image files are indexed by name only).
9. Chat history sync via Convex (local-only in v1).

## 10. Success criteria (prototype)

Measured separately — a single blended number can hide catastrophic moves:

- **Activation**: install → signed in → first sorted folder in under 10 minutes.
- **Move precision**: % of proposed moves judged correct by the user (dogfood
  panel), tracked apart from coverage (% of files the plan placed at all).
- **Acceptance**: % of plans approved without regeneration; manual exclusion
  rate per plan.
- **Severity**: count of high-severity misplacements (wrong file into a
  misleading folder) — target ~0; this is tracked, not averaged away.
- **Safety**: apply failure rate; undo success under the stated preconditions
  (100% in controlled/automated tests).
- **Find quality**: right document in the top 3 cards for a labeled query set
  (~30 real queries) over a ~5k-file corpus.

## 11. Known risks (accepted with eyes open)

- **Full semantic find is the largest engineering item in v1** (Codex
  recommended cutting it; Gabriel chose to keep it — it's core to the vision).
  De-risked by: FTS5 instead of embeddings, bounded extraction, LLM used only
  to interpret queries and rank shortlists.
- **Signing/notarization is an early spike, not endgame polish** — Gatekeeper,
  hardened runtime, and entitlements materially change folder access behavior
  for a filesystem-heavy app. Build and test a signed DMG in week one.
- **iCloud-managed Desktop/Documents**: on many Macs these are cloud-synced;
  v1 treats placeholder files as name-only and never triggers downloads. This
  is the one place "local-only" meets cloud reality.

## 12. Resolved decisions & remaining tuning

1. **Monetization (resolved)**: the prototype is free for testers; the weekly
   token quota exists purely as cost control, not as a pricing experiment.
2. **Risky folders (resolved)**: warn heavily — never hard-refuse — before
   sorting absurdly large folders or tool-managed/code-project folders. The
   user must explicitly acknowledge the warning to proceed.
3. Model choice per task (cheap model for query interpretation, stronger model
   for plan generation) — tune during dogfooding.
