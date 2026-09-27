# Cursor editor hooks

Hooks that connect a Cursor conversation to your Second Brain: one recall at
the start, and one capture when the conversation ends.

They are independent of the MCP server. **For recall you can rely on, also
connect the MCP server and let the model call its `recall` tool** (see
[Cursor Instructions](https://github.com/rahilp/second-brain-cloudflare/wiki/Cursor-Instructions)).
The session-start hook is a head start, not a guarantee; the reason is below.

## What the hooks do

| Event | Runs on | Action | Cost |
|---|---|---|---|
| `sessionStart` | every new conversation | `GET /recall` and `GET /brief` for this project, returns `additional_context`, then retries up to 2 kept captures in what is left of the 3 s cap | one recall + one brief, capped at 3 s |
| `stop` | after every agent turn | remembers where this conversation's transcript is, on this computer only | no request |
| `sessionEnd` | the conversation ends | `POST /capture` with the last three user turns | one capture per conversation |

### Recall: one path, and why MCP is the reliable one

Cursor's docs (https://prod.cursor.com/docs/hooks, checked 2026-09-27) say
sessionStart's `additional_context` is "Additional context to add to the
conversation's initial system context", which is the one hook output
documented to reach the model. They also say sessionStart is
fire-and-forget: "the agent loop does not wait for or enforce a blocking
response". A slow or cold Worker can therefore land after the first turn,
and then that conversation gets no recalled context from the hook.

There is no second hook path. An earlier version used `beforeSubmitPrompt` as
a fallback, but that event's `user_message` is a "Message shown to the user
when the prompt is blocked": it never reaches the model, so the fallback
delivered nothing and was removed. Upgrading with `install.sh` removes its old
entry from `hooks.json`.

### Capture: why `stop` and `sessionEnd` both run `session-end.js`

Per the docs, `sessionEnd` carries no `transcript_path`; `stop` does, and it
fires after every agent turn. So:

- `stop` (`session-end.js --event=stop`) only records the transcript path in
  your local cache. It never sends anything, so a 25-turn conversation costs
  nothing extra.
- `sessionEnd` (`session-end.js --event=sessionEnd`) reads that transcript
  once and sends one capture. A capture-once marker per conversation stops a
  repeat.

The transcript is read only when its real path (after resolving `..` and
every symlink) is inside `~/.cursor/projects/`, where Cursor keeps agent
transcripts. Anything else is refused and nothing is sent. If you have
transcripts turned off, `transcript_path` is null and capture quietly does
nothing.

The project name comes from `workspace_roots[0]` in the payload, never from
the directory the hook runs in (Cursor runs user hooks from `~/.cursor`).

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
    "sessionEnd": [{ "command": "node \"/absolute/path/to/cursor-hooks/session-end.js\" --event=sessionEnd" }],
    "stop": [{ "command": "node \"/absolute/path/to/cursor-hooks/session-end.js\" --event=stop" }]
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

Recall (`sessionStart`, once per conversation):

```
GET /recall?query=<project>+decisions+and+context&topK=5&workspace=personal&project=<project>&synthesize=0
GET /brief?lean=1&preview=1&workspace=personal&project=<project>
```

with a project-less second recall attempt if the first returns nothing, all
inside one 3 second cap.

Capture: Cursor sessions: saves the last few turns of each session to your brain. You can forget any captured session. Turn off any time.

```json
{
  "content": "Cursor session in <project>, <date>\n\nUser: …\n\nUser: …\n\nUser: …",
  "source": "cursor-session",
  "tags": ["<project>"],
  "workspace": "personal"
}
```

Only the last three user turns are kept, never a full transcript. A user
turn is only the text inside Cursor's `<user_query>` wrapper: the rules, user
info, attached files and timestamps Cursor adds around it are dropped, and a
user record without that wrapper is dropped whole, since it cannot be told
apart from injected context. A query holding any tag-like markup (`<name>`)
or an instruction-file header is dropped too: a typed "`<button>` needs an
accessible name" is not captured, the accepted cost of never leaking an
injected block.

Before sending, the body is scanned for credentials and each one is replaced
with `[redacted]`: your own configured token wherever it appears,
`Bearer <token>` values, provider key shapes (`sk-`, `ghp_`/`gho_`,
`github_pat_`, `xoxb-`/`xoxp-`, AWS `AKIA…`, Google `AIza…`, Stripe, npm),
JWTs, whole PEM private-key blocks, the password in `scheme://user:password@host`,
any other 32+ character token mixing digits with upper and lower case, and
`TOKEN=`/`SECRET=`/`PASSWORD=`/`API_KEY=`/`*_KEY=`/`CREDENTIALS=` style
assignments. A UUID, a commit SHA and a file path are left as they were. The
body is capped at 2000 characters.

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
SECOND_BRAIN_HOOK_RECALL=0            # no recall on session start
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

| `Second Brain: could not save this session, and could not keep it on this computer to retry. This capture is lost.` | the upload failed and the local spool could not be written safely |

Nothing here blocks the session. A failed hook costs you the recall or the
capture, not the conversation.

A capture that fails with a network error, a 5xx, or a 429 (the daily-cap
response) is kept as one file in `~/.cache/second-brain/capture-spool/cursor/`
(a 0700 directory the hook creates and checks is yours and not a symlink;
each file is 0600, written to a temporary name and renamed into place). The
"kept" line prints only after that file exists; otherwise you see the "lost"
line. At most 20 files or 5 MB are kept, oldest dropped first.

The next session start retries them after recall has been printed: at most 2,
inside what is left of its 3 second cap, stopping at the first failure. Each
file is deleted only after its own upload succeeds, so an interrupted retry
never loses or duplicates one. A 400/413/422 drops that file, since a retry
would be refused the same way. A 401/403 is not kept at all; that needs a
fixed token. `install.sh --check` reports how many are waiting.

## Unverified: needs a real Cursor smoke test

Checked against https://prod.cursor.com/docs/hooks on 2026-09-27:
`conversation_id` and `workspace_roots` are common fields on every event;
`stop` carries `transcript_path` (null when transcripts are off);
sessionStart's `additional_context` reaches the model; beforeSubmitPrompt's
`user_message` does not. The transcript record shape
(`{role, message: {content: [{type: "text", text}]}}`, with the typed prompt
inside `<user_query>`) was read from real files on disk and is pinned by
`fixtures/real-shape-transcript.jsonl`.

Still assumed, not exercised in a live Cursor session:

- **`sessionStart` source/reason taxonomy.** No documented equivalent of
  Claude Code's `startup`/`resume`/`clear`/`compact`, so every call is
  treated as a fresh start. If Cursor replays `sessionStart` on resume, this
  adapter recalls again.
- **`hooks.json` schema.** The `{"version":1,"hooks":{"<event>":[{"command":
  "..."}]}}` shape follows the docs; the installer refuses to overwrite a
  file that is not a JSON object.
- **Transcript directory.** The docs do not name one. `~/.cursor/projects/`
  is where transcripts were found on disk; if Cursor moves them, capture is
  refused (safe) until this path is updated.
- **Cursor Agent CLI (`cursor-agent`) parity.** Out of scope; not built or
  tested against it.

If you run this against a real Cursor session, please correct this section
with what you actually observed.

## Smoke test

1. `bash install.sh https://your-worker.workers.dev your-token`
2. `bash install.sh --check`: confirms the Worker is reachable, prints
   recall/capture status, the last capture time and waiting captures, and
   runs a live `session-start.js` against your brain.
3. Open a project that has at least one memory stored for it and start a new
   conversation. If the first reply reflects recalled context, the hook won
   the race; if not, ask the model to use the MCP `recall` tool.
3a. Confirm recall was scoped to THIS project: check your Worker's logs for
   the `project=` parameter on `/recall`.
4. Have a short back-and-forth (at least one substantial message) and end
   the conversation. Confirm exactly one new memory tagged with this
   project's name appears, not one per turn.
5. `bash install.sh --uninstall`, restart Cursor, and confirm no Second Brain
   hooks remain in `~/.cursor/hooks.json`.
