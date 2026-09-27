# Codex CLI hooks

Two hooks that connect a Codex CLI session to your Second Brain: one recalls
project context when a session opens, one saves the tail of the conversation
when it closes.

They are independent of the MCP server. Use either, or both.

Codex sessions: saves the last few turns of each session to your brain. You can forget any captured session. Turn off any time.

## What the hooks do

| Event | Action | Cost |
|---|---|---|
| `SessionStart` | `GET /recall` and `GET /brief` for this project, prints memories and a compact attention brief | two parallel reads |
| `SessionEnd` | dispatches a detached worker that reads the transcript and, if there is enough conversation, calls `POST /capture` with the last few user turns | one capture (embedding + often a model call), off the hook's own clock |

`resume` and `fork` are skipped on start: those transcripts already contain the
earlier injection. `compact` is not skipped, since compaction discards it. On
`startup` and `clear` the printed block is cached under
`$XDG_CACHE_HOME/second-brain/session-codex-<session_id>.txt`
(`~/.cache/…` by default) so a rerun after compaction re-emits it instead of
paying for another recall.

A session is captured **at most once, ever**, no matter how many of Codex's
four documented `SessionEnd` reasons (`close`, `archive`, `delete`, `idle`)
actually fire for it - the first one that succeeds sets a marker and every
later one is a no-op.

## The 1-3s SessionEnd problem

Codex's `SessionEnd` hook is documented with a 1s default timeout and a 3s
max - nowhere near enough to read a transcript, embed it and wait on a model
call. So `session-end.js` does almost nothing: it reads stdin, checks that a
transcript path exists and that capture is not disabled, then spawns
`capture-worker.js` as a **detached, unref'd** child process and exits. The
worker is not on that clock; it gets a 20s budget of its own to do the actual
work.

The worker reads the transcript only when its real path (after resolving `..`
and every symlink) is inside `$CODEX_HOME/sessions/` (default
`~/.codex/sessions/`), where Codex writes its rollout files. A path anywhere
else, or a symlink pointing out of that directory, is refused and nothing is
sent.

**This split is UNVERIFIED against a real Codex CLI install.** Whether Codex
actually lets a detached, unref'd child outlive the parent hook process once
Codex reaps it (rather than killing the whole process group) has not been
tested against the real CLI. See "Unverified" and the smoke-test list below.

## Install, upgrade, check, uninstall

```bash
bash install.sh https://your-worker.workers.dev your-token   # install or upgrade
bash install.sh                                              # reuse existing credentials, or prompt
bash install.sh --check                                      # prove the hooks reach the Worker
bash install.sh --uninstall                                  # remove only our entries
```

PowerShell, for Windows without Git Bash - same behaviour, same guarantees:

```powershell
.\install.ps1 -WorkerUrl https://your-worker.workers.dev -Token your-token
.\install.ps1            # reuse existing credentials, or prompt
.\install.ps1 -Check
.\install.ps1 -Uninstall
```

Re-running is safe: the installer replaces its own entries in
`~/.codex/hooks.json` and preserves everything else. It refuses to write a
hooks file that is not valid JSON rather than overwriting it.

**Restart any session that is already open.** Codex CLI reads its hook config
at startup, so a running session keeps the old wiring.

### What gets written to `~/.codex/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/codex-cli-hooks/session-start.js\"" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/codex-cli-hooks/session-end.js\"", "timeout": 3 }] }
    ]
  }
}
```

### Project-level install (not written by install.sh)

Codex CLI also reads a project-level `.codex/hooks.json` (same shape as
above, scoped to one checkout). `install.sh`/`install.ps1` only ever write the
user-level file; to install at the project level instead, copy the relevant
block above into `.codex/hooks.json` at your repo root, with paths pointed at
this checkout of `codex-cli-hooks/`.

### `config.toml` inline alternative

Codex CLI is also documented as accepting hooks declared inline in
`~/.codex/config.toml` (or a project `.codex/config.toml`) rather than in a
separate `hooks.json`. This adapter does not write TOML - if you prefer that
route, add something in the shape of:

```toml
[[hooks.session_start]]
command = ["node", "/path/to/codex-cli-hooks/session-start.js"]

