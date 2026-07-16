---
description: Dispatch ready Untie v1 issues to Codex (logic) and Claude (UI) workers; ship tested, reviewed PRs that close them. Designed to run repeatedly via /loop with minimal main-session context.
---

You are the top-level loop for the Untie v1 overnight build. Your ONLY job in
this session is to spawn ONE dispatcher subagent per invocation and relay its
compact report. Do NOT read issue bodies, diffs, or code in this session — all
heavy context must live and die inside subagents.

Spawn a single `general-purpose` Agent (run_in_background: false) named
`dispatcher` with exactly the mission below, then relay its report to the user
verbatim (≤15 lines). That is the entire invocation.

---

## Dispatcher mission

You are the dispatcher for the Untie v1 build. Repo: `/Users/sobsh/dev/sortbox/untie`
(GitHub `sort-box/untie`). Plan: `docs/github-issues.md`, product truth:
`docs/PRD.md`, conventions: `AGENTS.md`. Quality gate for every change:
`bun run typecheck && bun run check && bun run test`.

### 1. Pick work
- `git -C /Users/sobsh/dev/sortbox/untie fetch origin && git worktree prune`
- Run `scripts/ready-issues.sh` → ready issues (deps closed, no status label),
  already in priority order.
- Count active worktrees in `/Users/sobsh/dev/sortbox/untie-worktrees/`.
  Concurrency cap: 3 total. Pick up to (3 − active) issues from the top of the
  ready list. If none are ready and none are active, report "ALL DONE or all
  blocked" with the list of `status:needs-human` issues and stop.
- For each picked issue: `gh issue edit N --add-label status:in-progress`.

### 2. Set up isolation (per issue)
```
git -C /Users/sobsh/dev/sortbox/untie worktree add \
  /Users/sobsh/dev/sortbox/untie-worktrees/issue-N \
  -b issue/N-<code> origin/main
cd .../issue-N && bun install && cp /Users/sobsh/dev/sortbox/untie/.env.local .env.local
```

### 3. Dispatch by model (Gabriel's routing rule)
- **Codex (GPT-5.6 Sol) — all logic**: any issue labeled `area:main-process`,
  `area:server`, `type:infra`, `type:test`, or a logic spike (R2, R3).
- **Claude subagent — all UI/UX**: issues labeled `area:renderer` only, plus
  `type:design` docs (R4) and any user-facing copy.
- **Mixed (`area:renderer` + main-process/server, e.g. S5, S10, P11, F3)**:
  Codex implements the logic first on the branch, then a Claude subagent
  implements the renderer/UI part on the same branch.
- **R1 (signing spike)**: attempt config/entitlements/docs; anything requiring
  Apple credentials that are absent → do what's possible, then mark
  `status:needs-human` with a comment listing exactly what Gabriel must do.

**Codex worker** (run from the worktree, background it and poll; allow up to
~30 min):
```
codex exec --ephemeral --skip-git-repo-check --sandbox workspace-write -C <worktree> "<PROMPT>"
```
PROMPT template: "Read AGENTS.md and docs/PRD.md. Run `gh issue view N` for
your task. Implement issue #N (<code> — <title>) to its Definition of Done,
including its tests in this same change (see docs/github-issues.md).
Follow existing code conventions. Run `bun run typecheck && bun run check &&
bun run test` and iterate until all pass. Commit everything with message
'<code>: <title> (#N)'. Do not touch files unrelated to this issue."

**Claude worker**: spawn a `general-purpose` Agent with the same template
(adapted), working directly in the worktree.

### 4. Review gate (Claude reviews Codex, per Gabriel)
For every Codex-authored branch, spawn a fresh Claude `general-purpose` Agent:
"Adversarially review `git diff origin/main...HEAD` in <worktree> for issue #N
against its Definition of Done and docs/PRD.md safety requirements (opaque IDs,
no path capabilities in renderer, never overwrite/delete). Verdict: APPROVE,
FIX (with precise fixes), or BLOCK (with reasons)."
- FIX → apply the fixes (one Codex follow-up call, or directly if trivial),
  re-run the quality gate, re-review once.
- BLOCK twice → push branch, open PR as **draft**, comment the findings on the
  issue, swap `status:in-progress` → `status:needs-human`, clean up the
  worktree, move on.

### 5. Ship
Only when the quality gate is green AND review is APPROVE:
```
git pull --rebase origin main   # re-run quality gate if the rebase changed anything
git push -u origin issue/N-<code>
gh pr create --title "<code>: <title>" --body "<summary>\n\nTest evidence: <one line>\n\nCloses #N"
gh pr merge --squash --delete-branch
git worktree remove <worktree>
```
Merging closes the issue automatically, which unblocks dependents
(`ready-issues.sh` only considers open issues, so stale labels on closed
issues are harmless). If the rebase conflicts: resolve if trivial, otherwise
draft-PR + `status:needs-human` as above.

### 6. Failure policy
Any worker that errors out, times out twice, or can't get the gate green:
comment the state honestly on the issue, label `status:needs-human`, remove
the worktree (keep the pushed branch if it has value). NEVER merge red or
unreviewed logic. NEVER force-push, never push directly to main.

### 7. Report (your final message — keep it ≤15 lines)
One line per issue touched: `#N <code> — merged PR #X` / `needs-human: <short
reason>` / `still running`. Plus one line: `ready-next: [...]` and one line of
quota/anomaly warnings if any.
