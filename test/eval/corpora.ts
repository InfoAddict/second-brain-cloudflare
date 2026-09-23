import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_DATA_DIR, CORPUS_IDS, buildCorpus, type CoreCorpusId } from "./corpus/build";
import type { CorpusSpec } from "./corpus/types";

interface Provider { name: string; match: (id: string) => boolean; build: (id: string) => CorpusSpec | Promise<CorpusSpec> }
const providers: Provider[] = [];

export function registerCorpusProvider(name: string, match: Provider["match"], build: Provider["build"]): void {
  providers.unshift({ name, match, build }); // latest registration wins
}

registerCorpusProvider("core", id => (CORPUS_IDS as readonly string[]).includes(id), id => buildCorpus(id as CoreCorpusId));

export async function resolveCorpus(id: string): Promise<CorpusSpec> {
  const provider = providers.find(p => p.match(id));
  if (!provider) throw new Error(`unknown corpus "${id}". Known: ${listCorpora().join(", ")}`);
  return provider.build(id);
}

export const listCorpora = (): string[] => [...CORPUS_IDS, ...providers.filter(p => p.name !== "core").map(p => `${p.name}:*`)];

const slug = (model: string) => model.split("/").pop()!;

export function replayPaths(model: string): { read: string[]; write: string } {
  const root = process.env.SB_EVAL_ROOT ?? resolve(import.meta.dirname, "../..");
  const committed = resolve(CORE_DATA_DIR, `replay.${slug(model)}.jsonl.gz`);
  const local = resolve(root, `.eval-cache/replay/${slug(model)}.jsonl`);
  // Read layers: the committed core cache, then the local one (recorded but uncommitted, e.g. 5k/20k).
  return { read: [...(existsSync(committed) ? [committed] : []), local], write: local };
}
