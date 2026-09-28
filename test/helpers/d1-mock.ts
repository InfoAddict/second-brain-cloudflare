import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_MIN_RECALL, isTopicTag } from "../../src/compression/eligibility";
import { NOT_HELD_SQL } from "../../src/quarantine/tags";

/**
 * Decode a `%"tag"%` bind parameter back to the tag, undoing tagLikePattern's escaping.
 *
 * Production escapes % and _ in the tag and pairs the clause with ESCAPE '\\', so a tag
 * `q3_planning` arrives here as `%"q3\\_planning"%`. Without this the double would look for
 * a tag spelled with a backslash and silently match nothing.
 */
const tagFromLikePattern = (pattern: string) =>
  pattern.replace(/%"/g, "").replace(/"%/g, "").replace(/\\([%_\\])/g, "$1");

/**
 * Does this tag array satisfy `tags LIKE '%"<tag>"%'`?
 *
 * MODELS: ASCII case-insensitivity. SQLite's LIKE matches `Work` for `%"work"%`, and
 * comparing case-sensitively here would make the double disagree with production on exactly
 * the inputs behind #278's rollup bug, where the candidate `Kind:Semantic` selected — and
 * rolled up — every entry carrying `kind:semantic`. test/unit/d1-mock-fidelity.test.ts pins
 * this; do not "simplify" it back to Array.includes.
 *
 * DOES NOT MODEL, so a green test here is NOT coverage of any of these:
 *   - LIKE wildcards in the tag. Real `%"q3_planning"%` also matches `q3-planning`, and
 *     `%"%"%` matches every row; this matches exactly one tag either way. That is why P1's
 *     escaping bug is covered against real SQLite in test/integration/, not here.
 *   - JSON escaping. A tag containing a quote is stored as \\" so real LIKE misses it;
 *     this compares the decoded strings and matches.
 *   - Unicode case folding. SQLite's LIKE is ASCII-only; toLowerCase is not, so this
 *     matches `Σ`/`σ` where real LIKE does not.
 * Anything whose subject is the pattern rather than the tag belongs in a real-SQLite test.
 */
const tagMatchesLike = (tags: string[], tag: string) =>
  tags.some(t => t.toLowerCase() === tag.toLowerCase());

/** What src/db/init.ts's probe sees on a migrated brain — see the handler in all(). */
const TRIGGER_DDL = new Map([...readFileSync(resolve(import.meta.dirname, "../../db/schema.sql"), "utf8").matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)[\s\S]*?END;/g)].map(m => [m[1], m[0].slice(0, -1)]));
const SCHEMA_PROBE_RESULTS = [
  ...["entries", "edges", "insight_candidates", "workspaces", "users", "memberships",
    "entry_events", "admin_events", "maintenance_cursor", "prompt_capsule_revisions", "projects",
    "push_subscriptions", "entry_versions", "entries_trash", "entries_fts", "entry_counts"]
    .map(name => ({ kind: "table", name })),
  ...["idx_entries_created_at", "idx_entries_source", "idx_entries_workspace_created", "idx_entries_capsule",
    "idx_edges_source", "idx_edges_target", "idx_edges_weight", "idx_insight_candidates_queue",
    "idx_workspaces_kind", "idx_users_token_hash", "idx_users_email", "idx_memberships_workspace",
    "idx_entry_events_entry", "idx_entry_events_created", "idx_admin_events_created",
    "idx_projects_workspace", "idx_entries_project", "idx_entries_conflict_held", "idx_push_subscriptions_workspace",
    "idx_entries_when", "idx_entries_task", "idx_entries_insight", "idx_entries_stale",
    "idx_entry_versions_entry", "idx_entries_trash_deleted"]
    .map(name => ({ kind: "index", name })),
  ...["prompt_capsule_entry_insert", "prompt_capsule_entry_update",
    "prompt_capsule_entry_delete", "prompt_capsule_workspace_delete",
    "entries_fts_insert", "entries_fts_update", "entries_fts_delete",
    "entry_counts_insert", "entry_counts_update", "entry_counts_delete"]
    .map(name => ({ kind: "trigger", name, definition: TRIGGER_DDL.get(name) })),
  ...["id", "content", "tags", "source", "created_at", "vector_ids", "recall_count",
    "importance_score", "contradiction_wins", "contradiction_losses", "updated_at",
    "staleness_checked_at", "when_at", "when_kind", "when_source", "when_label", "valid_from", "valid_until"].map(name => ({ kind: "column", name })),
  ...["workspace_id", "actor_id"].map(name => ({ kind: "column", name })),
  // edges.workspace_id arrives by ALTER on upgraded brains and lives in the base
  // CREATE on fresh ones — either way a migrated brain reports it.
  { kind: "edge_column", name: "workspace_id" },
  { kind: "user_column", name: "default_share" },
  { kind: "user_column", name: "removed_at" },
  { kind: "user_column", name: "last_used_at" },
  // admin_events' subject columns arrive by ALTER on brains created before they
  // existed and live in the base CREATE on fresh ones — a migrated brain reports
  // both either way. Omitting them here would make this double claim a brain
  // whose audit trail cannot record what an action was done TO.
  { kind: "admin_event_column", name: "target_user_id" },
  { kind: "admin_event_column", name: "workspace_id" },
  // entry_versions.prior_length_utf16 arrives by ALTER on brains created before it existed and
  // lives in the base CREATE on fresh ones (T-0089.1.1, ADV-10) — a migrated brain reports it either way.
  { kind: "entry_version_column", name: "prior_length_utf16" },
  // entries_trash.nonce, same shape (T-0089.1.1, adv-final MAJOR 1): ALTER on an old brain, base
  // CREATE on a fresh one, reported either way by a migrated brain.
  { kind: "entries_trash_column", name: "nonce" },
];

/**
 * Values bound through a Params-numbered statement (`?1..?n`, dense, values reused by identity —
 * ADV-1/ADV-2/Task 6), in the order their placeholders appear in the SQL text. `Params` gives a
 * value REUSED verbatim (e.g. tags unchanged: the SET clause and the CAS guard bind the same
 * string) the SAME number, so `args` can be shorter than the number of semantic slots a statement
 * has — indexing positionally into `args` the way earlier, unnumbered branches in this file do
 * would silently misread every slot after the first reuse. This resolves each occurrence back to
 * its real value by placeholder number instead.
 */
function placeholderArgs(sql: string, args: unknown[]): unknown[] {
  return [...sql.matchAll(/\?(\d+)/g)].map(m => args[Number(m[1]) - 1]);
}

export class D1Mock {
  entries: any[] = [];
  edges: any[] = [];
  /** entries_trash rows written by the forget batch (the statements the mock models are the trash ones only). */
  trash: any[] = [];
  // Tenancy rows, populated by the real ensureTenantBootstrap when a route's
  // requireIdentity runs against this double. The statements it issues are
  // modelled just faithfully enough for the owner identity to resolve; member
  // provisioning is covered against real SQLite in test/integration/.
  users: any[] = [];
  workspaces: any[] = [];
  memberships: any[] = [];

  /**
   * Vector id -> the row that listed it, remembered across statements (T-0089.1.1): the index still
   * holds a row's vectors after the write that clears its vector_ids, until they are deleted. Read by
   * make-env's Vectorize double to answer deleteEntryVectors' parentId check the way real data would.
   */
  private listedVectors = new Map<string, string>();
  private rememberListed(): void {
    for (const r of [...this.entries, ...this.trash]) {
      let ids: string[] = [];
      try { ids = JSON.parse(r.vector_ids ?? "[]"); } catch { ids = []; }
      for (const v of ids) if (!this.listedVectors.has(v)) this.listedVectors.set(v, r.id);
    }
  }
  __vectorOwners(): Map<string, string> { this.rememberListed(); return this.listedVectors; }

