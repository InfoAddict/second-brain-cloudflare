import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_DATA_DIR, CORPUS_IDS, buildCorpus, type CoreCorpusId } from "./corpus/build";
import type { CorpusSpec } from "./corpus/types";
import { PUBLIC_CORPORA, publicCorpusProvider } from "./public/neutral";

interface Provider { name: string; match: (id: string) => boolean; build: (id: string) => CorpusSpec | Promise<CorpusSpec>; ids?: readonly string[] }
const providers: Provider[] = [];

/** `ids` is only for --list; providers with open-ended ids (a future private:*) omit it. */
export function registerCorpusProvider(name: string, match: Provider["match"], build: Provider["build"], ids?: readonly string[]): void {
  providers.unshift({ name, match, build, ids }); // latest registration wins
}

registerCorpusProvider("core", id => (CORPUS_IDS as readonly string[]).includes(id), id => buildCorpus(id as CoreCorpusId));

// Public corpora: downloaded on demand into .eval-cache/public, never committed. The provider is built per call so
// SB_EVAL_ROOT is read when a corpus is resolved.
registerCorpusProvider("public", id => publicCorpusProvider().match(id), id => publicCorpusProvider().build(id), Object.keys(PUBLIC_CORPORA));

/** True for corpora whose data is committed (the core set); everything else is local-only. */
export const isCoreCorpus = (id: string): boolean => (CORPUS_IDS as readonly string[]).includes(id);

export async function resolveCorpus(id: string): Promise<CorpusSpec> {
  const provider = providers.find(p => p.match(id));
  if (!provider) throw new Error(`unknown corpus "${id}". Known: ${listCorpora().join(", ")}`);
  return provider.build(id);
}

export const listCorpora = (): string[] => [...CORPUS_IDS, ...providers.filter(p => p.name !== "core").flatMap(p => p.ids ?? [`${p.name}:*`])];

const slug = (model: string) => model.split("/").pop()!;

/**
 * read lists only cache files that exist, so an empty read means nothing has been recorded and callers,
 * including Task 11's skipIf guards, can test read.length. write is always a file under .eval-cache/replay.
 * Core corpora share <slug>.jsonl and also read the committed core cache. Every other corpus (public, and any
 * future private one) gets its own <corpus>.<slug>.jsonl, reads only that file, and can never touch the committed path.
 */
export function replayPaths(model: string, corpus?: string): { read: string[]; write: string } {
  const root = process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../..");
  const core = corpus === undefined || isCoreCorpus(corpus);
  const local = resolve(root, `.eval-cache/replay/${core ? "" : `${corpus}.`}${slug(model)}.jsonl`);
  const committed = resolve(CORE_DATA_DIR, `replay.${slug(model)}.jsonl.gz`);
  return { read: (core ? [committed, local] : [local]).filter(existsSync), write: local };
}
