# Gemini CLI hooks

One hook that connects a Gemini CLI session to your Second Brain: it recalls
project context when a session opens. There is no capture (session-end)
half - this adapter's scope is `SessionStart` injection only, per the
director's 4.0 scope decision ("SessionStart injection only; no capture").

It is independent of the MCP server. Use either, or both.

## What the hook does

| Event | Runs on | Action | Cost |
|---|---|---|---|
| `SessionStart` | `startup`, `clear` (`resume` is skipped) | `GET /recall` and `GET /brief` for this project, returns memories and a compact attention brief as `additionalContext` | two parallel reads, capped at 3s total |

`resume` is skipped: that transcript already holds the earlier injection, the
same reasoning every adapter in this repo uses for a resumed session.
`startup` and `clear` always run a fresh recall.

Gemini CLI's own docs do not describe a `compact` (or equivalent)
rerun-after-compaction `SessionStart` source the way Codex's docs do for
Codex. This adapter does **not** assume one exists - nothing here treats any
source as "the session was just compacted," so there is no cache-and-replay
path wired to a guessed source string. If a real Gemini CLI session turns out
to rerun `SessionStart` after compaction under some other source value, wire
it into `cacheableSources`/a new skip entry then, not before.

Output on stdout, only when there is something to say - Gemini CLI's docs are
explicit that only JSON belongs on stdout for this hook, so unlike the Codex
adapter there is no plain-text fallback:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Second Brain] Context recalled ...\n----- second brain notes (begin) -----\n1. ...\n----- second brain notes (end) -----\n"}}
```

Nothing is printed, and the process exits 0, when there is nothing worth
recalling. A hard failure (bad token, Worker down, timeout) is reported on
stderr prefixed `[Second Brain]` and the process exits 1 - that is the only
error channel, matching every other adapter in this repo.

## Why the 3-second cap is load-bearing here

Gemini's hooks run synchronously and the CLI waits on this process. The
vendor docs describe no timeout ceiling of their own for `SessionStart`.
unlike some other hosts, there is no documented outer limit that would save
you if this adapter hung. That makes `session-start.js`'s own `capMs: 3000`
the *only* thing standing between a Worker outage and an indefinitely hung
terminal.

This is not an assumption taken on faith: `session-start.js` has a comment
block re-deriving, line by line against `integrations/agent-hooks-core/core.js`'s
`performRecall`, why passing `capMs` makes 3000ms a hard ceiling on the
network portion of the hook (one shared deadline computed up front, an
`AbortController` tied to it, a `settle()` that races the brief against that
same deadline, and no retry loop that could push past it). The one thing the
cap does **not** cover is the local, synchronous git-remote lookup used to
name the project (`execFileSync`, its own 2000ms timeout in `core.js`) - that
runs before the deadline is computed, is identical for every adapter in this
repo, and is out of scope to change here since `core.js` is shared. The true
worst case is therefore bounded by that 2s plus the 3s cap, not by 3s alone.

`install.sh`/`install.ps1` additionally set the hook's own `timeout: 4000` in
settings.json as a belt-and-suspenders margin on top of the 3s internal cap.
not the real limit, since the vendor docs do not specify a default timeout for
this event at all.

## Install, upgrade, check, uninstall

```bash
bash install.sh https://your-worker.workers.dev your-token   # install or upgrade
bash install.sh                                              # reuse existing credentials, or prompt
bash install.sh --check                                      # prove the hook reaches the Worker
bash install.sh --uninstall                                  # remove only our entry
```

PowerShell, for Windows:

```powershell
.\install.ps1 -WorkerUrl https://your-worker.workers.dev -Token your-token
.\install.ps1            # reuse existing credentials, or prompt
.\install.ps1 -Check
.\install.ps1 -Uninstall
```

Re-running is safe: the installer replaces its own entry in
`~/.gemini/settings.json` and preserves everything else. It refuses to write a
settings file that is not valid JSON rather than overwriting it, and it backs
up the file before writing (`<file>.bak-<timestamp>`).

**Restart any session that is already open.** Gemini CLI reads hook
configuration at startup, so a running session keeps the old wiring.

**Windows is explicitly unverified for Gemini CLI specifically.** Unlike the
Codex, Cursor and Copilot adapters in this repo, Gemini CLI's own Windows hook
behavior was not documented anywhere this was checked. `install.ps1` is
shipped for parity with the other installers (same credentials file, same
reconcile-in-place guarantees, same refusal on malformed JSON) - but it has
not been proven against a real Gemini CLI session on Windows.

## Where the hook is registered

The installer writes to the **user-level** settings file by default, so one
install covers every project you open in Gemini CLI:

```
~/.gemini/settings.json    (user, default; overridable with GEMINI_SETTINGS_FILE)
```

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/absolute/path/to/gemini-cli-hooks/session-start.js\"", "timeout": 4000 }
        ]
      }
    ]
  }
}
```

### Alternative: project-level settings file

If you would rather scope this to one project, paste the same snippet into
the project's own settings file instead:

```
.gemini/settings.json      (project)
```

