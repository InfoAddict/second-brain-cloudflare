#!/usr/bin/env node
/**
 * Runs automatically before `npm run deploy` (npm's `predeploy` lifecycle hook).
 * A non-zero exit here stops the deploy.
 *
 * WHAT THIS PROTECTS AGAINST
 *
 * `npm run deploy` is the command a self-hoster runs after cloning this repo,
 * and it must keep working for them. It reads wrangler.jsonc, which carries no
 * account resource IDs — each person's `wrangler deploy` fills those in from
 * their own Cloudflare account.
 *
 * On a maintainer's machine that same command is a footgun. wrangler.jsonc
 * still names the Worker "second-brain", so running it there aims at the
 * maintainer's live Worker but with an unresolved OAUTH_KV binding — a
 * production deploy with a broken OAuth binding, from a command that looks
 * completely routine.
 *
 * HOW IT TELLS THE TWO APART
 *
 * By the presence of a per-environment override (wrangler.<env>.jsonc). Those
 * are gitignored, so only someone who deliberately created one has one, and
 * that is exactly the person who must not run a bare deploy. A fresh clone has
 * no override, this guard says nothing, and `npm run deploy` behaves normally.
 *
 * The guard is deliberately keyed on a file rather than a username, hostname,
 * or env var: nothing to configure, nothing to forget, and it starts working
 * the moment an override is created.
 *
 * Escape hatch:  ALLOW_BARE_DEPLOY=1 npm run deploy
 */

import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.ALLOW_BARE_DEPLOY === "1") process.exit(0);

// wrangler.jsonc is the shared config and does NOT match: the pattern requires
// a middle segment, as in wrangler.personal.jsonc.
const overrides = readdirSync(ROOT).filter((f) => /^wrangler\.[A-Za-z0-9_-]+\.jsonc$/.test(f));

if (overrides.length === 0) process.exit(0);

const list = overrides.map((f) => `    ${f}`).join("\n");

console.error(`
✖ Refusing a bare deploy on a machine that has per-environment config.

  Found:
${list}

  wrangler.jsonc has no account resource IDs in it, but it still names the
  Worker "second-brain" — so a bare deploy from here would target your live
  Worker with an unresolved OAUTH_KV binding.

  Deploy to your own brain with:

    sh deploy-personal.sh

  which points wrangler at the override and records a D1 Time Travel bookmark
  and the current Worker version first, so the deploy stays reversible.

  If you genuinely want the bare deploy:

    ALLOW_BARE_DEPLOY=1 npm run deploy
`);

process.exit(1);
