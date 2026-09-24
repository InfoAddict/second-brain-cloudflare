import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { producerId } from "./ai-replay";
import { producerKey, type EmbeddingProducer } from "./types";

/**
 * Migration for caches recorded before rows carried provenance. A legacy row is `{k, v}`: the key is a hash of
 * (model, input) and the input is not stored, so nothing can recompute or verify who made it. Stamping is therefore
 * a HUMAN ASSERTION ("I recorded this file with this producer"), never a check; the command demands
 * --i-recorded-this, logs the assertion, and appends a `stamped` audit line to the file. It narrows what it will
 * assert: the file must hold exactly one producer record, for the named model, equal to the producer claimed.
 */
export function stampCache(o: { file: string; model: string; producer: EmbeddingProducer }): { stamped: number; already: number } {
  const gz = o.file.endsWith(".gz");
  const dir = dirname(o.file), name = basename(o.file);
  const locks = existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith(`${name}.`) && f.endsWith(".lock")) : [];
  if (locks.length) throw new Error(`${o.file} has ${locks.length} lock file(s): a recording process may still be writing it. Wait for it to finish, then stamp`);
  const raw = readFileSync(o.file);
  const lines = (gz ? gunzipSync(raw) : raw).toString("utf8").split("\n").filter(Boolean);
  const recs = lines.map(l => JSON.parse(l) as Record<string, unknown>);
  const producers = recs.filter(r => r.producer !== undefined).map(r => r.producer as { model: string } & EmbeddingProducer);
  if (producers.length !== 1) throw new Error(`${o.file} has ${producers.length} producer records; stamping needs exactly one, so a row cannot be attributed to the wrong model`);
  const { model, ...recorded } = producers[0];
  if (model !== o.model) throw new Error(`${o.file}'s producer record is for ${model}, not ${o.model}`);
  if (producerKey(recorded) !== producerKey(o.producer)) throw new Error(`${o.file} was recorded by ${producerKey(recorded)}, not the claimed ${producerKey(o.producer)}`);
  const pid = producerId(o.producer);
  let stamped = 0, already = 0;
  const out = recs.map((r, i) => {
    if (typeof r.k !== "string") return lines[i];
    if (r.v && typeof r.v === "object" && "text" in (r.v as object)) return lines[i]; // LLM rows carry no producer
    if (r.m !== undefined || r.p !== undefined) {
      if (r.m !== o.model || r.p !== pid) throw new Error(`row ${r.k} is already stamped with ${String(r.m)}/${String(r.p)}, which is not ${o.model}/${pid}`);
      already++;
      return lines[i];
    }
    stamped++;
    return JSON.stringify({ k: r.k, v: r.v, m: o.model, p: pid });
  });
  if (stamped) out.push(JSON.stringify({ stamped: { model: o.model, producer: pid, rows: stamped, assertion: "--i-recorded-this", at: new Date().toISOString() } }));
  const tmp = `${o.file}.${process.pid}.stamp.tmp`;
  try {
    writeFileSync(tmp, gz ? gzipSync(`${out.join("\n")}\n`) : `${out.join("\n")}\n`);
    renameSync(tmp, o.file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* no temp */ }
    throw e;
  }
  return { stamped, already };
}

/** The producer record a cache file holds for `model` (for --producer-from <file>). */
export function producerFromCache(file: string, model: string): EmbeddingProducer {
  const raw = readFileSync(file);
  const recs = (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as { producer?: { model: string } & EmbeddingProducer });
  const found = recs.filter(r => r.producer?.model === model);
  if (found.length !== 1) throw new Error(`${file} has ${found.length} producer records for ${model}, expected exactly one`);
  const { model: _m, ...producer } = found[0].producer!;
  void _m;
  return producer;
}
