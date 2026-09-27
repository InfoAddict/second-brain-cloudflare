# Cursor editor hooks

Three hooks that connect a Cursor session to your Second Brain: two recall
paths that cover for each other, and one that saves the conversation when it
ends.

They are independent of the MCP server. Use either, or both.

## What the hooks do

| Event | Runs on | Action | Cost |
|---|---|---|---|
| `sessionStart` | every session start (see "Unverified" below) | `GET /recall` and `GET /brief` for this project, returns `additional_context` | one recall + one brief, capped at 3 s |
| `beforeSubmitPrompt` | the first prompt of a session, only if `sessionStart` has not already delivered context | the same recall as `sessionStart` | zero or one recall + one brief, capped at 3 s |
| `sessionEnd` / `stop` | session end, whichever event actually carries `transcript_path` | `POST /capture` with the last few user turns | one capture (embedding + often a model call) |

### Why two recall hooks

Cursor's `sessionStart` can return `additional_context`, but it is
**fire-and-forget**: Cursor does not wait for it before the model's first
turn. A slow or cold Worker can lose that race, so `session-start.js` may
finish after the model has already replied once, with its output never seen.
`before-submit-prompt.js` is the synchronous safety net: it runs right before
each prompt is submitted, so if `sessionStart` never delivered anything, this
hook does the same recall in a place Cursor's model loop cannot skip past.

Both hooks share one marker file per session (`cursor-delivered`, distinct
from the recall content cache) so the context is delivered once, not twice:

- `session-start.js` sets the marker only when it actually has something to
  print. If it finds nothing (or is still racing when the process exits),
  the marker stays unset and `before-submit-prompt.js` gets its turn.
- `before-submit-prompt.js` checks the marker first. If it is already set, it
  makes no request at all. Otherwise it runs the recall itself and sets the
  marker unconditionally: this hook is the last resort, so it never retries
  on a later prompt in the same session even if this attempt found nothing.

This cannot fully prove that Cursor's model loop actually waited for
`sessionStart` in any given run, only that whichever hook runs first, the
other one steps aside. See "Unverified" for what is still assumed.

### Why one script for session-end

The hooks survey found `transcript_path` in Cursor's shared base input schema
but not confirmed specifically on `sessionEnd` or `stop`. Rather than guess
which one actually carries it, `session-end.js` is registered for **both**
events and no-ops (exit 0, no request) whenever the payload it gets has none,
expected when transcript storage is off, or when the event that fired is the
one without it, not a failure. If both events happen to fire with a
transcript present for the same session, the capture-once marker
`performCapture` already keeps prevents a duplicate `/capture`.

## Install, upgrade, check, uninstall

```bash
bash install.sh https://your-worker.workers.dev your-token   # install or upgrade
bash install.sh                                              # reuse existing credentials, or prompt
bash install.sh --check                                      # prove the hooks reach the Worker
bash install.sh --uninstall                                  # remove only our entries
```

PowerShell, for Windows:

```powershell
.\install.ps1 -WorkerUrl https://your-worker.workers.dev -Token your-token
.\install.ps1            # reuse existing credentials, or prompt
.\install.ps1 -Check
.\install.ps1 -Uninstall
```

Re-running is safe: the installer replaces its own entries in
`~/.cursor/hooks.json` and preserves everything else, including hooks another
tool registered. It refuses to write a hooks file that is not valid JSON
rather than overwriting it, and it backs up the file first
(`<file>.bak-<timestamp>`).

**Restart Cursor, or reload the window, after installing.** Cursor reads
`hooks.json` at startup, so a running session keeps the old wiring.

### Where the hooks are registered

The installer writes the **user-level** file, so one install covers every
project you open in Cursor:

