/**
 * Projects list view: nav entry, rows from GET /projects?counts=1, the create
 * form with its live slug preview, and the quiet archived section.
 *
 * Same fake-DOM + vm approach as team-panel.test.ts, with the elements scraped
 * from index.html (see _projects-harness.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { PROJECT_ROWS, PROJECT_SCRIPTS, drain, setupProjects } from "./_projects-harness";

const ROOT = resolve(import.meta.dirname, "../..");
const HTML = readFileSync(resolve(ROOT, "public/index.html"), "utf8");

const LIST_OK = { status: 200, body: { projects: PROJECT_ROWS } };

function listRoutes(extra: Record<string, any> = {}) {
  return { "GET /projects": LIST_OK, ...extra };
}

describe("projects nav and markup", () => {
  it("adds a Projects entry to the rail and to the phone navbar", () => {
    expect(HTML).toMatch(/id="sb-tab-projects"[^>]*onclick="switchTab\('projects'\)"/);
    expect(HTML).toMatch(/id="tab-projects"[^>]*onclick="switchTab\('projects'\)"/);
    expect(HTML).toContain('id="screen-projects"');
    expect(HTML).toContain('<script src="js/projects.js"></script>');
  });

  it("switchTab('projects') shows the screen and loads the list", async () => {
    const { ctx, els, calls } = setupProjects({
      routes: listRoutes(),
      scripts: [...PROJECT_SCRIPTS, "public/js/nav.js"],
    });
    ctx.switchTab("projects");
    await drain();
    expect(els.get("screen-projects").classList.contains("active")).toBe(true);
    expect(els.get("tab-projects").classList.contains("active")).toBe(true);
    expect(els.get("sb-tab-projects").classList.contains("active")).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /projects"]);
  });

  it("announces the slug preview politely", () => {
    expect(HTML).toMatch(/id="project-slug-preview"[^>]*aria-live="polite"/);
  });
});

describe("deriveProjectSlug", () => {
  const { ctx } = setupProjects();
  const d = (s: string) => ctx.deriveProjectSlug(s);

  it("lowercases, hyphenates spaces and drops illegal characters", () => {
    expect(d("My App!")).toBe("my-app");
    expect(d("  Trip to Rome 2026 ")).toBe("trip-to-rome-2026");
    expect(d("snake_case ok")).toBe("snake_case-ok");
  });

  it("folds accents rather than dropping the letter", () => {
    expect(d("Café Río")).toBe("cafe-rio");
  });

  it("returns null when nothing usable is left", () => {
    expect(d("!!!")).toBeNull();
    expect(d("   ")).toBeNull();
    expect(d("")).toBeNull();
    expect(d(null as any)).toBeNull();
  });

  it("never starts with a separator and never exceeds 64 characters", () => {
    expect(d("--- lead")).toBe("lead");
    const long = d("a".repeat(100)) as string;
    expect(long.length).toBe(64);
    expect(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(long)).toBe(true);
  });
});

describe("projects list", () => {
  it("asks for counts and archived rows in one request, with the bearer token", async () => {
    const { ctx, calls } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    expect(calls).toHaveLength(1);
    expect(calls[0].query.get("counts")).toBe("1");
    expect(calls[0].query.get("include_archived")).toBe("1");
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
  });

  it("renders name, slug and a pluralized count for each active project", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    const html = els.get("projects-list").innerHTML as string;
    expect(html).toContain("Website relaunch");
    expect(html).toContain("website");
    expect(html).toContain("12 memories");
    expect(html).toContain("Trip to Rome");
    expect(html).toContain("1 memory");
    expect(html).not.toContain("Old app");
  });

  it("shows the description's first line only", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    const html = els.get("projects-list").innerHTML as string;
    expect(html).toContain("Marketing site and docs.");
    expect(html).not.toContain("Second line.");
  });

  it("opens the detail view from a row, keyed by slug and layer", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    const html = els.get("projects-list").innerHTML as string;
    expect(html).toContain("openProject('website', 'personal')");
    expect(html).toContain("openProject('trip-rome', 'company')");
  });

  it("says so when a project has no memories yet", async () => {
    const { ctx, els } = setupProjects({
      routes: { "GET /projects": { body: { projects: [{ ...PROJECT_ROWS[0], count: 0 }] } } },
    });
    await ctx.loadProjects();
    expect(els.get("projects-list").innerHTML).toContain("No memories yet");
  });

  it("marks an approximate count instead of presenting it as exact", async () => {
    const { ctx, els } = setupProjects({
      routes: { "GET /projects": { body: { counts_approximate: true, projects: [{ ...PROJECT_ROWS[0], count: 5000 }] } } },
    });
    await ctx.loadProjects();
    expect(els.get("projects-list").innerHTML).toContain("5,000+");
  });

  it("omits the count when the Worker did not send one", async () => {
    const { ctx, els } = setupProjects({
      routes: { "GET /projects": { body: { projects: [{ ...PROJECT_ROWS[0], count: undefined }] } } },
    });
    await ctx.loadProjects();
    const html = els.get("projects-list").innerHTML as string;
    expect(html).not.toContain("memories");
    expect(html).not.toContain("No memories yet");
  });

  it("escapes names and descriptions", async () => {
    const evil = { ...PROJECT_ROWS[0], name: '<img src=x onerror="alert(1)">', description: "<script>bad()</script>" };
    const { ctx, els } = setupProjects({ routes: { "GET /projects": { body: { projects: [evil] } } } });
    await ctx.loadProjects();
    const html = els.get("projects-list").innerHTML as string;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });

  it("badges the workspace on a team brain only", async () => {
    const team = setupProjects({ routes: listRoutes(), teamMode: true });
    await team.ctx.loadProjects();
    const teamHtml = team.els.get("projects-list").innerHTML as string;
    expect(teamHtml).toContain("Shared");
    expect(teamHtml).toContain("Personal");

    const solo = setupProjects({ routes: listRoutes(), teamMode: false });
    await solo.ctx.loadProjects();
    const soloHtml = solo.els.get("projects-list").innerHTML as string;
    expect(soloHtml).not.toContain("Shared");
    expect(soloHtml).not.toContain("Personal");
  });

  it("reveals the layer picker on a team brain and hides it on a solo one", async () => {
    const team = setupProjects({ routes: listRoutes(), teamMode: true });
    await team.ctx.loadProjects();
    expect(team.els.get("project-layer-wrap").style.display).toBe("");
    const solo = setupProjects({ routes: listRoutes(), teamMode: false });
    await solo.ctx.loadProjects();
    expect(solo.els.get("project-layer-wrap").style.display).toBe("none");
  });

  it("tells a failed load apart from an empty brain, and offers a retry", async () => {
    const { ctx, els } = setupProjects({ routes: { "GET /projects": { status: 500, body: { error: "boom" } } } });
    await ctx.loadProjects();
    const html = els.get("projects-list").innerHTML as string;
    expect(html).toContain("Could not load projects");
    expect(html).toContain("loadProjects()");
    expect(els.get("projects-empty").hidden).toBe(true);
  });

  it("survives the network being down", async () => {
    const { ctx, els } = setupProjects({ routes: {} });
    await ctx.loadProjects();
    expect(els.get("projects-list").innerHTML).toContain("Could not load projects");
  });
});

describe("archived projects", () => {
  it("are kept out of the main list and collapsed behind a quiet toggle", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    expect(els.get("projects-archived").hidden).toBe(false);
    expect(els.get("projects-archived-toggle").textContent).toContain("Archived (1)");
    expect(els.get("projects-archived-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(els.get("projects-archived-list").hidden).toBe(true);
    const html = els.get("projects-archived-list").innerHTML as string;
    expect(html).toContain("Old app");
    expect(html).toContain("project-row--archived");
  });

  it("expand and collapse from the toggle", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    ctx.toggleProjectsArchived();
    expect(els.get("projects-archived-list").hidden).toBe(false);
    expect(els.get("projects-archived-toggle").getAttribute("aria-expanded")).toBe("true");
    ctx.toggleProjectsArchived();
    expect(els.get("projects-archived-list").hidden).toBe(true);
  });

  it("keep their open state across a reload", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    ctx.toggleProjectsArchived();
    await ctx.loadProjects();
    expect(els.get("projects-archived-list").hidden).toBe(false);
  });

  it("leave no section at all when nothing is archived", async () => {
    const { ctx, els } = setupProjects({ routes: { "GET /projects": { body: { projects: [PROJECT_ROWS[0]] } } } });
    await ctx.loadProjects();
    expect(els.get("projects-archived").hidden).toBe(true);
  });
});

describe("empty state", () => {
  it("explains what a project is and puts the create form under the cursor", async () => {
    const { ctx, els } = setupProjects({ routes: { "GET /projects": { body: { projects: [] } } } });
    await ctx.loadProjects();
    expect(els.get("projects-empty").hidden).toBe(false);
    expect(els.get("project-create").hidden).toBe(false);
    expect(els.get("project-name").focusCalls).toBeGreaterThan(0);
    expect(els.get("projects-list").innerHTML).toBe("");
    // The header button would duplicate the open form.
    expect(els.get("project-new-btn").hidden).toBe(true);
  });

  it("gives way to the list, with the form folded behind New project", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    expect(els.get("projects-empty").hidden).toBe(true);
    expect(els.get("project-create").hidden).toBe(true);
    expect(els.get("project-new-btn").hidden).toBe(false);
    expect(els.get("project-new-btn").getAttribute("aria-expanded")).toBe("false");
    expect(els.get("project-name").focusCalls).toBe(0);
  });

  it("treats a brain with only archived projects as having none to show", async () => {
    const { ctx, els } = setupProjects({ routes: { "GET /projects": { body: { projects: [PROJECT_ROWS[2]] } } } });
    await ctx.loadProjects();
    expect(els.get("projects-empty").hidden).toBe(false);
    expect(els.get("projects-archived").hidden).toBe(false);
  });

  it("New project opens the form and focuses the name; pressing it again closes it", async () => {
    const { ctx, els } = setupProjects({ routes: listRoutes() });
    await ctx.loadProjects();
    ctx.toggleProjectCreate();
    expect(els.get("project-create").hidden).toBe(false);
    expect(els.get("project-new-btn").getAttribute("aria-expanded")).toBe("true");
    expect(els.get("project-name").focusCalls).toBe(1);
    ctx.toggleProjectCreate();
    expect(els.get("project-create").hidden).toBe(true);
  });
});

describe("create form", () => {
  async function ready(routes: Record<string, any> = listRoutes(), teamMode = false) {
    const h = setupProjects({ routes, teamMode });
    await h.ctx.loadProjects();
    return h;
  }
  const type = (h: any, name: string) => {
    h.els.get("project-name").value = name;
    h.ctx.onProjectNameInput();
  };

  it("previews the slug as the name is typed", async () => {
    const h = await ready();
    type(h, "My App!");
    expect(h.els.get("project-slug-preview").textContent).toContain("my-app");
    expect(h.els.get("project-create-btn").disabled).toBe(false);
    type(h, "My App! 2");
    expect(h.els.get("project-slug-preview").textContent).toContain("my-app-2");
  });

  it("holds Create back until the name yields a slug, and says why", async () => {
    const h = await ready();
    type(h, "");
    expect(h.els.get("project-create-btn").disabled).toBe(true);
    expect(h.els.get("project-slug-preview").textContent).toContain("short name");
    type(h, "!!!");
    expect(h.els.get("project-create-btn").disabled).toBe(true);
    expect(h.els.get("project-slug-preview").textContent).toContain("letter or number");
  });

  it("warns before the Worker has to refuse a slug that is already taken", async () => {
    const h = await ready();
    type(h, "Website");
    expect(h.els.get("project-slug-preview").textContent).toContain("already exists");
    expect(h.els.get("project-create-btn").disabled).toBe(true);
  });

  it("posts the previewed slug as the id, so what was shown is what is saved", async () => {
    const h = await ready({ ...listRoutes(), "POST /projects": { status: 201, body: { project: { id: "my-app" } } } });
    type(h, "  My App!  ");
    h.els.get("project-desc").value = "Notes here";
    await h.ctx.submitProject();
    const post = h.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ id: "my-app", name: "My App!", description: "Notes here" });
    expect(post.headers["Content-Type"]).toBe("application/json");
  });

  it("omits an empty description", async () => {
    const h = await ready({ ...listRoutes(), "POST /projects": { status: 201, body: {} } });
    type(h, "Solo");
    await h.ctx.submitProject();
    expect(h.calls.find((c) => c.method === "POST")!.body).toEqual({ id: "solo", name: "Solo" });
  });

  it("sends the chosen layer on a team brain and nothing on a solo one", async () => {
    const team = await ready({ ...listRoutes(), "POST /projects": { status: 201, body: {} } }, true);
    type(team, "Shared thing");
    team.els.get("project-layer").value = "company";
    await team.ctx.submitProject();
    expect(team.calls.find((c) => c.method === "POST")!.body.workspace).toBe("company");

    const solo = await ready({ ...listRoutes(), "POST /projects": { status: 201, body: {} } }, false);
    type(solo, "Solo thing");
    await solo.ctx.submitProject();
    expect("workspace" in solo.calls.find((c) => c.method === "POST")!.body).toBe(false);
  });

  it("on success clears the form, confirms with a toast and reloads the list", async () => {
    const h = await ready({ ...listRoutes(), "POST /projects": { status: 201, body: {} } });
    h.ctx.toggleProjectCreate();
    type(h, "My App");
    h.els.get("project-desc").value = "x";
    await h.ctx.submitProject();
    expect(h.els.get("project-name").value).toBe("");
    expect(h.els.get("project-desc").value).toBe("");
    expect(h.toastHtml()).toContain("My App");
    expect(h.calls.filter((c) => c.method === "GET" && c.path === "/projects")).toHaveLength(2);
    expect(h.els.get("project-create").hidden).toBe(true);
    expect(h.els.get("project-create-btn").disabled).toBe(true);
  });

  it("keeps what was typed and explains a 409", async () => {
    const h = await ready({ ...listRoutes(), "POST /projects": { status: 409, body: { error: "exists" } } });
    type(h, "Fresh");
    await h.ctx.submitProject();
    expect(h.els.get("project-create-error").textContent).toContain("already exists");
    expect(h.els.get("project-create-error").hidden).toBe(false);
    expect(h.els.get("project-name").value).toBe("Fresh");
    expect(h.els.get("project-create-btn").disabled).toBe(false);
    expect(h.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("shows the Worker's message for any other refusal", async () => {
    const h = await ready({ ...listRoutes(), "POST /projects": { status: 400, body: { error: "name too long" } } });
    type(h, "Fresh");
    await h.ctx.submitProject();
    expect(h.els.get("project-create-error").textContent).toContain("name too long");
  });

  it("falls back to a plain message when the network fails", async () => {
    const h = await ready();
    type(h, "Fresh");
    await h.ctx.submitProject();
    expect(h.els.get("project-create-error").textContent).toContain("Could not create the project");
    expect(h.els.get("project-create-btn").disabled).toBe(false);
  });

  it("does not post twice while the first request is in flight", async () => {
    let release: (v?: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const h = setupProjects({
      routes: {
        ...listRoutes(),
        "POST /projects": (() => ({ status: 201, body: {} })) as any,
      },
    });
    await h.ctx.loadProjects();
    const realFetch = h.ctx.fetch;
    h.ctx.fetch = async (u: string, i: any) => {
      if (i?.method === "POST") await gate;
      return realFetch(u, i);
    };
    type(h, "Once");
    const first = h.ctx.submitProject();
    const second = h.ctx.submitProject();
    release();
    await Promise.all([first, second]);
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("clears a stale error as soon as the name changes", async () => {
    const h = await ready({ ...listRoutes(), "POST /projects": { status: 409, body: {} } });
    type(h, "Fresh");
    await h.ctx.submitProject();
    type(h, "Fresher");
    expect(h.els.get("project-create-error").hidden).toBe(true);
  });
});
