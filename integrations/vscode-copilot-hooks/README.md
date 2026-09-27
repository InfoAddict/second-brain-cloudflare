# VS Code GitHub Copilot hooks (Local harness only)

> **Scope warning.** This adapter targets VS Code's built-in Copilot **Local
> harness** hooks only - the ones that run inside VS Code itself against your
> local workspace. It does **not** target, and has not been tested against,
> **GitHub Copilot CLI**, the **Copilot cloud agent**, or **Agent Host**. Those
> are a separate hooks system with camelCase field names and their own
> reference documentation. Do not point this installer at a CLI or cloud-agent
> config file.

One hook that connects a VS Code Copilot Local harness chat session to your
Second Brain: it recalls project context when a session opens. There is no
capture (SessionEnd-equivalent) half - see "Why no capture" below.

It is independent of the MCP server. Use either, or both.

## What the hook does

| Event | Runs on | Action | Cost |
|---|---|---|---|
| `SessionStart` | best-guess: `startup` and any reason not in the skip list (see Unverified) | `GET /recall` and `GET /brief` for this project, returns memories and a compact attention brief as `additionalContext` | two parallel reads, none on a cached compact-like rerun |

`resume` and `fork` are skipped, matching the Claude Code and Codex adapters
(their transcripts already contain the earlier injection). This is a
best-guess for parity, not a confirmed VS Code Copilot behaviour - see
Unverified.