```
~/.cursor/hooks.json
```

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "node \"/absolute/path/to/cursor-hooks/session-start.js\"" }],
    "beforeSubmitPrompt": [{ "command": "node \"/absolute/path/to/cursor-hooks/before-submit-prompt.js\"" }],
    "sessionEnd": [{ "command": "node \"/absolute/path/to/cursor-hooks/session-end.js\"" }],
    "stop": [{ "command": "node \"/absolute/path/to/cursor-hooks/session-end.js\"" }]
  }
}
```

Cursor also reads a **project-level** hooks file inside a repository:

```
.cursor/hooks.json
```

The installer never writes this file: create it by hand with the same
shape as above if you would rather scope the hooks to one project. Project
hooks run only in a trusted workspace.

## Where credentials live

`~/.config/second-brain/config.json` (mode 600): the same file every other
Second Brain hook adapter and the CLI already use:

```json
{ "workerUrl": "https://your-worker.workers.dev", "authToken": "…" }
```

Nothing is written into `hooks.json` and nothing is passed on the hook command
line, so the token never appears there or in `ps`. `SECOND_BRAIN_URL` and
`SECOND_BRAIN_TOKEN` in the environment take precedence when set.

## What is sent

Recall (`sessionStart` and `beforeSubmitPrompt` both send this, at most once
between them per session):

```
GET /recall?query=<project>+decisions+and+context&topK=5&workspace=personal&project=<project>
GET /brief?lean=1&preview=1&workspace=personal&project=<project>
```

with a project-less second recall attempt if the first returns nothing. Both
hooks share the shared `performRecall` plan every adapter in this repo uses,
capped to 3 seconds total, short on purpose, since `sessionStart` is racing
the model's first turn and `beforeSubmitPrompt` runs synchronously in front of
every prompt.

Capture: Cursor sessions: saves the last few turns of each session to your brain. You can forget any captured session. Turn off any time.

```json
{
  "content": "Cursor session in <project>, <date>\n\nUser: …\n\nUser: …\n\nUser: …",
  "source": "cursor-session",
  "tags": ["<project>"],
  "workspace": "personal"
}
```

Only the last three user turns are kept, never a full transcript. Before
sending, the body is scanned for credentials and each one is replaced with
`[redacted]`: your own configured token wherever it appears, `Bearer <token>`
values, provider key shapes (`sk-`, `ghp_`/`gho_`, `github_pat_`,
`xoxb-`/`xoxp-`, AWS `AKIA…`, Google `AIza…`), whole PEM private-key blocks,
and `TOKEN=`/`SECRET=`/`PASSWORD=`/`API_KEY=` style assignments. The body is
capped at 2000 characters.

Set `SECOND_BRAIN_WORKSPACE=company` to write to the shared layer instead. Set
`SECOND_BRAIN_DRY_RUN=1` to print the capture body instead of sending it.

## The gate, and the Worker version

A session is captured only when it contains at least one user turn of 40+
characters and 200+ characters of user text overall: a two-word prompt is
not a session worth keeping.

Capture also requires **Worker 3.0 or newer** (`GET /health` reports the
version, cached for 24 h). Against an older brain, recall still works and the
capture is skipped with one notice per day.

## Opt out

```bash
SECOND_BRAIN_HOOK_RECALL=0            # no recall on session start or before-submit-prompt
SECOND_BRAIN_HOOK_CAPTURE=0           # no capture on any adapter (global)
SECOND_BRAIN_HOOK_CAPTURE_CURSOR=0    # no capture from Cursor specifically, recall unaffected
```

## Failure lines you will see

Hooks report failures on stderr and exit non-zero. Cursor's own handling of
that output was not confirmed for every event, so treat stderr as the one
reliable channel, matching every other adapter in this repo.

| Line | Meaning |
|---|---|
| `[Second Brain] recall failed: HTTP 401 unauthorized …` | the token is wrong or was rotated, re-run `install.sh` |
| `[Second Brain] recall failed: HTTP 404 …` | the URL points at something that is not the Worker root |
| `[Second Brain] recall failed: no reply within 3.0s` | the Worker did not answer within the 3 s cap |
| `[Second Brain] session capture failed: HTTP 401 …` | a bad or expired token; re-run `install.sh` |
| `[Second Brain] session capture needs Worker 3.0+ …` | the brain has not been redeployed to v3; shown once a day |
| `Second Brain: daily database limit reached (resets 00:00 UTC). Capture kept on this computer to retry.` | the free plan's daily D1 cap is spent; capture spooled, not lost |
| `Second Brain: could not save this session right now. Capture kept on this computer to retry.` | a network error or a 5xx; also spooled |

Nothing here blocks the session. A failed hook costs you the recall or the
capture, not the conversation. A capture that fails with a network error, a
5xx, or a 429 (the daily-cap response) is spooled locally (capped at 20
entries or 5 MB, mode 600) and retried at the start of the next session,
bounded so that retry can never make a session hang; `install.sh --check`
reports how many are waiting. A 401/403 is not spooled - that needs a fixed
token, not a retry.

## Unverified: needs a real Cursor smoke test

Everything below was derived from the vendor docs available at the time this
adapter was written (2026-09-26/27) plus deliberate design choices made to
cover the gaps those docs left open. None of it has been exercised against a
real Cursor session:

- ~~Stdin field names~~ **VERIFIED (2026-09-27) against
  https://cursor.com/docs/agent/hooks**: the session identity field is
  `conversation_id`, a common field present on every documented event
  (`sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop`, and the rest).
  `session_id` exists too but only on `sessionStart`/`sessionEnd`
  specifically - a budget audit caught an earlier version of this adapter
  reading only `sessionId`/`session_id`, which `beforeSubmitPrompt`'s payload
  never carries, so its once-per-session marker could never be named and
  every prompt ran a full recall (fixed; `conversation_id` is now the primary
  identity everywhere in this adapter, with `session_id`/`sessionId` kept as
  a defensive fallback). `workspace_roots[0]` is confirmed as the project
  path (a common field too). `cwd` on individual events is confirmed to exist
  on some (e.g. `preToolUse`) but is not listed as a `beforeSubmitPrompt`
  field, which is why this adapter prefers `workspace_roots` for the project
  path rather than relying on a per-event `cwd`.
- **`sessionStart` source/reason taxonomy.** No confirmed vocabulary
  (equivalent to Claude Code's `startup`/`resume`/`clear`/`compact`) was found
  for this event, so every call is treated as a fresh `startup` and there is
  no skip-list. If Cursor does replay `sessionStart` on a resume-like event,
  this adapter will recall again rather than skip it.
- ~~`beforeSubmitPrompt` output shape~~ **VERIFIED AND FIXED**: this event
  does not support `sessionStart`'s flat `additional_context` field; only
  `continue` and `user_message` are recognized. Fixed in a prior review
  round.
- **`hooks.json` schema.** The `{"version":1,"hooks":{"<event>":[{"command":
  "…"}]}}` shape is this adapter's best-effort read of the vendor docs, not a
  field-by-field confirmed schema. The installer's non-destructive merge
  should still be safe against a differently-shaped existing file: it
  refuses anything that is not a JSON object at the top level, but the exact
  keys it writes may need correcting once wired against a real Cursor client.
- **`transcript_path` on `sessionEnd`/`stop`.** The director's 2026-09-27
  spot-check found `transcript_path` in the shared base input schema but not
  confirmed on either event's own specification. `session-end.js` is
  registered for both and no-ops safely when it is absent, but which event
  (if either) actually delivers it in practice is unconfirmed.
- **Cursor's own transcript JSONL shape.** Entirely undocumented. The parser
  in `session-end.js` tries several plausible content shapes (a string, an
  array of `{type:'text',text}` blocks, a single `{text}` object) and skips
  anything else; it has not been checked against a real transcript file.
- **Cursor Agent CLI (`cursor-agent`) parity.** Explicitly out of scope. The
  hooks survey found the CLI's hook parity undocumented beyond a
  `workspaceOpen` mention; this adapter has not been built or tested against
  it, and installing these hooks does not claim to cover it.

If you run this against a real Cursor session, please correct this section
with what you actually observed on stdin, in `hooks.json`, and in a real
transcript file.

## Smoke test

A review caught two real bugs since this list was first written: `before-
submit-prompt.js` was emitting sessionStart's `additional_context` field,
which beforeSubmitPrompt's own docs do not recognize (it takes `continue` and
`user_message` instead, fixed now); and `session-start.js` was falling back to
`process.cwd()` even when the payload's `workspace_roots` named the actual
project, which is wrong because Cursor's hooks run from `~/.cursor`, never
from the project - `process.cwd()` there is never the project. Both are fixed;
steps 3 and 3a below specifically re-check them.

1. `bash install.sh https://your-worker.workers.dev your-token`
2. `bash install.sh --check`: confirms the Worker is reachable, prints
   recall/capture status and the last capture time, and runs a live
   `session-start.js` against your brain.
3. Open a project in Cursor that has at least one memory stored for it, start
   a fresh session, and confirm the model's first reply reflects recalled
   context (or, if it does not, that the very next prompt does, via the
   `beforeSubmitPrompt` fallback).
3a. Confirm the recall was actually scoped to THIS project, not to wherever
   `~/.cursor` happens to be: check your Worker's logs for the `project=`
   query parameter on the `/recall` call, or temporarily point
   `SECOND_BRAIN_URL` at a stub and inspect the captured request directly.
4. Have a short back-and-forth (at least one substantial message), end the
   session, and confirm a new memory tagged with this project's name appears
   in your brain within a minute or two.
5. Re-run step 3 in the same session (a second prompt) and confirm no second
   recall request is made: check your Worker's logs, or watch
   `~/.cache/second-brain/session-cursor-delivered-<session-id>.txt` appear
   after the first prompt and not change after the second.
6. `bash install.sh --uninstall`, restart Cursor, and confirm no Second Brain
   hooks remain in `~/.cursor/hooks.json`.