  prepare(sql: string) {
    if (/^\s*(UPDATE entries|DELETE FROM entries|INSERT INTO entries_trash)/i.test(sql)) this.rememberListed();
    let s = sql.replace(/\s+/g, " ").trim();

    // T-0089.4.2 (quarantine): every read this double models predates held
    // rows, and none of its fixtures seed one, so the clause changes nothing a
    // test here could see. Stripped like the ESCAPE clause below, rather than
    // grown onto every exact-string branch, because it never changes which
    // query a statement IS. Held exclusion itself is covered against real
    // SQLite in test/integration/recall-held.test.ts.
    s = s.replace(new RegExp(` AND ${NOT_HELD_SQL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), "");

    // Team-edition workspace scoping. Production appends `AND workspace_id IN (?, ?)`
    // (or a bare `WHERE` form) whenever an Identity is in play. Every integration test
    // in this file runs as the owner whose bootstrap backfill has already moved all
    // seeded rows into the readable set, so filtering would change nothing — the honest
    // move is to strip the clause AND its bound values so the legacy shape handlers
    // keep matching. Workspace isolation itself is NOT modelled by this double; it is
    // covered against real SQLite in test/integration/team-recall-scoping.test.ts and
    // test/unit/team-scoping.test.ts.
    const scopeDrop = new Set<number>();
    if (/workspace_id IN \(/.test(s)) {
      // The alias prefix is optional: a statement that joins another table
      // qualifies the column (`e.workspace_id`), and missing that form would
      // leave the clause in place AND its workspace ids in `args`, where the
      // branch below reads them as entry ids.
      const clauseRe = /(?:AND |WHERE )(?:[A-Za-z_][A-Za-z0-9_]*\.)?workspace_id IN \(((?:\?(?:, )?)+)\)/g;
      for (const m of s.matchAll(clauseRe)) {
        const offset = (s.slice(0, m.index!).match(/\?/g) ?? []).length;
        const n = (m[1].match(/\?/g) ?? []).length;
        for (let i = 0; i < n; i++) scopeDrop.add(offset + i);
      }
      s = s.replace(clauseRe, " ")
        .replace(/\s{2,}/g, " ").trim()
        // A clause that was the only condition leaves a dangling connector.
        .replace(/^WHERE\s+(?=ORDER\b|LIMIT\b|GROUP\b|$)/i, "")
        .replace(/\bAND\s+\)/g, ")")
        .replace(/WHERE\s*\)/gi, ")");
    }

    // Round 6 (T-0089.1.1): writers that replace vector_ids also compare-and-set the vector_ids they
    // read (`AND e.vector_ids = ?N`). Modelled once here: the clause is checked against the row at run
    // time and stripped, so every existing branch below keeps matching the statement it always did.
    let vectorIdsGuard: { valueIdx: number; idIdx: number } | null = null;
    {
      const vg = /\s+AND e\.vector_ids (?:=|IS) \?(\d+)/.exec(s);
      const idm = /e\.id = \?(\d+)/.exec(s);
      if (vg && idm) {
        vectorIdsGuard = { valueIdx: Number(vg[1]) - 1, idIdx: Number(idm[1]) - 1 };
        s = s.replace(vg[0], "");
      }
    }

    // Production pairs every tag LIKE clause with `ESCAPE '\\'` (see tagLikePattern). The
    // escape clause never changes which query a statement IS, so branches that identify a
    // query by its exact text compare against this form rather than each growing a suffix.
    const sBare = s.replace(/ ESCAPE '\\'/g, "");
    const db = this;

    const makeStmt = (allArgs: any[]) => {
      // Drop the bindings that belonged to the stripped scope clauses, positionally.
      const args = scopeDrop.size ? allArgs.filter((_, i) => !scopeDrop.has(i)) : allArgs;
      const stmt: any = {
      async run() {
        if (vectorIdsGuard) {
          const row = db.entries.find((e: any) => e.id === args[vectorIdsGuard!.idIdx]);
          const expected = args[vectorIdsGuard.valueIdx];
          if (row && expected !== null && (row.vector_ids ?? "[]") !== expected) return { meta: { changes: 0 } };
        }
        // D1 returns each batched statement's rows as well as its meta, and a
        // batch carries reads as well as writes: identity resolution pairs its
        // SELECT with the throttled last_used_at write so the pair costs one
        // subrequest. batch() below runs statements through run(), so a SELECT
        // has to answer with its rows here. Additive — writes are untouched.
        //
        // all() then first(): the branches in this double are split across the
        // two by what each query's only caller happened to use, so a
        // single-row SELECT like IDENTITY_SQL is modelled in first() and
        // answers all() with nothing. Asking both is what makes a batched read
        // see the same row the unbatched one does.
        if (/^\s*(SELECT|WITH)\b/i.test(s)) {
          const many = await stmt.all();
          if (many.results.length) return { ...many, meta: { changes: 0 } };
          const one = await stmt.first();
          return { results: one ? [one] : [], meta: { changes: 0 } };
        }
        // src/db/fts-backfill.ts's nightly integrity-check (Task 5): the
        // literal FTS5 command, not a write to `entries`. Checked before the
        // "INSERT INTO entries" branch below, whose startsWith would otherwise
        // also match "INSERT INTO entries_fts". This mock represents a
        // healthy, migrated brain (see the sqlite_master liveness branch in
        // all()), so the honest answer is success — FTS5's real check would
        // only throw for an index the mock does not simulate corrupting.
        if (s.startsWith("INSERT INTO entries_fts(entries_fts, rank)")) {
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("INSERT INTO workspaces")) {
          db.workspaces.push({ id: args[0], kind: args[1], name: args[2], created_at: args[3] });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO users")) {
          const [id, name, email, role, token_hash, suspended, created_at] = args;
          db.users.push({ id, name, email, role, token_hash, suspended, created_at });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO memberships")) {
          // INSERT ... SELECT ?, ?, ? WHERE NOT EXISTS (... user_id = ? AND workspace_id = ?):
          // the id pair is bound twice, first to write, then to guard.
          const [userId, wsId] = args;
          if (!db.memberships.some((m: any) => m.user_id === userId && m.workspace_id === wsId)) {
            db.memberships.push({ user_id: userId, workspace_id: wsId, created_at: args[2] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("INSERT INTO maintenance_cursor")) {
          return { meta: {} };
        }
        // ensureTenantBootstrap's one-time legacy backfill. Modelled for real so
        // rows pushed by tests without a workspace_id still land in the owner's
        // personal workspace before any scoped read sees them.
        if (s.startsWith("UPDATE entries SET workspace_id = ? WHERE workspace_id = ''")) {
          let n = 0;
          for (const e of db.entries) {
            if (!e.workspace_id) { e.workspace_id = args[0]; n++; }
          }
          return { meta: { changes: n } };
        }
        if (s.startsWith("UPDATE edges SET workspace_id = ? WHERE workspace_id = ''")) {
          let n = 0;
          for (const e of db.edges) {
            if (!e.workspace_id) { e.workspace_id = args[0]; n++; }
          }
          return { meta: { changes: n } };
        }
        if (s.startsWith("INSERT INTO entries (")) {
          const colMatch = s.match(/INSERT INTO entries \(([^)]+)\)/i);
          if (!colMatch) throw new Error("INSERT INTO entries missing column list");
          const cols = colMatch[1].split(",").map(c => c.trim());
          if (cols.length !== args.length) {
            throw new Error(`INSERT INTO entries column/bind mismatch: ${cols.length} vs ${args.length}`);
          }
          const row: Record<string, any> = {
            recall_count: 0,
            importance_score: 0,
            contradiction_wins: 0,
            contradiction_losses: 0,
          };
          cols.forEach((col, i) => { row[col] = args[i]; });
          if (row.updated_at === undefined) row.updated_at = row.created_at ?? Date.now();
          db.entries.push(row);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ?, workspace_id = ? WHERE id")) {
          const [content, vector_ids, tags, updated_at, workspace_id, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; row.tags = tags; row.updated_at = updated_at; row.workspace_id = workspace_id; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ? WHERE id")) {
          const [content, vector_ids, tags, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; row.tags = tags; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // Short append (T-0089.9/ADV-1/ADV-2, buildCasGuard/Params, dense-numbered): content is
        // concatenated in SQL, guarded on tags AND workspace_id (the row this call is authorized
        // for). updated_at is clamped strictly past its own previous value, a bare row reference
        // with no placeholder of its own (MAX(?N, COALESCE(e.updated_at, e.created_at) + 1)).
        if (s.startsWith("UPDATE entries AS e SET content = content || ")) {
          const args2 = placeholderArgs(s, args);
          const hasWhen = /when_at = \?\d+/.test(s);
          const [suffix, indexed, chunk, tags, updated_at, ...rest] = args2;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readTags, workspace_id] = rest;
          const row = db.entries.find((e: any) => e.id === id && (e.tags ?? "[]") === readTags && (e.workspace_id ?? "") === workspace_id);
          if (row) {
            row.content = row.content + suffix;
            if (indexed === 1) row.vector_ids = JSON.stringify([...JSON.parse(row.vector_ids ?? "[]"), chunk]);
            row.tags = tags; row.updated_at = updated_at;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // A person's or a system's merge/replace commit (entry.ts), vector_ids folded into the same
        // guarded UPDATE (ADV-4 residual): SET content, tags, updated_at, vector_ids, guarded on
        // TAGS first then content (systemCasColumns/personCasColumns build tags before content —
        // the update/append branch below guards content first, which is how the two are told apart
        // here). The system form adds the actor/source identity check (an empty actor, its own source).
        if (/^UPDATE entries AS e SET content = \?\d+, tags = \?\d+, updated_at = (\?\d+, vector_ids = \?\d+ WHERE e\.id = \?\d+ AND e\.tags|MAX\(\?\d+, COALESCE\(e\.updated_at, e\.created_at\) \+ 1\), vector_ids = \?\d+ WHERE e\.id = \?\d+ AND e\.tags)/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const hasActorSourceTail = s.includes("COALESCE(e.actor_id, '') = ''");
          const [content, tags, updated_at, vector_ids, id, readTags, readContent, workspace_id, source] = args2;
          const row = db.entries.find((e: any) =>
            e.id === id && (e.tags ?? "[]") === readTags && e.content === readContent && (e.workspace_id ?? "") === workspace_id
            && (!hasActorSourceTail || ((e.actor_id ?? "") === "" && e.source === source)));
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // updateEntryContent's compare-and-set commit, and the append long branch (identical
        // shape): updated_at is clamped strictly past its own previous value in both
        // (`updated_at = MAX(?N, COALESCE(e.updated_at, e.created_at) + 1)`, a bare row reference
        // with no extra placeholder of its own), so the two forms need no special-casing here —
        // one placeholder for updated_at's own value, immediately followed by vector_ids, either way.
        // SET content, tags, updated_at, vector_ids atomically (ADV-4), guarded on content, tags AND
        // workspace_id (ADV-2, buildCasGuard).
        if (/^UPDATE entries AS e SET content = \?\d+, tags = \?\d+, updated_at = (\?\d+|MAX\(\?\d+)/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const hasWhen = /when_at = \?\d+/.test(s);
          const [content, tags, updated_at, vector_ids, ...rest] = args2;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readContent, readTags, workspace_id] = rest;
          const row = db.entries.find((e: any) => e.id === id && e.content === readContent && (e.tags ?? "[]") === readTags && (e.workspace_id ?? "") === workspace_id);
          if (row) {
            row.content = content; row.tags = tags; row.updated_at = updated_at; row.vector_ids = vector_ids;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // applyStatus's non-deprecated branch (lifecycle.ts, R2-3): SET tags alone, guarded on
        // workspace_id — the row moved out of the caller's authorized workspace misses.
        if (/^UPDATE entries AS e SET tags = \?\d+ WHERE e\.id = \?\d+ AND e\.workspace_id = \?\d+$/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const [tags, id, workspace_id] = args2;
          const row = db.entries.find((e: any) => e.id === id && (e.workspace_id ?? "") === workspace_id);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        // deprecateEntry (lifecycle.ts, R2-3): SET tags and empty vector_ids, guarded on workspace_id
        // alone — the caller already read tags to compute the deprecated set, so there is nothing
        // else to re-check. Checked first (a strict end anchor) so entry.ts's wider contradiction
        // shape below, which guards tags/content too, is not shadowed by this simpler prefix.
        if (/^UPDATE entries AS e SET tags = \?\d+, vector_ids = '\[\]' WHERE e\.id = \?\d+ AND e\.workspace_id = \?\d+$/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const [tags, id, workspace_id] = args2;
          const row = db.entries.find((e: any) => e.id === id && (e.workspace_id ?? "") === workspace_id);
          if (row) { row.tags = tags; row.vector_ids = "[]"; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // A system job's contradiction deprecation (entry.ts): SET tags and empty vector_ids, guarded
        // on tags, content, workspace_id and the same actor/source identity check.
        if (/^UPDATE entries AS e SET tags = \?\d+, vector_ids = '\[\]' WHERE e\.id/.test(s)) {
          const args2 = placeholderArgs(s, args);
          const [tags, id, readTags, readContent, workspace_id, source] = args2;
          const row = db.entries.find((e: any) =>
            e.id === id && (e.tags ?? "[]") === readTags && e.content === readContent && (e.workspace_id ?? "") === workspace_id
            && (e.actor_id ?? "") === "" && e.source === source);
          if (row) { row.tags = tags; row.vector_ids = "[]"; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // Short append: content is concatenated in SQL and the write compares-and-sets on the tags it read.
        if (s.startsWith("UPDATE entries SET content = content || ?, vector_ids = CASE WHEN ? = 1")) {
          const hasWhen = s.includes("when_at = ?");
          const [suffix, indexed, chunk, tags, updated_at, ...rest] = args;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readTags] = rest;
          const row = db.entries.find((e: any) => e.id === id && (e.tags ?? "[]") === readTags);
          if (row) {
            row.content = row.content + suffix;
            if (indexed === 1) row.vector_ids = JSON.stringify([...JSON.parse(row.vector_ids ?? "[]"), chunk]);
            row.tags = tags; row.updated_at = updated_at;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // Long append: compare-and-set on content and tags. Also mirror.ts's sync commit, whose
        // updated_at is clamped strictly past its own previous value (a bare row reference, MAX(?,
        // COALESCE(updated_at, created_at) + 1)) — one placeholder for its own value either way.
        if ((s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ?") || s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = MAX(?,")) && s.includes("WHERE id = ? AND content = ? AND tags = ?")) {
          const hasWhen = s.includes("when_at = ?");
          const [content, tags, updated_at, ...rest] = args;
          const when = hasWhen ? rest.splice(0, 2) : [];
          const [id, readContent, readTags] = rest;
          const row = db.entries.find((e: any) => e.id === id && e.content === readContent && (e.tags ?? "[]") === readTags);
          if (row) {
            row.content = content; row.tags = tags; row.updated_at = updated_at;
            if (hasWhen) { row.when_at = when[0]; row.when_kind = when[1]; row.when_source = "explicit"; }
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // An append that also sets the time anchor (Task 3 folds the separate `when` UPDATE into the batch).
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ?, when_at = ?, when_kind = ?, when_source = 'explicit' WHERE id")) {
          const [content, vector_ids, tags, updated_at, when_at, when_kind, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { Object.assign(row, { content, vector_ids, tags, updated_at, when_at, when_kind, when_source: "explicit" }); }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ?, when_at = ?, when_kind = ?, when_source = 'explicit' WHERE id")) {
          const [content, tags, updated_at, when_at, when_kind, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { Object.assign(row, { content, tags, updated_at, when_at, when_kind, when_source: "explicit" }); }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ? WHERE id")) {
          const [content, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, vector_ids")) {
          const [tags, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.tags = tags; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = ?, workspace_id")) {
          const [vector_ids, workspace_id, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.vector_ids = vector_ids; row.workspace_id = workspace_id; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids")) {
          const [vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          // storeEntry's and the nightly pass's compare-and-set on the vector_ids read (round 6).
          if (row && s.endsWith("AND vector_ids = ?") && (row.vector_ids ?? "[]") !== args[args.length - 1]) return { meta: { changes: 0 } };
          if (row && s.includes("AND vector_ids = '[]'") && (row.vector_ids ?? "[]") !== "[]") return { meta: { changes: 0 } };
          if (row) row.vector_ids = vector_ids;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id = ? AND tags = ?")) {
          const [tags, id, expectedTags] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row && row.tags === expectedTags) {
            row.tags = tags;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ? WHERE id = ? AND tags = ? AND content = ?")) {
          // Staleness CAS: guards content as well as tags, because the verdict being
          // written is derived from content and the tag mutation is often a no-op.
          const [tags, staleness_checked_at, id, expectedTags, expectedContent] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row && row.tags === expectedTags && row.content === expectedContent) {
            row.tags = tags;
            row.staleness_checked_at = staleness_checked_at;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("UPDATE entries SET staleness_checked_at = ? WHERE id = ?")) {
          const [staleness_checked_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.staleness_checked_at = staleness_checked_at;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET when_at = ?, when_kind = ?, when_source = 'explicit' WHERE id = ?")) {
          const [when_at, when_kind, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.when_at = when_at; row.when_kind = when_kind; row.when_source = "explicit"; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // classify writes: compare-and-set on the tags read (T-0089.10).
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id = ? AND tags = ?")) {
          const [tags, id, readTags] = args;
          const row = db.entries.find((e: any) => e.id === id && (e.tags ?? "[]") === readTags);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id")) {
          const [tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ?, workspace_id = ? WHERE id")) {
          const [content, tags, updated_at, workspace_id, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; row.workspace_id = workspace_id; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        // updateEntryContent's compare-and-set commit.
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ? AND content = ? AND tags = ?")) {
          const [content, tags, updated_at, id, readContent, readTags] = args;
          const row = db.entries.find((e: any) => e.id === id && e.content === readContent && (e.tags ?? "[]") === readTags);
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id")) {
          const [content, tags, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, updated_at = ? WHERE id")) {
          const [content, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags")) {
          const [content, tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ? WHERE id")) {
          const [content, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.content = content;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content ||")) {
          // digest.ts's markSourcesRolledUp (many-row, guarded on workspace_id + each source's own
          // (rowVersion = COALESCE(updated_at, created_at), byte length of content) — a JSON tuple
          // list, not a literal id per statement.
          const [addition, now, workspaceId, tuplesJson] = args;
          const tuples = JSON.parse(tuplesJson) as [string, number, number][];
          let changes = 0;
          for (const [id, rowVersion, contentBytes] of tuples) {
            const row = db.entries.find((e: any) => e.id === id);
            if (!row) continue;
            if ((row.workspace_id ?? "") !== workspaceId) continue;
            if ((row.updated_at ?? row.created_at) !== rowVersion) continue;
            if (Buffer.byteLength(row.content ?? "") !== contentBytes) continue;
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes("rolled-up")) tags.push("rolled-up");
            row.tags = JSON.stringify(tags);
            row.content = row.content + addition;
            row.updated_at = now;
            changes++;
          }
          return { meta: { changes } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]'")) {
          const [tag, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes(tag)) tags.push(tag);
            row.tags = JSON.stringify(tags);
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_wins = contradiction_wins + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_wins = (row.contradiction_wins ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_losses = contradiction_losses + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_losses = (row.contradiction_losses ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET recall_count")) {
          // `WHERE id = ?` or `WHERE id IN (?, ...)`: every bound arg is an id.
          const rows = db.entries.filter((e: any) => args.includes(e.id));
          for (const row of rows) row.recall_count = (row.recall_count ?? 0) + 1;
          return { meta: { changes: rows.length } };
        }
        if (s.startsWith("UPDATE entries SET importance_score")) {
          const [score, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.importance_score = score;
          return { meta: { changes: row ? 1 : 0 } };
        }
        // The trash batch (src/memory/trash.ts trashManyStatements): every id list is one JSON parameter.
        if (s.startsWith("INSERT INTO entries_trash")) {
          const [idsJson, now, by, channel, reason] = args;
          const withEdges = s.includes("json_group_array");
          const rows = db.entries.filter((e: any) => (JSON.parse(idsJson) as string[]).includes(e.id));
          for (const e of rows) {
            const { id, content, vector_ids, ...rest } = e;
            const edges = withEdges ? db.edges.filter((g: any) => g.source_id === id || g.target_id === id) : [];
            // A plain INSERT, as in SQLite: an id already in the trash is a PRIMARY KEY error.
            if (db.trash.some((t: any) => t.id === id)) throw new Error("UNIQUE constraint failed: entries_trash.id");
            db.trash.push({ id, workspace_id: e.workspace_id ?? "", actor_id: e.actor_id ?? "", content, row_json: JSON.stringify(rest), edges_json: JSON.stringify(edges), vector_ids: vector_ids ?? "[]", deleted_at: now, deleted_by: by, channel, reason });
          }
          return { meta: { changes: rows.length } };
        }
        if (s.startsWith("DELETE FROM entry_versions")) return { meta: { changes: 0 } };
        if (s.startsWith("DELETE FROM edges WHERE source_id IN (SELECT value FROM json_each")) {
          const ids = new Set(JSON.parse(args[0]) as string[]);
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !ids.has(e.source_id) && !ids.has(e.target_id));
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id IN (SELECT value FROM json_each")) {
          const ids = new Set(JSON.parse(args[0]) as string[]);
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => !ids.has(e.id));
          return { meta: { changes: before - db.entries.length } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id")) {
          const [id] = args;
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => e.id !== id);
          return { meta: { changes: before - db.entries.length } };
        }
        if (s.startsWith("INSERT INTO edges")) {
          const placeholderCount = (s.match(/\?/g) ?? []).length;
          if (placeholderCount !== args.length) {
            throw new Error(`INSERT INTO edges placeholder/bind mismatch: ${placeholderCount} vs ${args.length}`);
          }
          // The guarded form (edgeInsertStatement's onlyIfNoTypedEdge): the row's
          // ten values, then the pair the guard tests. Modelled here because the
          // rule lives in the statement, so a mock that ignored it would report
          // an insert production would have skipped.
          // The endpoint readability guard every edge insert carries (edgeEndpointsReadableSql): the
          // ten values, then source, readable JSON, target, readable JSON.
          let guardEnd = 10;
          if (s.includes("json_each")) {
            const [gs, gsr, gt, gtr] = args.slice(10, 14);
            guardEnd = 14;
            const readableIn = (id: unknown, json: unknown) => {
              const allowed = JSON.parse(String(json)) as string[];
              return db.entries.some((e: any) => e.id === id && allowed.includes(e.workspace_id ?? ""));
            };
            if (!readableIn(gs, gsr) || !readableIn(gt, gtr)) return { meta: { changes: 0 } };
          }
          if (s.includes("AND NOT EXISTS")) {
            const [ga, gb, gc, gd] = args.slice(guardEnd);
            const typed = db.edges.some((e: any) =>
              ((e.source_id === ga && e.target_id === gb) || (e.source_id === gc && e.target_id === gd))
              && e.type !== "relates_to");
            if (typed) return { meta: { changes: 0 } };
          }
          const [id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at] = args;
          const existing = db.edges.find((e: any) => e.source_id === source_id && e.target_id === target_id && e.type === type);
          if (existing) {
            existing.weight = Math.max(existing.weight, weight); // ON CONFLICT ... max(weight)
            existing.updated_at = updated_at;
          } else {
            db.edges.push({ id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM edges WHERE ((source_id")) {
          // deleteEdge: order-agnostic pair delete, optional trailing type filter.
          const [a, b, c, d, type] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => {
            const pairMatch = (e.source_id === a && e.target_id === b) || (e.source_id === c && e.target_id === d);
            if (!pairMatch) return true;
            if (type && e.type !== type) return true;
            return false;
          });
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE source_id")) {
          // Cascade delete on forget: source_id = ? OR target_id = ? (both bound to the same id).
          const [sid, tid] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => e.source_id !== sid && e.target_id !== tid);
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE provenance")) {
          // runGraphPass prune: inferred edges below a weight, older than a cutoff.
          const [weight, age] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !(e.provenance === "inferred" && e.weight < weight && e.updated_at < age));
          return { meta: { changes: before - db.edges.length } };
        }
        return { meta: {} };
      },
      async first() {
        // ── ensureTenantBootstrap / resolveIdentity (tenancy) ──
        if (s.startsWith("SELECT id FROM workspaces WHERE kind")) {
          const kind = s.match(/kind = '(\w+)'/)?.[1];
          const row = db.workspaces
            .filter((w: any) => w.kind === kind)
            .sort((a: any, b: any) => a.created_at - b.created_at)[0];
          return row ? { id: row.id } : null;
        }
        if (s.includes("(SELECT count(*) FROM entries_fts) AS f")) {
          // src/db/fts-backfill.ts's nightly count parity (Task 5), which
          // also reads max rowid for the rotating content check's wrap
          // (combined review FIX 2). The global entries total is summed in
          // JS from the per-workspace GROUP BY (T-0065), answered by the
          // branch above — no separate count(*) over entries exists
          // anymore. This double stands in for a healthy, migrated brain —
          // same stance as the liveness branch in all() — so an fts count
          // equal to the entries count and a max rowid of the entries count
          // is the honest answer; drift is covered against real SQLite in
          // test/unit/fts-backfill.test.ts, which the mock cannot simulate.
          return { f: db.entries.length, mx: db.entries.length };
        }
        if (s.includes("u.role = 'admin'")) {
          // findOwner: oldest admin plus their personal workspace.
          const admin = db.users
            .filter((u: any) => u.role === "admin")
            .sort((a: any, b: any) => a.created_at - b.created_at)[0];
          if (!admin) return null;
          const pm = db.memberships.find((m: any) =>
            m.user_id === admin.id &&
            db.workspaces.some((w: any) => w.id === m.workspace_id && w.kind === "personal"));
          return pm ? { userId: admin.id, personalWorkspaceId: pm.workspace_id } : null;
        }
        if (s.startsWith("SELECT 1 AS ok FROM memberships")) {
          // ownerHasPersonalWorkspace.
          const ok = db.memberships.some((m: any) =>
            m.user_id === args[0] &&
            db.workspaces.some((w: any) => w.id === m.workspace_id && w.kind === "personal"));
          return ok ? { ok: 1 } : null;
        }
        if (s.includes("u.token_hash = ?")) {
          // resolveIdentity's IDENTITY_SQL: token hash to user + both workspaces.
          const user = db.users.find((u: any) => u.token_hash === args[0] && !u.suspended);
          if (!user) return null;
          const wsAll = (kind: string) => db.memberships
            .filter((mm: any) => mm.user_id === user.id)
            .map((mm: any) => db.workspaces.find((w: any) => w.id === mm.workspace_id && w.kind === kind))
            .filter(Boolean);
          const personalWorkspaceId = wsAll("personal")[0]?.id ?? null;
          // The real query aggregates every company membership into one packed
          // `id@created_at` list, because a user may belong to more than one team
          // (memberships is many-to-many). Returning a single id here would have
          // let a mock-backed identity read as a member of one arbitrary team
          // while the real one reads all of them — and the scope bindings that
          // fall out of that list size the D1 batches, so the difference shows up
          // as a subrequest count, not as a wrong row.
          const companyWorkspaces = wsAll("company")
            .map((w: any) => `${w.id}@${w.created_at ?? 0}`)
            .join(",");
          // Personal membership is what authenticates; a team is not required.
          if (!personalWorkspaceId) return null;
          return {
            userId: user.id,
            role: user.role,
            personalWorkspaceId,
            companyWorkspaces: companyWorkspaces || null,
          };
        }
        // GET /entry. Models the COALESCE alias: a row written before the
        // updated_at column exists carries no value, and the route must see
        // created_at rather than undefined.
        if (s.includes("COALESCE(updated_at, created_at) AS last_updated") && s.includes("FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { ...row, last_updated: row.updated_at ?? row.created_at } : null;
        }
        // appendToEntry's own read of the row it edits.
        if (s.includes("SELECT content, tags, source, vector_ids, workspace_id FROM entries WHERE id")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { content: row.content, tags: row.tags ?? "[]", source: row.source, vector_ids: row.vector_ids ?? "[]", workspace_id: row.workspace_id ?? "" } : null;
        }
        if (s.includes("SELECT vector_ids FROM entries WHERE id")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { vector_ids: row.vector_ids } : null;
        }
        // These branches match `as count` in lower case only. src/migration/embedding.ts
        // writes `AS count`, so three of its queries fall through here and return null
        // rather than a row — pre-existing, and those paths are covered against real SQLite
        // in test/integration/embedding-migration.test.ts. Worth knowing before adding a
        // fourth caller and trusting the double.
        // GET /stats's summary. Matched on the two aggregate names that are stable
        // across its scoped and unscoped halves: `count`/`avg_importance` carry a
        // `CASE WHEN workspace_id IN (…)` so the admin's content totals agree with
        // /count, while unvectorized/unclassified stay corpus-wide for the repair
        // panel. This double ignores bindings, so it cannot see that scoping at all
        // — the assertion that it works lives in test/integration/team-isolation.ts
        // against real SQLite. Here the brain is single-user, where both halves
        // agree, so counting every entry is the faithful answer.
        if (s.includes("as unvectorized") && s.includes("as unclassified") && s.includes("AVG(")) {
          const count = db.entries.length;
          const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
          const avg_importance = scored.length > 0
            ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
            : null;
          // The grace cutoff is the only numeric bind in this statement; the scope
          // bindings around it are workspace-id strings.
          const numeric = args.filter((a: any) => typeof a === "number");
          const cutoff = numeric.length > 0 ? Number(numeric[numeric.length - 1]) : undefined;
          const unvectorized = cutoff !== undefined
            ? db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length
            : 0;
          const unclassified = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          return { count, avg_importance, unvectorized, unclassified };
        }
        // POST /vectorize-pending's remaining count (adv-final MAJOR 2): every unindexed row, no
        // grace cutoff, plus the oldest one's created_at so the route can compute retryAfterMs.
        if (s.includes("COUNT(*) as count") && s.includes("MIN(created_at) as oldest") && s.includes("vector_ids = '[]'")) {
          const unindexed = db.entries.filter((e: any) => e.vector_ids === '[]');
          const oldest = unindexed.length ? Math.min(...unindexed.map((e: any) => e.created_at)) : null;
          return { count: unindexed.length, oldest };
        }
        if (s.includes("COUNT(*) as count") && s.includes("vector_ids = '[]'") && s.includes("created_at <")) {
          const cutoff = Number(args[0]);
          const count = db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`)) {
          const count = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count")) {
          return { count: db.entries.length };
        }
        if (s.includes("WHERE id") && !s.includes("json_each")) {
          return db.entries.find((e: any) => e.id === args[0]) ?? null;
        }
        if (s.includes("WHERE tags LIKE") && s.includes("created_at >")) {
          // Cooldown check: find entries matching arg LIKE patterns + any hardcoded tags in SQL
          // Binds are the LIKE pattern(s), the cutoff, and (since the held-digest clause) the workspace id.
          const likePatterns: string[] = args.filter((a: any) => typeof a === "string" && a.startsWith("%")).map((a: any) => String(a));
          const cutoff = args.find((a: any) => typeof a === "number") as number;
          // Extract hardcoded tags from SQL (e.g. '%"synthesized"%')
          const hardcoded = [...s.matchAll(/'%"(\w+)"%'/g)].map(m => m[1]);
          const match = db.entries.find((e: any) => {
            if (e.created_at <= cutoff) return false;
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!hardcoded.every(t => tags.includes(t))) return false;
            return likePatterns.every((p: string) => {
              const tag = tagFromLikePattern(p);
              return tagMatchesLike(tags, tag);
            });
          });
          return match ? { id: match.id } : null;
        }
        return null;
      },
      async all() {
        // src/recall/fts.ts's FTS_LIVENESS_SQL (write-path isolation v2.2,
        // S1): this mock represents a migrated, healthy brain, so the
        // honest answer is all four objects present with their exact
        // stored definitions — the same TRIGGER_DDL text already used for
        // SCHEMA_PROBE_RESULTS below, with "IF NOT EXISTS" stripped the way
        // SQLite itself strips it from sqlite_master.sql.
        if (s.startsWith("SELECT name, sql FROM sqlite_master") && s.includes("entries_fts")) {
          return {
            results: [
              { name: "entries_fts", sql: `CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, content, tokenize='trigram')` },
              ...["entries_fts_insert", "entries_fts_update", "entries_fts_delete"].map(name => ({
                name,
                sql: TRIGGER_DDL.get(name)!.replace(/\bIF NOT EXISTS\s+/i, ""),
              })),
            ],
          };
        }
        // T-0065's entry_counts analogue of the FTS liveness read directly
        // above (FIX 1, final review's nightly check). Same "healthy,
        // migrated brain" stance: all three triggers present with their
        // exact stored bodies.
        if (s.startsWith("SELECT name, sql FROM sqlite_master") && s.includes("entry_counts")) {
          return {
            results: ["entry_counts_insert", "entry_counts_update", "entry_counts_delete"].map(name => ({
              name,
              sql: TRIGGER_DDL.get(name)!.replace(/\bIF NOT EXISTS\s+/i, ""),
            })),
          };
        }
        // FIX 1's per-workspace parity read: this double is a single-user,
        // untenanted brain by default (entries seeded without workspace_id
        // read as "", the pre-tenancy value), and entry_counts is not
        // separately modelled — the honest "healthy brain" answer for both
        // the true count and the cached count is the same grouping over
        // db.entries.
        if (s.startsWith("SELECT workspace_id, count(*) AS n FROM entries GROUP BY workspace_id")
          || s === "SELECT workspace_id, n FROM entry_counts") {
          const byWorkspace = new Map<string, number>();
          for (const e of db.entries) {
            const ws = (e as { workspace_id?: string }).workspace_id ?? "";
            byWorkspace.set(ws, (byWorkspace.get(ws) ?? 0) + 1);
          }
          return { results: [...byWorkspace.entries()].map(([workspace_id, n]) => ({ workspace_id, n })) };
        }
        if (s.startsWith("SELECT type AS kind, name, sql AS definition FROM sqlite_master")) {
          // src/db/init.ts's schema probe. This mock stands in for a deployed brain, and
          // a deployed brain is migrated — its rows carry every ALTER column below — so
          // the honest answer is "all present", which is also what makes the mock report
          // the real cold-start cost of a cold isolate rather than a fresh install's.
          // The names are spelled out rather than imported from init.ts on purpose: a
          // mock that derives its answer from the code under test can only ever agree
          // with it. Fresh and partially-migrated brains are covered against real SQLite
          // in test/unit/db-init.test.ts.
          return { results: SCHEMA_PROBE_RESULTS };
        }
        if (s === "SELECT id FROM entries") {
          return { results: db.entries.map((e: any) => ({ id: e.id })) };
        }
        if (s === "SELECT source_id, target_id, type FROM edges") {
          return {
            results: db.edges.map((e: any) => ({
              source_id: e.source_id,
              target_id: e.target_id,
              type: e.type,
            })),
          };
        }
        if (
          sBare === "SELECT id FROM entries WHERE tags LIKE ?" ||
          sBare === "SELECT id, vector_ids FROM entries WHERE tags LIKE ?" ||
          sBare === "SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ?"
        ) {
          const pattern = String(args[0]);
          const tag = tagFromLikePattern(pattern);
          const results = db.entries
            .filter((e: any) => tagMatchesLike(JSON.parse(e.tags ?? "[]"), tag))
            .map((e: any) => ({ id: e.id, vector_ids: e.vector_ids ?? "[]", content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (/WHERE \(?content LIKE/.test(s) && s.includes("ORDER BY created_at DESC LIMIT")) {
          // Keyword (hybrid recall) query: content LIKE ? OR content LIKE ? ... LIMIT ?. The keyword arm asks for per-term match levels
          // instead of the text (src/recall/keyword-rows.ts): the binds end with the lowercased terms (each once, referenced by number) after the limit.
          const nTerms = (s.match(/ AS p\d+/g) ?? []).length;
          const tail = nTerms;
          const limit = Number(args[args.length - 1 - tail]);
          const patterns = args.slice(0, args.length - 1 - tail).map((a: any) => String(a).replace(/^%/, "").replace(/%$/, "").toLowerCase());
          const terms: string[] = args.slice(args.length - tail).map((a: any) => String(a));
          const alone = (lc: string, at: number, len: number) => !/\w/.test(lc[at - 1] ?? "") && !/\w/.test(lc[at + len] ?? "");
          const level = (lc: string, t: string): number => {
            const first = lc.indexOf(t);
            if (first < 0) return 0;
            if (alone(lc, first, t.length)) return 2;
            const second = lc.indexOf(t, first + 1);
            return second >= 0 && alone(lc, second, t.length) ? 2 : 1;
          };
          const rows = [...db.entries]
            .filter((e: any) => patterns.some((p: string) => String(e.content).toLowerCase().includes(p)))
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => {
              const lc = String(e.content).toLowerCase();
              const row: Record<string, unknown> = { id: e.id, created_at: e.created_at, tags: e.tags, source: e.source };
              terms.forEach((t, i) => { row[`l${i}`] = level(lc, t); });
              return row;
            });
          return { results: rows };
        }
        if (s.includes("FROM entries") && s.includes("id NOT IN (SELECT source_id FROM edges)")) {
          // runGraphPass backfill: entries not referenced by any edge, newest first.
          const linked = new Set(db.edges.flatMap((e: any) => [e.source_id, e.target_id]));
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => {
              if (linked.has(e.id)) return false;
              if (s.includes('"status:deprecated"') && (JSON.parse(e.tags ?? "[]") as string[]).includes("status:deprecated")) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, workspace_id: e.workspace_id ?? "" }));
          return { results: rows };
        }
        if (s.includes("SELECT id, workspace_id, tags, created_at, source FROM entries WHERE id IN")) {
          // inferEdgesOnWrite's one endpoint read: the source row's workspace (to
          // stamp the edge with), each candidate neighbour's (to refuse a pair that
          // disagrees), and — piggybacked on the same statement — the tags and
          // timestamps `follows` typing needs. Rows seeded without the column read
          // as "", the pre-tenancy value, so a fixture that says nothing about
          // workspaces still links exactly as it did.
          //
          // The projection is matched in full ON PURPOSE. When this branch listed
          // only `id, workspace_id` it silently stopped matching the moment
          // production widened the SELECT, and every mock-backed inference then saw
          // ZERO endpoint rows — no workspace refusal, no kind, no timestamps —
          // while the tests kept passing for the wrong reason.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({
              id: e.id,
              workspace_id: e.workspace_id ?? "",
              tags: e.tags ?? "[]",
              created_at: e.created_at ?? 0,
              source: e.source ?? "api",
            }));
          return { results };
        }
        // The disconnect purge's landed-ids read: which of this batch's ids actually got a trash row.
        if (s.startsWith("SELECT id FROM entries_trash WHERE reason = 'disconnect' AND deleted_at =")) {
          const [deletedAt, deletedBy, idsJson] = args;
          const ids = new Set(JSON.parse(idsJson) as string[]);
          const results = db.trash.filter((r: any) => r.reason === "disconnect" && r.deleted_at === deletedAt && r.deleted_by === deletedBy && ids.has(r.id))
            .map((r: any) => ({ id: r.id }));
          return { results };
        }
        // The trash size read (trashSizeSelect): sizes are not modelled beyond content, which is enough for tier 1.
        if (s.includes("length(CAST(e.content AS BLOB)) AS content_bytes")) {
          const ids = JSON.parse(args[0]) as string[];
          const results = db.entries.filter((e: any) => ids.includes(e.id)).map((e: any) => ({
            id: e.id, workspace_id: e.workspace_id ?? "", actor_id: e.actor_id ?? "", vector_ids: e.vector_ids ?? "[]",
            content_bytes: Buffer.byteLength(e.content ?? ""), row_json_bytes: 300, edges_json_bytes: 2,
            vector_ids_bytes: Buffer.byteLength(e.vector_ids ?? "[]"),
          }));
          return { results };
        }
        if (s.includes("SELECT id FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id }));
          return { results };
        }
        if (s.includes("SELECT source_id, target_id, type FROM edges WHERE source_id IN") && s.includes("OR target_id IN")) {
          const ids = new Set(args.map((a: any) => String(a)));
          const results = db.edges
            .filter((e: any) => ids.has(e.source_id) || ids.has(e.target_id))
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type }));
          return { results };
        }
        if (s.includes("FROM edges WHERE source_id IN") && s.includes("OR target_id IN")) {
          // expandGraph BFS / graph edge fetch: every edge touching the frontier, strongest
          // first. Args are the frontier id list bound twice (source_id IN …, target_id IN …).
          const ids = new Set(args.map((a: any) => String(a)));
          const results = db.edges
            .filter((e: any) => ids.has(e.source_id) || ids.has(e.target_id))
            .sort((a: any, b: any) => b.weight - a.weight)
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type, weight: e.weight, provenance: e.provenance, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("SELECT source_id, target_id FROM edges ORDER BY weight DESC")) {
          // buildGraph default mode: strongest edges first (to derive the node set).
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : db.edges.length;
          const results = [...db.edges]
            .sort((a: any, b: any) => b.weight - a.weight)
            .slice(0, limit)
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id }));
          return { results };
        }
        if (s.includes("FROM entries e LEFT JOIN users u ON u.id = e.actor_id")) {
          // buildGraph node hydration. workspace_id/actor_id/source are what the
          // node's `workspace` layer and `actor_name` are derived from; a row
          // seeded without them reads as "", the pre-tenancy value. The join is
          // modelled rather than ignored — it is where the author's name comes
          // from now, and a soft-removed member must resolve to no name at all
          // so the caller falls through to "Former member".
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => {
              const author = db.users.find((u: any) =>
                u.id === (e.actor_id ?? "") && !u.removed_at);
              return {
                id: e.id, content: e.content, tags: e.tags,
                importance_score: e.importance_score ?? 0, created_at: e.created_at,
                workspace_id: e.workspace_id ?? "", actor_id: e.actor_id ?? "",
                source: e.source ?? "", actor_display_name: author?.name ?? null,
                valid_until: e.valid_until ?? null,
              };
            });
          return { results };
        }
        if (s.includes("SELECT id, tags, valid_until FROM entries WHERE id IN")) {
          // expandGraph deprecation and validity check (T-0089.2.1).
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags, valid_until: e.valid_until ?? null }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, source, created_at, valid_until FROM entries WHERE id IN") && !s.includes("tags NOT LIKE")) {
          // Graph node hydration (/connections, /graph). The `tags NOT LIKE` guard
          // keeps this from shadowing recall's hydration query (same columns, but it
          // applies the auto-pattern/deprecated/kind filters itself further down).
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at, valid_until: e.valid_until ?? null }));
          return { results };
        }
        if (s.includes("recall_count, importance_score") && s.includes("WHERE id IN")) {
          const includesContent = s.startsWith("SELECT id, content,");
          const includesHydrationFields = s.startsWith("SELECT id, content, source, created_at, COALESCE(updated_at, created_at) AS last_updated,");
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({
              id: e.id,
              ...(includesContent ? { content: e.content } : {}),
              ...(includesHydrationFields ? {
                source: e.source,
                created_at: e.created_at,
                last_updated: e.updated_at ?? e.created_at,
              } : {}),
              recall_count: e.recall_count ?? 0,
              importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0,
              contradiction_losses: e.contradiction_losses ?? 0,
              tags: e.tags ?? "[]",
            }));
          return { results };
        }
        if (s.includes("SELECT tags FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return { results: row ? [{ tags: row.tags }] : [] };
        }
        if (s.startsWith("SELECT id, tags, content FROM entries WHERE id IN")) {
          // Staleness retry re-read: fresh tags and content for every row whose CAS lost,
          // in one statement. Rows deleted mid-pass simply do not come back.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags, content: e.content }));
          return { results };
        }
        if (s.includes("COALESCE(updated_at, created_at) < ?") && s.includes("SELECT id, content, tags FROM entries")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          // This handler, and the other `tags.includes("auto-pattern"/"auto-insight")`
          // checks below (the recall hydration branches and the digest-candidate
          // branch), enforce the exclusion UNCONDITIONALLY — in JS, on every row,
          // regardless of what the matched SQL string actually says. Unlike
          // `tagMatchesLike` above, which at least reads the bind parameter, these
          // never look at whether the real query has a `tags NOT LIKE
          // '%"auto-pattern"%'`-shaped clause at all. A production query that lost
          // that clause entirely would still be filtered here and the test would
          // stay green. Anything whose subject IS one of those exclusion clauses —
          // asserting it exists, asserting its exact shape — is untestable against
          // this mock and belongs in a `sqlite-d1`-backed test instead.
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (tags.includes("status:deprecated")) return false;
              if (tags.includes("auto-pattern")) return false;
              if (tags.includes("auto-insight")) return false;
              if (tags.includes("synthesized")) return false;
              if (tags.includes("rolled-up")) return false;
              const touched = e.updated_at ?? e.created_at;
              return touched < cutoff;
            })
            .sort((a: any, b: any) => (a.staleness_checked_at ?? 0) - (b.staleness_checked_at ?? 0))
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, source, created_at, updated_at FROM entries WHERE id IN") || s.includes("SELECT id, content, tags, source, created_at, updated_at, workspace_id FROM entries WHERE id IN")) {
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          const rest = args.slice(idCount);
          let argIdx = 0;
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          const explicitTag = s.includes("tags LIKE ?")
            ? tagFromLikePattern(String(rest[argIdx++]))
            : null;
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (tags.includes("auto-insight")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (explicitTag !== null && !tagMatchesLike(tags, explicitTag)) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
            return true;
          });
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          const results = rows.map((e: any) => ({
            id: e.id,
            content: e.content,
            tags: e.tags,
            source: e.source,
            created_at: e.created_at,
            updated_at: e.updated_at ?? e.created_at,
          }));
          return { results };
        }
        if (s.includes("FROM entries WHERE id IN") && s.includes("tags NOT LIKE")) {
          // recallEntries D1 hydration — filter by IDs, exclude auto-pattern/auto-insight entries, apply after/before
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          const rest = args.slice(idCount);
          let argIdx = 0;
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (tags.includes("auto-insight")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
            return true;
          });
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          const results = rows.map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("SELECT id, content, COALESCE(updated_at, created_at) AS row_version FROM entries") && s.includes("WHERE tags LIKE") && s.includes("ORDER BY created_at DESC")) {
          // compressTag raw entries query — tag match, system-tag exclusion, and the
          // recall/age/contradiction eligibility predicate (cutoff is the 2nd bind param).
          const tagPattern = args[0] as string;
          const tag = tagFromLikePattern(tagPattern);
          const cutoff = Number(args[1]);
          // The synthesized/auto-pattern/auto-insight/rolled-up exclusion below is
          // unconditional, not derived from `s` — see the note above the first such
          // check in this file.
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (!tagMatchesLike(tags, tag)) return false;
              if (tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("auto-insight") || tags.includes("rolled-up")) return false;
              // Capsule definitions are never digest members (digest.ts `tags NOT LIKE '%"capsule:%'`).
              if (tags.some(t => t.toLowerCase().startsWith("capsule:"))) return false;
              if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) return false;
              const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
              if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) return false;
              if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, 50)
            .map((e: any) => ({ id: e.id, content: e.content, row_version: e.updated_at ?? e.created_at }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("HAVING count > 10")) {
          // Digest-candidate query (nightly compression + /stats): per-tag count of
          // entries that pass the compression eligibility predicate. Cutoff is args[0].
          const cutoff = Number(args[0]);
          const counts = new Map<string, number>();
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          for (const e of db.entries as any[]) {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (tags.includes("rolled-up") || tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("auto-insight")) continue;
            if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) continue;
            const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
            if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) continue;
            if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) continue;
            for (const t of tags) {
              // The same predicate isTopicTagSql() is generated from, rather than a second
              // copy of the rule: a double that filters differently from production hides
              // exactly the bugs it is supposed to catch.
              if (!isTopicTag(t)) continue;
              counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          }
          const results = [...counts.entries()]
            .filter(([, c]) => c > 10)
            .sort((a, b) => b[1] - a[1])
            .map(([tag, count]) => ({ tag, count }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("GROUP BY value")) {
          // Top tags by frequency — for /stats
          const freq = new Map<string, number>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1));
          });
          const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          return { results: sorted.map(([value, n]) => ({ value, n })) };
        }
        if (s.includes("json_each(entries.tags)")) {
          // Distinct sorted tags — for /tags
          const tags = new Set<string>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => tags.add(t));
          });
          return { results: [...tags].sort().map(t => ({ value: t })) };
        }
        if (s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`) && s.includes("ORDER BY created_at ASC LIMIT")) {
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:'))
            .sort((a: any, b: any) => a.created_at - b.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags }));
          return { results: rows };
        }
        if (s.includes("vector_ids = '[]' AND created_at <") && s.includes("ORDER BY created_at DESC LIMIT")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff)
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results: rows };
        }
        if (s.startsWith("SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries") && s.includes("ORDER BY created_at ASC") && !s.includes("WHERE id = ?")) {
          // GET /export: the caller's readable set, oldest first, no LIMIT. The
          // route appends `WHERE workspace_id IN (?, ?)` (bound to args), so
          // rows outside those workspaces are withheld here too. `last_updated`
          // models the COALESCE, so a row that never had updated_at written
          // exports its created_at.
          const workspaces: string[] = args.map((a: any) => String(a));
          const results = [...db.entries]
            .filter((e: any) => !workspaces.length || workspaces.includes(e.workspace_id ?? ""))
            .sort((a: any, b: any) => a.created_at - b.created_at)
            .map((e: any) => ({
              id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at,
              last_updated: e.updated_at ?? e.created_at,
              recall_count: e.recall_count ?? 0, importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0, contradiction_losses: e.contradiction_losses ?? 0,
            }));
          return { results };
        }
        if (
          s.startsWith("SELECT source_id, target_id, type, weight, provenance, created_at FROM edges") &&
          !s.includes("WHERE source_id IN")
        ) {
          // GET /export: the readable set's edges. The scope clause (if any) has been
          // stripped above along with its bindings; owner-scoped tests see the whole
          // edge set either way, and isolation is covered against real SQLite.
          const results = db.edges
            .map((e: any) => ({
              source_id: e.source_id, target_id: e.target_id, type: e.type,
              weight: e.weight, provenance: e.provenance, created_at: e.created_at,
            }));
          return { results };
        }
        if (s.includes("ORDER BY created_at DESC LIMIT")) {
          const limit = Number(args[args.length - 1]);
          const filterArgs = args.slice(0, -1);
          let argIdx = 0;
          let rows = [...db.entries];
          if (s.includes("tags LIKE ?")) {
            const pattern = String(filterArgs[argIdx++]);
            const tag = tagFromLikePattern(pattern);
            rows = rows.filter((e: any) => tagMatchesLike(JSON.parse(e.tags ?? "[]"), tag));
          }
          if (s.includes("created_at >= ?")) {
            const after = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          rows.sort((a: any, b: any) => b.created_at - a.created_at);
          return { results: rows.slice(0, limit) };
        }
        return { results: [] };
      }
      };
      return stmt;
    };

    return {
      bind(...args: any[]) { return makeStmt(args); },
      ...makeStmt([]),
    };
  }

  async exec(_sql: string) { }
  async batch(stmts: any[]) { return Promise.all(stmts.map((s: any) => s.run())); }
  reset() {
    this.entries = [];
    this.edges = [];
    this.users = [];
    this.workspaces = [];
    this.memberships = [];
  }
}