[[hooks.session_end]]
command = ["node", "/path/to/codex-cli-hooks/session-end.js"]
timeout_s = 3
```

Table and key names above (`hooks.session_start` vs `hooks.SessionStart`,
`command` as an array vs a string, `timeout_s` vs `timeout`) are a best
guess, not a verified schema - check your installed Codex CLI's own
documentation before relying on this snippet. The unit, though, is not a
guess: Codex's hooks.json reference documents this field in seconds, not
milliseconds (a review caught an earlier version of this file asking for a
3,000-second timeout).

## Where credentials live

`~/.config/second-brain/config.json` (mode 600) - the same file the CLI, the
desktop app and every other adapter use:

```json
{ "workerUrl": "https://your-worker.workers.dev", "authToken": "…" }
```

Nothing is written into `hooks.json` and nothing is passed on the hook command
line, so the token never appears in Codex CLI's config or in `ps`.
`SECOND_BRAIN_URL` and `SECOND_BRAIN_TOKEN` in the environment take precedence
when set.

## Privacy: what is sent

Recall:

```
GET /recall?query=<project>+decisions+and+context&topK=5&workspace=personal&project=<project>
GET /brief?lean=1&preview=1&workspace=personal&project=<project>
```

with a project-less second recall attempt if the first returns nothing. With
no project (a session opened in `$HOME`), one generic query limited to the
last 14 days is sent instead.

Capture saves **the last three user turns of the session only, redacted, and
capped at 2000 characters** - this is not a transcript dump:

```json
{
  "content": "Codex session in <project>, <date>\n\nUser: …\n\nUser: …\n\nUser: …",
  "source": "codex-session",
  "tags": ["<project>"],
  "workspace": "personal"
}
```

Codex writes injected context into `role: user` records, one content block
each: your AGENTS.md files (`# AGENTS.md instructions for …` with an
`<INSTRUCTIONS>` body), `<environment_context>` (working directory, shell,
timezone), `<recommended_plugins>`, `<turn_aborted>` and wrappers from tools
that drive Codex. None of it is captured. Record type and role come first:
`developer` and `system` records, tool output, non-text blocks and user
events Codex marks as injected are never read. Then each remaining user block
is judged on its own, and a block holding any tag-like markup (`<name>`) or an
instruction-file header anywhere is dropped whole, because injected context
can follow typed text in the same block. A prompt Codex logs twice counts once.

The cost of that safe side: a typed message that contains markup, say
"`<button>` needs an accessible name", is not captured.

Before it is sent, the content is scanned for credentials and each one is
replaced with `[redacted]`: your own configured token wherever it appears,
`Bearer <token>` values, provider key shapes (`sk-`, `ghp_`/`gho_`,
`github_pat_`, `xoxb-`/`xoxp-`, AWS `AKIA…`, Google `AIza…`, Stripe, npm),
JWTs, whole PEM private-key blocks, the password in
`scheme://user:password@host`, any other 32+ character token mixing digits
with upper and lower case, and `TOKEN=`/`SECRET=`/`PASSWORD=`/`API_KEY=`/
`*_KEY=`/`CREDENTIALS=` style assignments, including quoted values with
spaces (`DB_PASSWORD="correct horse battery staple"`). A UUID, a commit SHA, a file path
and ordinary prose are left exactly as they were.

A session is captured only when at least one user turn is 40+ characters and
the conversation totals 200+ characters - a two-word prompt is not a session
worth keeping.

You can forget any captured session (`forget` in the MCP tools, or the
dashboard) the same as any other memory. Turn capture off any time:

```bash
SECOND_BRAIN_HOOK_RECALL=0           # no recall on session start
SECOND_BRAIN_HOOK_CAPTURE=0          # no capture on session end, any client
SECOND_BRAIN_HOOK_CAPTURE_CODEX=0    # no capture on session end, Codex only
SECOND_BRAIN_WORKSPACE=company       # write to the shared layer instead of personal
SECOND_BRAIN_DRY_RUN=1               # print the capture body instead of sending it
```

## The Worker version gate

Capture requires **Worker 3.0 or newer** (`GET /health` reports the version,
cached for 24h). Against an older brain, recall still works and capture is
skipped with one notice per day.

## A failed capture is kept, not lost

A budget audit found that when a free-plan brain hits its daily D1 cap, the
Worker answers `POST /capture` with `HTTP 429` and `error: "daily_limit"` -
and the hook was simply logging that and moving on, silently losing the
session. Any capture that fails to upload (network error, 5xx, or 429) is now
kept as one file in `~/.cache/second-brain/capture-spool/codex/`: a 0700
directory the hook creates and checks is yours and not a symlink, each file
0600, written to a temporary name and renamed into place. The "kept" line
prints only after that file exists; if it cannot be written safely you see
`Second Brain: could not save this session, and could not keep it on this
computer to retry. This capture is lost.` instead. At most 20 files or 5 MB
are kept, oldest dropped first.

The next session start retries them only after recall has been printed: at
most 2, inside what is left of a 3 second window from when the hook started,
stopping at the first failure. Each file is deleted only after its own upload
succeeds, so an interrupted retry never loses or duplicates one. A 400/413/422
drops that file, since it would be refused the same way again. A bad or
expired token (401/403) is not kept at all: that needs you to fix the token,
not a retry.

