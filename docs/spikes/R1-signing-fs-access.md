# R1 — Signed & notarized filesystem-access spike

> Status: **BLOCKED — needs human with Apple Developer credentials + a physical
> Mac session.** The reusable deliverables (entitlements, signing/notarization
> config, the decision framework, and the exact test procedure) are committed on
> this branch. The access **matrix results** — the actual deliverable — can only
> be produced by running a signed, notarized build on a real Mac and interacting
> with the TCC prompts, iCloud, and revocation UI by hand. See
> [What Gabriel must do](#what-gabriel-must-do) at the bottom.

Related plan issue: **#3 (R1)**, milestone M0. Downstream dependent: **W4**
(folder picker & persistent grants) — it should not start until the entitlements
question below is resolved by a real run.

---

## 1. Objective (from the issue)

Build a signed, notarized DMG (hardened runtime + entitlements) and test folder
access against a pass/fail matrix: Downloads, Desktop, Documents, an external
folder, an iCloud-managed folder, relaunch persistence, revocation, and
security-scoped bookmark restoration. Record whether placeholder inspection
triggers iCloud downloads.

**Done** = matrix results + final entitlements + known limitations documented.
"A DMG was produced" is explicitly *not* done.

---

## 2. The decision this spike exists to make: sandbox or not

For a filesystem-heavy utility, the single most consequential choice is whether
the app runs under the **macOS App Sandbox**. It changes what "grant a folder"
even means. There are two viable architectures for a notarized DMG shipped
**outside** the Mac App Store:

| | **Option A — Non-sandbox (TCC-gated)** | **Option B — App Sandbox** |
|---|---|---|
| App Sandbox entitlement | off | `com.apple.security.app-sandbox` |
| Filesystem reach | Full user-level FS; special folders (Desktop/Documents/Downloads/iCloud/removable/network) gated by **TCC** consent prompts | **Only** what the user picks in `NSOpenPanel` (`files.user-selected.read-write`) |
| How a grant persists across relaunch | TCC remembers the grant keyed to the code signature; the app just re-remembers the **path** | App must save an **app-scoped security-scoped bookmark** and call `startAccessingSecurityScopedResource()` each launch (`files.bookmarks.app-scope`) |
| Security-scoped bookmarks available? | No (and not needed) | **Yes — this is the only way to get them** |
| Granularity | Per **category** (granting "Documents" grants *all* of Documents) | Per **user-selected folder** (tighter least-privilege) |
| Electron friction | Low — well-trodden path | **High/uncertain** — helper processes, native modules, and library validation frequently need extra work; this is the risk the spike must retire |
| Mac App Store later | Would need migration | Already compatible |

**Why this matters for the plan:** the W4 definition of done says
*"security-scoped bookmark persistence, relaunch restoration."* App-scoped
security-scoped bookmarks (`URL.bookmarkData(options: .withSecurityScope)` +
`startAccessingSecurityScopedResource`) **only exist under the App Sandbox.**
So W4 as written implies **Option B**.

**Flagged conflict / clarification for Gabriel (not re-litigated in code):**
PRD §7.5 says "the **sandboxed renderer** never gets generic primitives" — that
is the *Electron renderer sandbox* (`webPreferences.sandbox: true`, already
enabled in `electron/main.cjs`), which is unrelated to the *macOS App Sandbox*.
The two "sandboxes" are different things. W4's "security-scoped bookmark"
wording is the only signal that points at the macOS App Sandbox. Before W4 is
implemented we need a decision:

- **If we adopt Option B (App Sandbox):** the security-scoped-bookmark plan
  stands, but the spike must first prove Electron launches, runs its helpers,
  and survives relaunch bookmark restoration under the sandbox. This is the
  higher-risk path and the reason R1 is a week-one gate.
- **If the spike shows Option B is impractical with our Electron version:**
  fall back to **Option A**, and W4's "security-scoped bookmark persistence"
  becomes "TCC-backed persistence + a saved canonical path" (functionally the
  same user experience: grant survives relaunch; unavailable grants are
  surfaced, not silent). This would be a wording change to W4, not a change to
  the product promise.

**Recommendation to start:** build **Option A first** (it will almost certainly
sign, notarize, and launch), use it to fill every matrix row that is not
bookmark-specific, then rebuild with **Option B** to fill the
bookmark-restoration row and confirm Electron survives the sandbox. Ship the
option that passes the whole matrix; default the repo to A until B is proven.

---

## 3. Final entitlements (committed on this branch)

Distribution is a **notarized DMG**, so **Hardened Runtime is mandatory** and
Gatekeeper assessment is disabled during build (`gatekeeperAssess: false`).

- `build/entitlements.mac.plist` — **default, Option A (non-sandbox).** Only the
  Electron/Hardened-Runtime minimum: `cs.allow-jit`,
  `cs.allow-unsigned-executable-memory`, `cs.disable-library-validation`,
  `cs.allow-dyld-environment-variables`. No filesystem entitlements — TCC
  governs access at runtime.
- `build/entitlements.mac.sandbox.plist` — **Option B (App Sandbox).** Adds
  `app-sandbox`, `files.user-selected.read-write`, `files.bookmarks.app-scope`
  on top of the Hardened-Runtime minimum.
- `build/entitlements.mac.inherit.plist` — child/helper-process inheritance,
  used **only** with Option B as electron-builder `entitlementsInherit`.

`electron-builder.yml` (mac section) wires Option A by default, enables
`hardenedRuntime: true`, `notarize: true`, and declares the TCC purpose strings
(`NS*FolderUsageDescription`) that appear in the consent dialogs. To test
Option B, point both `entitlements` and `entitlementsInherit` at the sandbox /
inherit plists and rebuild.

TCC purpose strings currently declared (edit copy as needed):
`NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`,
`NSDownloadsFolderUsageDescription`, `NSRemovableVolumesUsageDescription`.

---

## 4. The access matrix (the deliverable — fill on a real signed run)

Run each row twice where noted: once on an **Option A** build, once on an
**Option B** build. `Result` ∈ {PASS, FAIL, N/A}. Record the observed behavior,
any TCC dialog text, and Console.app / unified-log denials
(`log stream --predicate 'subsystem == "com.apple.TCC"'`).

| # | Scenario | What "PASS" means | A result | B result | Notes |
|---|----------|-------------------|:--------:|:--------:|-------|
| 1 | Grant **Downloads** via picker, scan top-level | Scan lists files; no unexpected denial | _TBD_ | _TBD_ | |
| 2 | Grant **Desktop**, scan | Same | _TBD_ | _TBD_ | Often iCloud-managed — see #9 |
| 3 | Grant **Documents**, scan | Same | _TBD_ | _TBD_ | Often iCloud-managed — see #9 |
| 4 | Grant an **external volume** folder (USB/SSD) | Scan works; volume-eject handled | _TBD_ | _TBD_ | `NSRemovableVolumesUsageDescription` |
| 5 | Grant an **iCloud-managed** folder | Scan lists names; behavior of placeholders recorded | _TBD_ | _TBD_ | See #8/#9 |
| 6 | **Relaunch persistence** — quit & reopen, re-access a granted folder | Access still works with **no** re-prompt | _TBD_ | _TBD_ | A: TCC-persisted; B: bookmark-restored |
| 7 | **Revocation** — remove access (System Settings ▸ Privacy for A; delete saved bookmark / revoke for B), then re-access | App reports **unavailable grant** cleanly; no crash, no silent empty scan | _TBD_ | _TBD_ | PRD: "surfaced, not silent" |
| 8 | **Security-scoped bookmark restoration** | After relaunch, bookmark resolves and `startAccessingSecurityScopedResource()` returns true | N/A | _TBD_ | **Option B only** — the row that decides A vs B |
| 9 | **Placeholder inspection → iCloud download?** — `stat`/name-list vs. open/read on a dataless iCloud file | Metadata/name listing does **NOT** trigger a download; only explicit read does | _TBD_ | _TBD_ | PRD §11: v1 must treat placeholders as name-only and never download |

### 4.1 How to run each row

Prereq: a signed **and notarized** build (unsigned/ad-hoc builds give
misleading TCC behavior — TCC keys grants to a stable signature).

1. **Build & notarize** (see §6), then `open release/*.dmg`, drag to
   `/Applications`, launch from there (not from the DMG mount).
2. **Rows 1–5 (grant + scan):** use the folder picker to select each target;
   accept the TCC prompt; confirm a top-level scan returns entries. Note the
   exact prompt wording and whether a prompt appeared at all.
3. **Row 6 (relaunch):** `Cmd-Q`, relaunch, re-trigger access to the same
   folder. PASS = works with no new prompt.
4. **Row 7 (revocation):**
   - Option A: System Settings ▸ Privacy & Security ▸ Files and Folders (and/or
     Full Disk Access) → toggle Untie off; or `tccutil reset All com.sortbox.untie`.
   - Option B: remove the saved app-scoped bookmark from the app's data dir.
   - Re-access and confirm the app surfaces an "unavailable grant" state.
5. **Row 8 (bookmark restore, B only):** confirm the saved bookmark resolves on
   next launch and access is regained without a picker.
6. **Row 9 (iCloud placeholder):** in an iCloud-Optimized folder, right-click a
   file ▸ "Remove Download" to force a dataless placeholder. Then:
   - list/`stat` it (name + size only) and watch for a download (progress in
     Finder, network activity, `brctl log --wait`),
   - separately, open/read it and confirm *that* triggers the download.
   Use `URLResourceValues` (`isUbiquitousItem`,
   `ubiquitousItemDownloadingStatus`) semantics as the reference for
   "inspect without materializing." In Node terms: `fs.stat` must not
   materialize; `fs.readFile`/`open`+read will.

---

## 5. Known limitations & gotchas (record confirmations/refutations during the run)

- **App Sandbox + Electron is the real risk.** Helper (GPU/renderer/utility)
  processes must be signed with the inherit entitlement; unsigned native
  addons (e.g. a future `better-sqlite3`) need
  `cs.disable-library-validation`; some Electron versions need
  `allow-unsigned-executable-memory`. If Option B won't launch or won't restore
  bookmarks, that is a **valid go/no-go result** pointing to Option A.
- **TCC granularity (Option A):** granting Desktop/Documents/Downloads grants
  the *entire* category, not just the sub-folder the user picked. The
  grant-boundary enforcement (W3) still restricts what Untie *acts on*, but the
  OS-level permission is coarse. Worth stating in onboarding.
- **Notarized ≠ signed-only.** TCC persistence and Gatekeeper both depend on a
  stable Developer ID signature; test the notarized artifact, not a dev build.
- **iCloud "local-only" tension (PRD §11):** the product promise is that
  placeholders are name-only and never downloaded. Row 9 is the empirical check
  that our scan path (`fs.stat`, `readdir`) honors this. If any metadata call
  materializes files, the scan contract (W5) must switch to the dataless-aware
  APIs before indexing iCloud folders.
- **Provisioning profile:** Developer-ID + App Sandbox generally does *not*
  need a provisioning profile (that's a Mac App Store concern), but if the run
  hits a profile-required error under Option B, capture it here.

---

## 6. Build & notarize procedure (for the human run)

```bash
# 0. One-time: Xcode command line tools + a "Developer ID Application" cert in the
#    login keychain (Apple Developer account required).

# 1. Provide credentials via environment (electron-builder auto-detects notarize):
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com ▸ App-Specific Passwords
export APPLE_TEAM_ID="XXXXXXXXXX"
#    …or the App Store Connect API key trio:
# export APPLE_API_KEY="/path/AuthKey_XXXX.p8"
# export APPLE_API_KEY_ID="XXXXXXXXXX"
# export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# 2. Build, sign, notarize, staple → release/*.dmg  (Option A / default)
bun run desktop:dist

# 3. Verify
spctl -a -vvv -t install "release/"*.dmg      # or the .app inside /Applications
codesign -dv --verbose=4 "/Applications/Untie.app"
stapler validate "release/"*.dmg

# 4. To test Option B, edit electron-builder.yml:
#      entitlements: build/entitlements.mac.sandbox.plist
#      entitlementsInherit: build/entitlements.mac.inherit.plist
#    then repeat steps 2–3 and fill the "B result" column.
```

`bun run desktop:pack` (`--dir`, unsigned) is useful for a quick launch check
but is **not** valid for the TCC/notarization matrix rows.

---

## What Gabriel must do

Everything below requires an Apple Developer account and a physical Mac session;
none of it can be produced by an automated agent in this environment.

1. **Provide signing identity:** enroll/confirm the Apple Developer Program and
   install a **"Developer ID Application"** certificate in the login keychain.
2. **Provide notarization credentials:** either an app-specific password
   (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`) or an App
   Store Connect API key (`APPLE_API_KEY` + `APPLE_API_KEY_ID` +
   `APPLE_API_ISSUER`).
3. **Run the builds:** `bun run desktop:dist` for Option A; then swap to the
   sandbox entitlements (§6 step 4) and rebuild for Option B.
4. **Prepare test fixtures:** an external USB/SSD volume, and an
   iCloud-Optimized Desktop/Documents (or a dedicated iCloud Drive folder) with
   at least one file forced to a dataless placeholder ("Remove Download").
5. **Fill the matrix (§4)** by hand on the notarized build and record TCC dialog
   text + any Console/`log` denials.
6. **Decide A vs B** from the results — specifically whether Electron survives
   Option B and whether row 8 (bookmark restoration) passes — and tell the team
   so **W4** can proceed with the confirmed model (and W4's wording updated if we
   land on Option A).
7. If any product-level surprise appears (e.g. metadata calls materialize iCloud
   files, or TCC coarseness is unacceptable), flag it against PRD §7/§11 rather
   than working around it in code.