The installer does **not** write this file for you. Gemini CLI fingerprints
project-level hook commands and shows a trust prompt whenever that command
changes, so a silent write here would trip that prompt on every teammate's
next run - pasting it by hand keeps that decision in the hands of whoever owns
the project checkout.

A third location, `/etc/gemini-cli/settings.json` (system), also exists in the
vendor docs. This adapter never writes there; it is mentioned here only so you
know it is a place Gemini CLI itself might look.

## Where credentials live

`~/.config/second-brain/config.json` (mode 600) - the same file the CLI, the
desktop app and every other Second Brain hook adapter already use:

```json
{ "workerUrl": "https://your-worker.workers.dev", "authToken": "…" }
```

Nothing is written into `settings.json` and nothing is passed on the hook
command line, so the token never appears in Gemini CLI's settings or in `ps`.
`SECOND_BRAIN_URL` and `SECOND_BRAIN_TOKEN` in the environment take precedence
when set.

## What is sent

```
GET /recall?query=<project>+decisions+and+context&topK=5&workspace=personal&project=<project>
GET /brief?lean=1&preview=1&workspace=personal&project=<project>
```

with a project-less second recall attempt if the first returns nothing. With
no project (a session opened in `$HOME`), one generic query limited to the
last 14 days is sent instead. This is the shared `performRecall` plan every
hook adapter in this repo uses - see `integrations/agent-hooks-core/core.js`.
run here with `capMs: 3000` instead of the 15s/3s default other, non-blocking
hosts get.

## Opt out

```bash
SECOND_BRAIN_HOOK_RECALL=0    # no recall on session start
```

## Failure lines you will see

| Line | Meaning |
|---|---|
| `[Second Brain] recall failed: HTTP 401 unauthorized …` | the token is wrong or was rotated - re-run `install.sh` |
| `[Second Brain] recall failed: HTTP 404 …` | the URL points at something that is not the Worker root |
| `[Second Brain] recall failed: no reply within 3.0s` | the Worker did not answer within this adapter's cap |

Nothing here blocks the session. A failed hook costs you the recall, not the
conversation.

## Unverified - needs a real Gemini CLI smoke test

Everything below was derived from the vendor docs available when this adapter
was written plus deliberate parity choices with the Claude Code / Codex /
Copilot family. None of it has been exercised against a real Gemini CLI
session:

- **Stdin field names.** The exact shape of what Gemini CLI writes to a
  `SessionStart` hook's stdin was not pinned down letter-perfect in the docs
  fetched for this work. This adapter reads defensively - `session_id` then
  `sessionId` for the id, `cwd` as-is, `source` then `reason` for why the
  session started, defaulting to `startup` when neither is present - but the
  real field names may differ.
- **Compaction / resume rerun behavior.** No documented `compact` (or
  equivalent) `SessionStart` source was found for Gemini CLI, unlike Codex.
  This adapter treats that as genuinely unknown rather than copying Codex's
  assumption that `SessionStart` reruns after compaction; it neither special-
  cases nor caches for a compaction rerun. `resume` is skipped on the same
  reasoning every adapter here uses (the transcript already holds the earlier
  injection) - also unconfirmed against a real session.
- **Output size limits.** No documented ceiling was found on how much text
  Gemini CLI will accept in `additionalContext`. This adapter still applies
  the shared 6,000-character frame cap from `agent-hooks-core/core.js`, the
  same cap every other adapter uses, as a sane default rather than a
  vendor-confirmed limit.
- **Windows behavior**, specifically for Gemini CLI - see the Windows note
  above.

If you run this against a real Gemini CLI session, please correct this
section with what you actually observed on stdin, in `additionalContext`
handling, and around compaction/resume.

## Smoke test (do this by hand against a real Gemini CLI)

1. `bash integrations/gemini-cli-hooks/install.sh https://your-worker.workers.dev your-token`
   and confirm it prints `Wrote …/config.json` and `Updated …/.gemini/settings.json`.
2. `bash integrations/gemini-cli-hooks/install.sh --check` and confirm it prints
   `Worker <version> at <url> - recall: on (SessionStart only, no capture)`,
   followed by a `— session-start against this brain —` block that either
   shows recalled context or exits cleanly with nothing to recall.
3. Open a **new** Gemini CLI session inside a project that has memories stored
   for it, and confirm the first turn's context includes a
   `[Second Brain] Context recalled …` block you did not type yourself.
4. Open a new session in an empty scratch directory with no prior memories,
   and confirm the session opens normally with no visible Second Brain block
   and no error surfaced to you (a failure would show as `[Second Brain]
   recall failed: …` wherever Gemini CLI surfaces hook stderr).
5. Temporarily point `SECOND_BRAIN_URL` at an unreachable host (or stop the
   Worker) and open a session; confirm the terminal still becomes usable
   within a few seconds rather than hanging - this is the exact scenario the
   3-second cap exists for.
6. `bash integrations/gemini-cli-hooks/install.sh --uninstall` and confirm the
   hook entry is gone from `~/.gemini/settings.json` while your credentials
   file is untouched.

Report back what you actually saw on stdin (if Gemini CLI exposes it) and
whether `SessionStart` ever reran mid-session (e.g. after a context-compaction
event) - both would resolve items in the Unverified list above.
