import type { Page } from "puppeteer-core";
import type { Locale, Theme, Viewport } from "../browser";
import type { Env } from "../../../src/env";

/** Thrown by a journey when it reaches a step whose feature genuinely does not exist on this
 * branch yet. The runner reports this as PENDING, distinct from a real failure: the same script
 * turns green the moment the named feature ships, with no rewrite. */
export class NotBuilt extends Error {
  constructor(public readonly feature: string, detail: string) {
    super(`feature not built: ${feature} (${detail})`);
  }
}

export interface JourneyCtx {
  env: Env;
  baseUrl: string;
  page: Page;
  /** Captures a screenshot at the current step, captioned and indexed automatically. */
  shot(slug: string, caption: string): Promise<void>;
  viewport: Viewport;
  locale: Locale;
  theme: Theme;
}

export interface Journey {
  id: string;
  title: string;
  /** Seeds whatever backend state this journey needs, using the real Worker functions directly
   * (not the UI) — a journey's PASS/PENDING verdict is about the UI and chat surfaces, not about
   * whether this harness can construct the precondition. */
  setup(env: Env): Promise<void>;
  /** Drives the browser and asserts the journey's "Pass when" condition from map 6.2. Throw
   * NotBuilt for a missing feature; throw anything else for a real failure. */
  run(ctx: JourneyCtx): Promise<void>;
}