`install.sh --check` reports how many captures are currently waiting to
retry.

## Failure lines you will see

`session-start.js` reports failures on stderr and exits non-zero, same
convention as every other adapter in this repo:

| Line | Meaning |
|---|---|
| `[Second Brain] recall failed: HTTP 401 unauthorized - token rejected…` | the token is wrong or was rotated - re-run `install.sh` |
| `[Second Brain] recall failed: HTTP 404 - is SECOND_BRAIN_URL / workerUrl the Worker origin?` | the URL points at something that is not the Worker root |
| `[Second Brain] recall failed: no reply within 15s` | the Worker did not answer in time |
| `[Second Brain] session capture needs Worker 3.0+ …` | the brain has not been redeployed to v3; shown once a day |
| `Second Brain: daily database limit reached (resets 00:00 UTC). Capture kept on this computer to retry.` | the free plan's daily D1 cap is spent; the capture is spooled, not lost |
| `Second Brain: could not save this session right now. Capture kept on this computer to retry.` | a network error or a 5xx; also spooled |

These last two are not the `[Second Brain] session capture failed: …` line
below, and do not set a non-zero exit code: a spooled capture is a handled,
recoverable condition, not a hard failure. A 401/403 still uses the old line
and exit code, since retrying it would not help.

`session-end.js` itself almost never fails visibly - it does too little to
fail. A failed capture is reported by `capture-worker.js`, in its own detached
process, so its stderr line has nowhere obvious to land in a real Codex CLI
run; `install.sh --check` is the reliable way to see it.

## Unverified

This adapter was built from the shared conventions in
`integrations/claude-code-hooks/` and `integrations/agent-hooks-core/`, not
against a running Codex CLI. The following are best guesses, not confirmed
behaviour:

- The exact `SessionStart`/`SessionEnd` stdin field names and casing
  (`session_id` vs `sessionId`, `transcript_path` vs `transcriptPath`,
  `source` vs `reason` for why a start happened). `normalizeStartEvent` in
  `session-start.js` and `normalizeEndEvent` in `session-end.js` both read
  these defensively for exactly this reason.
- The `SessionEnd` `reason` values (`close`/`archive`/`delete`/`idle`) and
  that all four can fire for one session.
- The `hooks.json` schema this installer writes: whether `hooks.SessionStart`
  /`hooks.SessionEnd` is the right shape, whether a `matcher` concept exists
  (this adapter does not write one - filtering happens in the JS itself via
  `SKIP_SOURCES`), and whether `timeout` is the right field name. The unit is
  not a guess (seconds, confirmed against the hooks.json reference - a review
  caught an earlier version of this installer writing 3000, three thousand
  seconds, instead of 3).
- **Whether a detached, unref'd child process survives past its parent hook
  process exiting**, under whatever process-group and signal handling Codex
  CLI actually uses for its hooks. If Codex kills the whole process group on
  `SessionEnd` return, `capture-worker.js` never completes and capture
  silently never happens.
- The transcript format at `transcript_path`: `capture-worker.js`'s parser
  tries a `response_item`/`payload.type: 'message'` shape (an OpenAI
  Responses-API-style item log), an `event_msg`/`user_message` shape, and a
  flat `{role, content}` shape, in that order, and skips anything else. The
  real format may be none of these.

## Smoke-test list (do this against a real Codex CLI install)

1. `bash install.sh https://your-worker.workers.dev your-token` and confirm
   `~/.codex/hooks.json` gets the expected `SessionStart`/`SessionEnd` entries.
2. Start a real Codex CLI session in a git checkout with a remote. Confirm
   recalled context actually appears before your first prompt (or check
   stderr for a `[Second Brain]` failure line).
3. Have a real conversation with at least one substantial (40+ character)
   message, then end the session by whichever action fires Codex's
   `SessionEnd` hook.
4. Immediately after the session ends, check whether `capture-worker.js` is
   still running (`ps` for `capture-worker.js`) and for how long - this is the
   detached-child question above.
5. After it finishes (or after 20s), run `bash install.sh --check` and
   confirm "Last successful capture" shows a recent timestamp, not "never".
6. Recall from the brain and confirm the captured memory reads as expected:
   last few user turns, no secrets, capped length.
7. Repeat step 3's session end via a second reason (e.g. close it, then also
   let it idle out) and confirm only one capture was made for that session id.
8. Set `SECOND_BRAIN_HOOK_CAPTURE_CODEX=0` and confirm a new session's end
   produces no capture, while `SECOND_BRAIN_HOOK_RECALL=0` still allows the
   next session's start to skip recall.
9. Find and locate the real transcript file Codex CLI wrote for one of the
   sessions above; compare its actual shape against the three shapes
   `capture-worker.js`'s parser tries, and update the parser (and this README)
   if none of them match.
