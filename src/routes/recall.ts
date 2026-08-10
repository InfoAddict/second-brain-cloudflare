import type { Env } from "../env";
import { resolveConfig } from "../config";
import { LLM_MODEL, VECTORIZE_FIX_HINT } from "../constants";
import { CORS_HEADERS, intParam, json, requireAuth } from "../lib/http";
import { buildEntryFilterQuery } from "../capture/entry";
import { compressTag } from "../compression/digest";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { recallEntries } from "../recall/search";
import { allowanceFor, snippetOf } from "../recall/snippet";

export async function handleRecallRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /list
  if (url.pathname === "/list" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    // Floor of 0 as well as the cap: SQLite reads a negative LIMIT as no limit
    // at all, so `?n=-1` used to return the whole entries table.
    const n = intParam(url, "n", { fallback: 20, min: 0, max: 100 });
    if (n instanceof Response) return n;
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = intParam(url, "after");
    if (after instanceof Response) return after;
    const before = intParam(url, "before");
    if (before instanceof Response) return before;

    const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before });
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    return json(results);
  }

  // GET /recall — semantic search, mirrors the MCP `recall` tool
  if (url.pathname === "/recall" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    const query = url.searchParams.get("query")?.trim();
    if (!query) return json({ ok: false, error: "query is required" }, 400);

    const topK = intParam(url, "topK", { fallback: 5, min: 1, max: 20 });
    if (topK instanceof Response) return topK;
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const after = intParam(url, "after");
    if (after instanceof Response) return after;
    const before = intParam(url, "before");
    if (before instanceof Response) return before;
    const kindParam = url.searchParams.get("kind")?.trim();
    const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;
    const hops = intParam(url, "hops", { fallback: 0, min: 0, max: 3 });
    if (hops instanceof Response) return hops;
    // Long memories are shortened by default so API/CLI consumers get a bounded
    // payload. Renderers that show the whole memory (the dashboard) pass full=1.
    const full = ["1", "true", "yes"].includes((url.searchParams.get("full") ?? "").toLowerCase());

    const cfg = await resolveConfig(env);
    const { matches, insight, semanticUnavailable, queryUsed, queryTokens, compoundStale } = await recallEntries({ query, topK, tag, after, before, kind, hops }, env, ctx, cfg);

    if (!matches.length) {
      return json({
        ok: true,
        results: [],
        query_used: queryUsed,
        semantic_unavailable: semanticUnavailable,
        message: semanticUnavailable
          ? `Semantic search unavailable (Vectorize index missing). Fix: ${VECTORIZE_FIX_HINT}.`
          : "Nothing found matching that query.",
      });
    }

    return json({
      ok: true,
      query_used: queryUsed,
      compound_stale: compoundStale ?? null,
      results: matches.map((m, i) => {
        const s = full
          ? { text: m.content, truncated: false, fullLength: (m.content ?? "").length }
          : snippetOf(m.content, allowanceFor(i, m.score, cfg), { queryTokens });
        return {
          id: m.id,
          content: s.text,
          truncated: s.truncated,
          full_length: s.fullLength,
          score: parseFloat((m.score * 100).toFixed(1)),
          tags: m.tags,
          source: m.source,
          created_at: m.createdAt,
          updated_at: m.updatedAt,
          stale_as_of: m.staleAsOf,
          updated: m.isUpdate,
          hop: m.hop,
          via_provenance: m.viaProvenance ?? null,
          via_type: m.viaType ?? null,
          linked_at: m.viaLinkedAt ?? null,
          related_to: m.viaFrom ?? null,
        };
      }),
      insight: insight || null,
      semantic_unavailable: semanticUnavailable,
    });
  }

  // POST /chat
  if (url.pathname === "/chat" && request.method === "POST") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    let body: { query?: string; memories?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.query?.trim()) return json({ ok: false, error: "query is required" }, 400);

    // The memories arrive numbered, dated and attributed (see the client's
    // serializer in public/js/recall.js and the MCP tool's mirror of it), so
    // the model has everything it needs to be specific — it just has to be
    // asked. The previous prompt ended "Be concise", and on a brain holding
    // three days of dense decisions "What did I decide recently?" came back as
    // one sentence about an unrelated email: the top match, summarised, with
    // the other four sources ignored.
    const systemPrompt = `You are a personal memory assistant. Answer the user's question using ONLY the memories provided.

Draw on every memory that bears on the question, not only the closest match — a question about decisions or plans usually has several answers, and reporting one of them is a wrong answer.

Anchor claims in time. The memories are dated; say "On 12 March you decided…" rather than "you decided…". If two memories disagree, say so and lead with the more recent one.

When the answer has several parts, give them as short bullets rather than one crowded sentence.

Cite as you go with the memory's number in square brackets, like [2], matching the numbered list you were given. Cite every claim.

Even if the match scores are low, extract any relevant facts and answer directly. Never say you don't have enough information if the answer exists anywhere in the memories.

Be specific and complete. Concision means leaving out filler, never leaving out facts.`;

    const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;
    const cfg = await resolveConfig(env);

    // Workers AI requires `as any` here — the SDK types don't cover all models
    const stream = await env.AI.run(cfg.LLM_MODEL as any, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      stream: true,
    });

    return new Response(stream as ReadableStream, {
      headers: { "Content-Type": "text/event-stream", ...CORS_HEADERS },
    });
  }

  // GET /digest
  if (url.pathname === "/digest" && request.method === "GET") {
    const authErr = requireAuth(request, env);
    if (authErr) return authErr;
    const tag = url.searchParams.get("tag")?.trim();
    if (!tag) return json({ ok: false, error: "tag parameter is required" }, 400);

    const result = await compressTag(tag, env, ctx);

    if (!result.synthesizedId) {
      return json({ tag, error: "Could not create digest — tag may have fewer than 20 entries or was recently compressed", source_count: result.entriesUsed });
    }

    return json({ tag, synthesis: result.text, entry_id: result.synthesizedId, source_count: result.entriesUsed });
  }

  return null;
}