Output on stdout, only when there is something to say:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Second Brain] Context recalled ...\n----- second brain notes (begin) -----\n1. ...\n----- second brain notes (end) -----\n"}}
```

Nothing is printed, and the process exits 0, when there is nothing worth
recalling. A hard failure (bad token, Worker down, timeout) is reported on
stderr prefixed `[Second Brain]` and the process exits 1 - that is the only
error channel, matching every other adapter in this repo.

## Install, upgrade, check, uninstall

```bash
bash install.sh https://your-worker.workers.dev your-token   # install or upgrade
bash install.sh                                              # reuse existing credentials, or prompt
bash install.sh --check                                      # prove the hook reaches the Worker and is installed
bash install.sh --uninstall                                  # remove only our entry
```

PowerShell, for Windows:

```powershell
.\install.ps1 -WorkerUrl https://your-worker.workers.dev -Token your-token
.\install.ps1            # reuse existing credentials, or prompt
.\install.ps1 -Check
.\install.ps1 -Uninstall
```

Re-running is safe: the installer replaces its own entry in the hooks file and
preserves everything else in it. It refuses to write a hooks file that is not
valid JSON rather than overwriting it, and it backs up the file before writing
(`<file>.bak-<timestamp>`).

**Reload the window after installing.** VS Code reads hook configuration at
startup (or window reload), so a running session keeps the old wiring.

## Where the hook is registered

The installer writes to the **user-level** hooks file by default, so one
install covers every workspace you open in VS Code - the same UX as Claude
Code's `~/.claude/settings.json`:

```
~/.copilot/hooks/second-brain.json
```

```json
{
  "SessionStart": [
    {
      "hooks": [
        { "type": "command", "command": "node \"/absolute/path/to/vscode-copilot-hooks/session-start.js\"" }
      ]
    }
  ]
}
```

### Alternative: workspace-level hooks file

If you would rather scope this to one project, VS Code also reads a
workspace-level file: `.github/hooks/*.json` inside the repository. The
installer does not write this file for you - create it by hand (or copy the
snippet below into a file such as `.github/hooks/second-brain.json`):

```json
{
  "SessionStart": [
    {
      "hooks": [
        { "type": "command", "command": "node \"/absolute/path/to/vscode-copilot-hooks/session-start.js\"" }
      ]
    }
  ]
}
```

Use an absolute path to `session-start.js` either way; VS Code's working
directory when it runs a hook command is not guaranteed to be this checkout.

Custom-agent frontmatter and plugin hook files are two more places VS Code
Copilot can source hooks from. Both exist in the Local harness but are out of
scope for this installer - it only ever touches the one file above.

## Where credentials live

`~/.config/second-brain/config.json` (mode 600) - the same file every other
Second Brain hook adapter and the CLI already use:

```json
{ "workerUrl": "https://your-worker.workers.dev", "authToken": "…" }
```

Nothing is written into the hooks file and nothing is passed on the hook
command line, so the token never appears there or in `ps`.
`SECOND_BRAIN_URL` and `SECOND_BRAIN_TOKEN` in the environment take precedence
when set.

## What is sent

```
GET /recall?query=<project>+decisions+and+context&topK=5&workspace=personal&project=<project>
GET /brief?lean=1&preview=1&workspace=personal&project=<project>
```

with a project-less second recall attempt if the first returns nothing. With
no project (a session opened outside a recognisable checkout), one generic
query limited to the last 14 days is sent instead. This is exactly the shared
`performRecall` plan every hook adapter in this repo uses - see
`integrations/agent-hooks-core/core.js`.

## Workspace Trust

VS Code shows a Workspace Trust prompt the first time it runs anything in an
untrusted workspace, hooks included. You will see this prompt on first use;
approving it lets the SessionStart hook run in that workspace.

## Opt out

```bash
SECOND_BRAIN_HOOK_RECALL=0    # no recall on session start
```

## Why no capture

The Local harness's closest analogue to Claude Code's `SessionEnd` is `Stop`.
Two things make it unsuitable for a capture hook without further design work,
so this deliverable does not attempt one: `Stop` means "this agent execution
is about to stop," not necessarily that the whole chat session is ending, and
its `transcript_path` payload is explicitly documented as an unstable shape
that can change without notice. A future capture adapter needs its own
investigation against a real transcript; recall-only was the deliberate scope
of this piece of work.

## Failure lines you will see

| Line | Meaning |
|---|---|
| `[Second Brain] recall failed: HTTP 401 unauthorized …` | the token is wrong or was rotated - re-run `install.sh` |
| `[Second Brain] recall failed: HTTP 404 …` | the URL points at something that is not the Worker root |
| `[Second Brain] recall failed: no reply within 15.0s` | the Worker did not answer within the shared recall budget |

Nothing here blocks the chat session. A failed hook costs you the recall, not
the conversation.

## Smoke test (for Rahil, against a real VS Code Copilot Local harness)

Nothing above this line has been run against a real session - see
"Unverified" below. To actually prove it:

1. Run `bash install.sh https://your-worker.workers.dev your-token` (or reuse
   an existing `~/.config/second-brain/config.json`), then
   `bash install.sh --check` and confirm it prints `SessionStart hook found`.
2. Fully quit VS Code (a window reload may not be enough if the harness caches
   hook discovery at process start) and reopen it on a workspace that is a git
   checkout with memories already stored for its project.
3. Open a new Copilot Chat session in that workspace. If VS Code shows a
   Workspace Trust prompt, approve it - the hook cannot run otherwise.
4. Confirm the recalled context actually reached the model: ask it something
   only the recalled memory would answer (e.g. "what did we decide about
   X?"), or check whatever transcript/debug view the Local harness exposes for
   `additionalContext`.
5. Capture the literal stdin JSON the harness sent, if you can (a debug log, a
   modified temporary copy of `session-start.js` that tees stdin to a file, or
   an equivalent). Compare its field names against `normalizeStdin` in
   `session-start.js` and correct the "Unverified" section below with what you
   actually saw.
6. Repeat step 3 after the harness would consider the session "resumed" (however
   this harness spells that) and confirm SKIP_SOURCES actually matches its
   source/reason string - if the hook re-runs and issues a second recall on a
   resume, `resume` is the wrong skip value for this harness.
7. Run `bash install.sh --uninstall`, reload/reopen VS Code, and confirm no
   recall happens and no `[Second Brain]` output appears anywhere.

## Unverified - needs a real VS Code Copilot Local harness smoke test

Everything below was derived from the vendor docs available at the time this
adapter was written (2026-09-26) plus deliberate parity guesses with the
Claude Code / Codex family. None of it has been exercised against a real VS
Code Copilot Local harness session:

- **Stdin field names.** The exact casing for the session id, cwd, and the
  reason a session started was not pinned letter-perfect in the fetched docs.
  This adapter reads defensively - `session_id` then `sessionId` for the id,
  `cwd` as-is, `source` then `reason` for the reason - but the real field
  names may differ entirely.
- **Skip-list values.** `resume` and `fork` are skipped by best-guess parity
  with Claude Code and Codex. The Local harness's actual source/reason
  vocabulary for a SessionStart rerun (equivalent to "resume", "fork",
  "compact") is unconfirmed; it may use different strings, or none of these.
- **Output field casing.** `hookSpecificOutput.additionalContext` is assumed
  from the doc's description of a shape "close to the Claude/Codex family."
  The literal key names were not independently confirmed for this specific
  harness.
- **Hooks file JSON shape.** The `SessionStart: [{ hooks: [{ type, command }] }]`
  shape mirrors Claude Code's `settings.json` hooks convention. The Local
  harness's actual schema for `~/.copilot/hooks/*.json` and
  `.github/hooks/*.json` files was not confirmed field-by-field.
- **The Local vs. CLI vs. cloud-agent distinction itself.** The docs describe
  these as separate systems, but this adapter has only been checked against
  written specification, not a live installation of either.
- **The 15s recall / 3s brief-grace timing budget.** This adapter deliberately
  inherits Claude Code's own budget (see the comment above `RECALL_TIMEOUT_MS`
  in `session-start.js`) because the fetched docs do not document the Local
  harness's SessionStart as tightly time-bounded the way some other hosts are.
  That absence of a documented ceiling is itself unconfirmed - if the Local
  harness turns out to enforce its own shorter timeout on hook commands, this
  budget needs to shrink to match it.

If you run this against a real VS Code Copilot Local harness session, please
correct this section with what you actually observed on stdin and in the
hooks file schema.
