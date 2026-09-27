#!/usr/bin/env node
'use strict';
// beforeSubmitPrompt fallback for the Cursor editor.
//
// session-start.js's recall is fire-and-forget and can lose the race against
// the model's first turn (see that file's header and README.md). This hook
// runs synchronously before each prompt is submitted, so it is the reliable
// delivery path for the same context, but it only ever acts once per
// session: the 'cursor-delivered' marker session-start.js also uses makes
// every later prompt in the session a no-op, with no recall request made at
// all. Whichever hook wins the race sets the marker; the other one sees it
// and stays quiet.
//
// Same undocumented-stdin caveat as session-start.js: field names are read
// defensively, and there is no confirmed skip-list for this event either.
const { readStdinJson, performRecall, hasMarker, setMarker, fail } = require('../agent-hooks-core/core');
const { normalizeStdin, NAMESPACE, DELIVERED_KEY, CAP_MS } = require('./session-start');

/**
 * beforeSubmitPrompt's own documented output shape, which is NOT the same
 * contract sessionStart uses. A review caught an earlier version of this
 * file reusing sessionStart's flat `additional_context` field here, which
 * beforeSubmitPrompt's own docs do not support
 * (https://prod.cursor.com/docs/hooks): only `continue` and `user_message`
 * are recognized fields for this event. Named to match session-start.js's
 * sibling function (both "emit the context we recalled"), not the field it
 * writes, which is intentionally different from that function's. No-op, and
 * no stdout at all, for empty text.
 */
function emitAdditionalContext(text) {
  if (!text) return false;
  process.stdout.write(`${JSON.stringify({ continue: true, user_message: text })}\n`);
  return true;
}

/**
 * The testable main flow. Checks the shared marker first (no request at all
 * when it is already set, returns null, meaning "nothing to say", matching
 * performRecall's own contract for "nothing to print"). Otherwise runs the
 * same recall this event's session-start.js sibling would, then sets the
 * marker unconditionally: this hook is the last resort, so it must not retry
 * on every subsequent prompt even when this attempt found nothing to recall.
 */
async function runBeforeSubmitPrompt(payload, overrides = {}) {
  const { sessionId, cwd } = normalizeStdin(payload);
  if (hasMarker(DELIVERED_KEY, sessionId, overrides.cacheDir)) return null;

  const text = await performRecall({
    cwd,
    sessionId,
    source: 'startup',
    namespace: NAMESPACE,
    capMs: CAP_MS,
    ...overrides,
  });
  setMarker(DELIVERED_KEY, sessionId, overrides.cacheDir);
  if (text) emitAdditionalContext(text);
  return text;
}

async function main() {
  const payload = await readStdinJson();
  await runBeforeSubmitPrompt(payload);
}

module.exports = { normalizeStdin, emitAdditionalContext, runBeforeSubmitPrompt, main };

if (require.main === module) {
  main().catch((e) => fail(`recall failed: ${e?.message ?? e}`));
}
