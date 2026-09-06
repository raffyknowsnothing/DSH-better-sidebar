# DSH-better-sidebar handoff

Task: make the sidebar's HTML file preview work. It rendered nothing but the route's bare
`forbidden` body. Six separate defects, in two repos, all fixed. Two still need Raf's own hands:
clicking a button in the running app, and a `git push`.

## Where things are

Two repos matter and both are Raf's own forks.

- `~/00_StoryToys/02_Repos/RafDev/otherRepos/DSH-better-sidebar`, branch
  `fix/local-web-app-browser`, HEAD `31100b8`. Pushed to `origin` this session.
  `upstream` is `omdsh-dev`; [PR #548](https://github.com/omdsh-dev/DSH-better-sidebar/pull/548)
  for an earlier commit was closed by Raf on 2026-09-04 with "will not be merged upstream". This
  branch is a personal fork. Do not open upstream PRs for it unless Raf says so.
- `~/00_StoryToys/02_Repos/RafDev/otherRepos/deepseek-harness-desktop`, branch
  `RM/dsh_edits_main_20260831`, HEAD `b14db08b81`. One commit ahead, unpushed. That repo has its
  own handoff at `~/00_StoryToys/04_AgentScripts/_handoffs/dsh-desktop/handoff.md`; read it before
  touching anything else in there, and note it predates this work.

**Which app is running has changed again since the last note.** As of 2026-09-06 01:35,
`/Applications/DSH Desktop.app` is back — a fresh v2.0.4 build, copied from
`deepseek-harness-desktop/dsh-plugin-desktop/dist/mac-smoke/mac-universal/`, not from the
`dist/mac-arm64` path the previous note pointed at (that path no longer exists on disk). This is
NOT the trashed copy from 2026-09-04; it is a new one. The desktop repo has its own unrelated
work in progress on disk right now (`WorkspaceDecor.tsx`, `native-menu.ts`, two new
`.agents/notes/` design docs dated 2026-09-06 — sidebar divider colouring, a transcript context
menu). None of it is this task's; do not touch it, and do not assume the next session's desktop
build is the one this note describes.

The app resolves the sidebar plugin through a `link:` in `~/.dsh/profiles/desktop/package.json`
regardless of which app copy is running, so a `pnpm build` in THIS repo is live after a page
reload no matter what. The desktop app's own code needs
`corepack yarn build && corepack yarn package:dir` and a relaunch — but check what else is
mid-flight in that repo first; see its own handoff.

## Proven against merely written

Proven:

- 1209 unit tests pass, 9 skipped, 111 files. Typecheck clean. Production build clean. Run at the
  time of writing, against committed and pushed code.
- The ticketed preview route works end to end in a real `dsh web`:
  `tests/e2e/html-preview.e2e.ts` mounts the packed plugin, previews a page with a relative
  stylesheet that reloads itself, and asserts the text, the absence of `forbidden`, and a computed
  colour of `rgb(1, 2, 3)`. Green under `pnpm test:mount`.
- The fence tests bite. Reverting the route to the old `fence` fails 4 of them.
- The desktop fix is verified in the app by Raf: the preview now loads. That is the only
  confirmation of the desktop change against a running app; its own 1080 unit tests also pass.

Not proven:

- The sandbox toggle fix (`5f7bea9`) has never been exercised in the running app. Unit tests cover
  the URL mode segment and the conditional CSP header; nobody has clicked the button.
- Whether Raf's budget app actually works unsandboxed. Dropping the sandbox restores storage,
  because the page gets the GUI's origin. It does **not** make a fetch to a backend on another
  port work; that is still cross-origin and needs CORS. Say so rather than promising it.

## Open work

1. ~~Finish the persistence guard.~~ **Done.** `src/sidechat-routes.ts` lines 114, 186 and 377 now
   call `usablePersistence(ctx)` from `src/session-persistence.ts`; `src/index.ts`'s
   `persistedCwdOf` collapsed onto the same helper. One guard, not two. 1209 unit tests pass (was
   1208; the browser-tab fix below added one), typecheck clean, plugin rebuilt.
2. **Verify in the app.** Still open, and only Raf can do it: reload the page, open an HTML file,
   press "Temporarily disable (unsafe)" on the sandbox row, confirm the preview loads in both
   modes. Nobody has clicked the button yet.
3. **Push both repos.** About to happen this session. If a later agent reads this and it's still
   unpushed, something interrupted it, ask Raf.
4. ~~Browser tab turns an html path into an http address.~~ **Done, by Raf's decision** (route to
   the preview, don't refuse). `normalizeBrowserUrl` in `src/client/browser.ts` now recognizes a
   bare POSIX path, a Windows drive path, a UNC path, and an explicit `file:` URL, and returns a
   new `{ kind: 'local-file', path }` result instead of mangling the input into `https://…` or
   (for `file:`) refusing it outright. `BrowserView.tsx` resolves that through the same ticketed
   `/sidebar/html` route a file-tree double-click uses — same workspace fence, same sandbox toggle.
   Covered in `tests/browser.spec.ts`. Not yet exercised in the running app; verify alongside item 2.
5. **File rename reverts in edit mode.** Raf reported it. Already queued as its own background task
   (`task_2a9d3dac`) with a full brief; do not duplicate it here.

## Traps

- **`pnpm` is not on this machine's PATH.** Use `corepack pnpm`. `tests/market-manifest.spec.ts`
  shells out to a bare `pnpm` and fails without one, which looks like a real test failure and is
  not. Put a shim first on PATH before a full run: a script that execs `corepack pnpm "$@"`.
- **`tests/e2e/mount.e2e.ts` fails on this machine**, on "Side Chat tab must poll sidechat.events".
  Proven pre-existing: it fails identically on the pre-change baseline after a `git stash -u`. Not
  caused by this work. Do not chase it.
- **Quitting DSH Desktop by closing the window does not quit it.** The process survives and keeps
  port 43120, so a rebuild appears to change nothing. Confirm with
  `ps -axo pid,lstart,command | grep "Contents/MacOS/DSH Desktop"` and compare the start time
  against the build. This cost several rounds.
- **curl cannot probe the desktop app.** Every path, including `/` and paths no plugin owns,
  answers 403 `forbidden` without the Electron renderer's header. A curl probe proves nothing about
  the plugin. Proven: the gate is `DesktopWebServer.register` in the app's `lib/webserver.js`,
  wrapping every route.
- **`/sidebar/*` in the desktop app is not gated by the harness**, only by that desktop wrapper.
  The harness's own `requestRejection` covers `/api` and its channels, and answers 401 for missing
  auth, never 403. A plain-text `forbidden` therefore means the desktop gate or this plugin, not
  DSH auth.
- **The preview's own requests are indistinguishable from an attacker's by header.** An opaque
  origin sends `Sec-Fetch-Site: cross-site` with no `Origin`, or `Origin: null` for CORS-mode.
  Proven with a real Chromium run. Do not try to fix a preview 403 by relaxing the marker fence;
  that opens the route to every page in the user's browser. The ticket exists for this reason.
- **`X-Content-Type-Options: nosniff` makes the preview's content type load-bearing.** A stylesheet
  served as `application/octet-stream` is discarded by Chromium and the page renders unstyled,
  which looks exactly like the fence still blocking it. `previewTypeForPath` covers this; keep new
  asset types out of `MEDIA_TYPES`, because `/sidebar/file` is reached from the GUI's own origin
  and typing a workspace file as `text/javascript` there would let it load as a same-origin script.
- **The `sessionPersistence` face exists in shapes without `inspect`.** DSH Desktop mounts one.
  Checking for `undefined` alone throws `persistence.inspect is not a function`, surfaced as an
  opaque `internal` error. Check the method, not the service. Fixed everywhere now
  (`usablePersistence` in `src/session-persistence.ts`); this note stays as the reason, in case a
  future call site reintroduces the `undefined`-only check.

## Decisions already settled

- **The preview stays in an opaque origin by default.** It is the previewer's security boundary.
  The ticket was added so the sandbox could stay, rather than weakening the fence to let the
  preview through.
- **The ticket is per process, not per `apply()`.** A profile with `patchReload: "live"` re-applies
  the plugin, and a per-apply ticket then strands the one an already-loaded page holds, producing
  the original symptom with no way to tell them apart. See `src/html-ticket.ts`, which explains it
  at length.
- **The sandbox mode rides the URL path**, beside the ticket, because a relative asset must resolve
  onto a URL that still names the same mode. A query would be dropped by relative resolution. The
  decoder refuses an unknown mode rather than defaulting, because a default guesses the page's
  origin policy.
- **The desktop fix keys on the frame's parent and document, never on its origin.** An opaque frame
  has no origin to offer. A frame holding another site keeps that site's real origin, so it never
  reaches the relaxed path. See the commit body on `b14db08b81`.
- **`docs/plans/2026-09-04-html-preview-ticket-design.md`** records the first two fixes in Chinese,
  matching the other 30-odd design docs in that folder. It predates commits `3366ffb` and
  `5f7bea9`, so its test counts are stale. Update it or note the drift when the work lands.
- The two temp files the previous session left (`tests/e2e/tmp-html-forbidden.e2e.ts`,
  `tests/tmp-origin-probe.mjs`) were deleted. The e2e became
  `tests/e2e/html-preview.e2e.ts`; the probe's findings live in the header comment of
  `tests/html-preview-fence.spec.ts`.

## Also noticed, not fixed

`dsh-plugin-desktop/tests/client-directory-picker-browse-patch.spec.ts` in the desktop repo reads a
patch file pinned to `0.1.2-alpha.1`. The patches on disk are all `alpha.5`, so the suite fails.
Leftover from the alpha.5 migration; one version string. Raf was told and has not asked for it.
