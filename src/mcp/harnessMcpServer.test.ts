import { describe, expect, it } from "vitest";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { HarnessControlService, RunControl } from "../services/harnessControlService";
import { HARNESS_DASHBOARD_HTML } from "./harnessDashboardHtml";
import {
  APP_MIME_TYPE,
  DASHBOARD_URI,
  HarnessMcpServer,
  UI_EXTENSION,
} from "./harnessMcpServer";

const ROOT = "C:/repo";
const AT = "2026-10-08T10:00:00.000Z";

function gate(overrides: Partial<TaskStage> = {}): TaskStage {
  return {
    id: "review",
    name: "Code review",
    kind: "codeReview",
    status: "awaiting-approval",
    intent: "review",
    splittable: false,
    requiresApproval: true,
    subtasks: [{ id: "s1", title: "review", prompt: "review", status: "done", reply: "VERDICT: pass" }],
    ...overrides,
  };
}

function task(stages: TaskStage[]): TaskWorkspace {
  const pipeline: TaskPipeline = { routeId: "r", routeLabel: "Report change", stages };
  return {
    id: "t1",
    name: "Pyramid export",
    repositoryRoot: ROOT,
    worktreePath: "C:/repo-worktrees/t1",
    branchName: "feat/pyramid",
    baseBranch: "DEV",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    pipeline,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function setup(
  stages: TaskStage[] = [gate()],
  appCapable = true,
  options: { runs?: RunControl; advanceAfterAnswering?: boolean; pipeline?: Partial<TaskPipeline> } = {},
) {
  const repository = new InMemoryTaskRepository();
  const seeded = task(stages);
  await repository.save({ ...seeded, pipeline: { ...seeded.pipeline!, ...options.pipeline } });
  const service = new HarnessControlService(repository, ROOT, { now: () => AT }, undefined, options.runs);
  const server = new HarnessMcpServer(
    service,
    HARNESS_DASHBOARD_HTML,
    { name: "test", version: "0", repositoryRoot: ROOT },
    undefined,
    () => options.advanceAfterAnswering ?? false,
  );
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<Json> =>
    ((await server.handle({ jsonrpc: "2.0", id: ++id, method, params })) as { result: Json }).result;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "claude-ai" },
    capabilities: appCapable
      ? { extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME_TYPE] } } }
      : {},
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    rpc("tools/call", { name, arguments: args });
  return { repository, rpc, call, server };
}

describe("HarnessMcpServer", () => {
  it("offers no decision tool to a host that cannot keep it from the model", async () => {
    const { rpc, call } = await setup([gate()], false);
    const names = (await rpc("tools/list")).tools.map((t: { name: string }) => t.name);

    expect(names).toContain("harness_dashboard");
    expect(names).not.toContain("harness_approve_stage");
    expect(names).not.toContain("harness_set_checklist_item");
    const refused = await call("harness_approve_stage", { taskId: "t1", stageId: "review", revision: "x" });
    expect(refused.isError).toBe(true);
  });

  it("marks every decision tool app-only and links the dashboard to its resource", async () => {
    const { rpc } = await setup();
    const tools: { name: string; _meta?: Json }[] = (await rpc("tools/list")).tools;
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta;

    for (const name of [
      "harness_approve_stage",
      "harness_retry_stage",
      "harness_set_checklist_item",
      "harness_refresh",
    ]) {
      expect(meta(name)?.ui?.visibility).toEqual(["app"]);
    }
    expect(meta("harness_dashboard")?.ui?.resourceUri).toBe(DASHBOARD_URI);
  });

  it("serves the dashboard as an MCP App resource", async () => {
    const { rpc } = await setup();
    const listed = (await rpc("resources/list")).resources;
    expect(listed[0]).toMatchObject({ uri: DASHBOARD_URI, mimeType: APP_MIME_TYPE });
    const read = (await rpc("resources/read", { uri: DASHBOARD_URI })).contents[0];
    expect(read.mimeType).toBe(APP_MIME_TYPE);
    expect(read.text).toContain("ui/initialize");
  });

  it("opens on the board, saying what each run needs, and opens no run unasked", async () => {
    const { call } = await setup();
    const result = await call("harness_dashboard");

    expect(result.structuredContent.run).toBeNull();
    expect(result.structuredContent.runs[0].attention).toMatchObject({
      need: "Approve “Code review”",
      tone: "act",
      stageId: "review",
    });
    expect(result.content[0].text).toContain("Needs you (1):");
    expect(result.content[0].text).toContain("Approve “Code review”");
  });

  it("keeps the revision out of what the model reads", async () => {
    const { call } = await setup();
    const result = await call("harness_dashboard", { taskId: "t1" });
    const revision = result.structuredContent.run.revision;

    expect(typeof revision).toBe("string");
    expect(result.content[0].text).toContain("Code review");
    expect(result.content[0].text).not.toContain(revision);
  });

  it("records an approval through the store, and a second press as already done", async () => {
    const { call, repository } = await setup();
    const shown = (await call("harness_refresh", { taskId: "t1" })).structuredContent.run;

    const first = await call("harness_approve_stage", {
      taskId: "t1",
      stageId: "review",
      revision: shown.revision,
      note: "deploy only the pyramid project",
    });
    // The same button, in a second client still holding what it rendered.
    const second = await call("harness_approve_stage", {
      taskId: "t1",
      stageId: "review",
      revision: shown.revision,
    });

    expect(first.structuredContent).toMatchObject({ ok: true, changed: true });
    expect(second.structuredContent).toMatchObject({ ok: true, changed: false });
    const saved = (await repository.get("t1"))!.pipeline!;
    expect(saved.stages[0].status).toBe("passed");
    expect(saved.interventions?.filter((i) => i.kind === "approval")).toHaveLength(1);
    expect(saved.guidance?.[0].text).toBe("deploy only the pyramid project");
  });

  it("refuses a decision made against a run that has since moved", async () => {
    const { call, repository } = await setup([
      gate(),
      gate({ id: "later", name: "Later", status: "pending" }),
    ]);
    const shown = (await call("harness_refresh", { taskId: "t1" })).structuredContent.run;

    // VS Code changes something in between.
    const current = (await repository.get("t1"))!;
    await repository.save({
      ...current,
      pipeline: { ...current.pipeline!, stages: [current.pipeline!.stages[0], gate({ id: "later", name: "Later", status: "pending", intent: "edited" })] },
    });

    const outcome = await call("harness_approve_stage", {
      taskId: "t1",
      stageId: "review",
      revision: shown.revision,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.structuredContent.kind).toBe("stale");
    expect((await repository.get("t1"))!.pipeline!.stages[0].status).toBe("awaiting-approval");
  });

  it("ticks a verification item at the gate that reads it", async () => {
    const { call, repository } = await setup([
      gate({
        id: "verify",
        name: "Verify locally",
        kind: "humanVerification",
        checklist: [
          { id: "c1", text: "totals match the workbook", checked: false, raisedByStage: "verify" },
        ],
      }),
    ]);
    const shown = (await call("harness_refresh", { taskId: "t1" })).structuredContent.run;
    expect(shown.stages[0].checklist[0]).toMatchObject({ id: "c1", holding: true });

    await call("harness_set_checklist_item", { taskId: "t1", itemId: "c1", checked: true });
    expect((await repository.get("t1"))!.pipeline!.stages[0].checklist![0].checked).toBe(true);
  });

  it("answers an unknown request with an empty success and a notification with nothing", async () => {
    const { rpc, server } = await setup();
    expect(await rpc("server/discover")).toEqual({});
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });
});

describe("running a route from the dashboard", () => {
  const started: string[] = [];
  const runs: RunControl = {
    async start(taskId) {
      started.push(taskId);
      return { ok: true, message: "Advancing in a headless runner (pid 42)." };
    },
  };
  const implementing = (status: TaskStage["status"] = "pending"): TaskStage => ({
    ...gate(),
    id: "impl",
    name: "Implement",
    kind: "implementation",
    status,
    requiresApproval: false,
    subtasks: [{ id: "impl-1", title: "x", prompt: "x", status: status === "active" ? "active" : "pending" }],
  });
  const question = {
    stageId: "impl",
    stageName: "Implement",
    subtaskId: "impl-1",
    askedAt: "2026-10-08T09:00:00.000Z",
    items: [{ id: "impl-1-q1", text: "Which tab?" }],
  };

  it("records a decision on a held call for the process holding it, and shows it in the snapshot", async () => {
    const held = { id: "g1", tool: "Bash", detail: "git push", waitingSince: "2026-10-08T09:00:00.000Z" };
    const { call, repository } = await setup([implementing("active")], true, { pipeline: { heldCalls: [held] } });
    const run = await call("harness_get_run", { taskId: "t1" });
    expect(run.content[0].text).toContain("Waiting for permission: Bash — git push");

    const result = await call("harness_decide_held_call", { taskId: "t1", callId: "g1", allow: false });
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect((await repository.get("t1"))?.pipeline?.heldCalls?.[0].decision).toMatchObject({
      allow: false,
      scope: "once",
    });
    expect((await call("harness_decide_held_call", { taskId: "t1", callId: "gone", allow: true })).isError).toBe(true);
  });

  it("starts a run and reports what the runner said", async () => {
    started.length = 0;
    const { call } = await setup([implementing()], true, { runs });
    const result = await call("harness_advance_route", { taskId: "t1" });
    expect(result.structuredContent).toMatchObject({ ok: true, message: "Advancing in a headless runner (pid 42)." });
    expect(started).toEqual(["t1"]);
  });

  it("refuses to start a second run while a session is in flight, and says a client without a runner cannot", async () => {
    started.length = 0;
    const running = await setup([implementing("active")], true, { runs });
    expect((await running.call("harness_advance_route", { taskId: "t1" })).isError).toBe(true);
    expect(started).toEqual([]);
    const unable = await setup([implementing()]);
    expect((await unable.call("harness_advance_route", { taskId: "t1" })).content[0].text).toMatch(/cannot start runs/);
  });

  it("asks the run holding the route to stop, and refuses when nothing is advancing", async () => {
    const idle = await setup([implementing()]);
    expect((await idle.call("harness_stop_route", { taskId: "t1" })).content[0].text).toMatch(/is not advancing/);

    const runLease = { by: "headless" as const, pid: 42, host: "box", processStartedAt: AT, acquiredAt: AT };
    const { call, repository } = await setup([implementing()], true, { pipeline: { runLease } });
    expect((await call("harness_stop_route", { taskId: "t1" })).structuredContent.ok).toBe(true);
    expect((await repository.get("t1"))?.pipeline?.stopRequestedAt).toBe(AT);
  });

  it("starts the route once a question's answers join the brief, when the setting says to", async () => {
    started.length = 0;
    const { call } = await setup([implementing()], true, {
      runs,
      advanceAfterAnswering: true,
      pipeline: { pendingQuestion: question },
    });
    const result = await call("harness_answer_questions", {
      taskId: "t1",
      askedAt: question.askedAt,
      answers: { "impl-1-q1": "tab 3" },
    });
    expect(result.structuredContent.message).toMatch(/added to the brief\. Advancing in a headless runner/);
    expect(started).toEqual(["t1"]);
  });

  it("leaves the route where it is when the setting is off", async () => {
    started.length = 0;
    const { call } = await setup([implementing()], true, { runs, pipeline: { pendingQuestion: question } });
    await call("harness_answer_questions", { taskId: "t1", askedAt: question.askedAt, answers: { "impl-1-q1": "tab 3" } });
    expect(started).toEqual([]);
  });
});

describe("settling declined work and managing items from Claude", () => {
  const started: string[] = [];
  const runs: RunControl = {
    async start(taskId) {
      started.push(taskId);
      return { ok: true, message: "Advancing in a headless runner (pid 42)." };
    },
  };
  const verify = (): TaskStage =>
    gate({
      id: "verify",
      name: "Verify locally",
      kind: "humanVerification",
      checklist: [
        { id: "c1", text: "totals match the workbook", checked: false, raisedByStage: "verify" },
        { id: "c2", text: "the export is hidden for this tenant", checked: false, raisedByStage: "verify" },
      ],
      checkOutcomes: [{ id: "totals", passed: true }],
    });
  const heldRoute = (): TaskStage[] => [
    gate({ status: "passed" }),
    gate({
      id: "ship",
      name: "Ship",
      kind: "deployment",
      status: "pending",
      requiresApproval: false,
      subtasks: [{ id: "ship-1", title: "x", prompt: "x", status: "pending" }],
    }),
  ];
  const declined = {
    deferrals: [
      { id: "d1", text: "nobody creates the table", raisedByStage: "review", raisedByStageName: "Code review", at: AT },
    ],
  };

  it("offers the four new decisions to the dashboard only", async () => {
    const { rpc } = await setup();
    const tools: { name: string; _meta?: Json }[] = (await rpc("tools/list")).tools;
    for (const name of [
      "harness_note_checklist_item",
      "harness_retire_checklist_item",
      "harness_cover_checklist_item",
      "harness_settle_deferral",
    ]) {
      expect(tools.find((t) => t.name === name)?._meta?.ui?.visibility).toEqual(["app"]);
    }
    const { rpc: plain } = await setup([gate()], false);
    const names = (await plain("tools/list")).tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("harness_settle_deferral");
  });

  it("settles the last declined item and starts the route it was holding, when the setting says to", async () => {
    started.length = 0;
    const { call, repository } = await setup(heldRoute(), true, { runs, advanceAfterAnswering: true, pipeline: declined });
    const shown = (await call("harness_refresh", { taskId: "t1" })).structuredContent.run;
    expect(shown.deferrals).toEqual([{ id: "d1", text: "nobody creates the table", raisedBy: "Code review" }]);

    const result = await call("harness_settle_deferral", { taskId: "t1", itemId: "d1", resolution: "the publish stage" });
    expect(result.structuredContent.message).toMatch(/Nothing else is outstanding\. Advancing in a headless runner/);
    expect(started).toEqual(["t1"]);
    expect((await repository.get("t1"))!.pipeline!.deferrals![0]).toMatchObject({ resolved: true, resolution: "the publish stage" });
  });

  it("refuses a settlement with no reason, and starts nothing", async () => {
    started.length = 0;
    const { call } = await setup(heldRoute(), true, { runs, advanceAfterAnswering: true, pipeline: declined });
    const result = await call("harness_settle_deferral", { taskId: "t1", itemId: "d1", resolution: " " });
    expect(result.isError).toBe(true);
    expect(started).toEqual([]);
  });

  it("shows a gate's checks, and attaching a passed one ticks the item", async () => {
    const { call, repository } = await setup([verify()]);
    const shown = (await call("harness_refresh", { taskId: "t1" })).structuredContent.run;
    expect(shown.stages[0].checks).toEqual([{ id: "totals", passed: true }]);

    await call("harness_cover_checklist_item", { taskId: "t1", itemId: "c1", checkId: "totals" });
    const item = (await repository.get("t1"))!.pipeline!.stages[0].checklist![0];
    expect(item).toMatchObject({ coveredBy: "totals", checked: true });
  });

  it("drives note, withdraw and settle from the dashboard's own buttons", async () => {
    const { call, repository } = await setup([...heldRoute().slice(0, 1), verify(), heldRoute()[1]], true, {
      pipeline: declined,
    });
    const page = mountDashboard((name, args) => call(name, args));
    await page.settle();
    page.show((await call("harness_refresh", { taskId: "t1" })).structuredContent);
    await page.settle();
    page.attrs("data-stage").find((el: Json) => el.getAttribute("data-stage") === "verify").onclick();

    const open = (kind: string, id: string) =>
      page.attrs("data-edit").find((el: Json) => el.getAttribute("data-edit") === kind && el.getAttribute("data-id") === id);
    const type = async (text: string) => {
      const field = page.byId("ed-text");
      field.value = text;
      field.oninput();
      page.byId("ed-save").onclick();
      await page.settle();
    };

    open("note", "c1").onclick({ preventDefault: () => undefined });
    await type("saw 42 rows");
    open("retire", "c2").onclick({ preventDefault: () => undefined });
    await type("the control is hidden for this tenant");
    open("settle", "d1").onclick({ preventDefault: () => undefined });
    await type("the publish stage creates it");

    const pipeline = (await repository.get("t1"))!.pipeline!;
    const items = pipeline.stages.find((s) => s.id === "verify")!.checklist!;
    expect(items[0]).toMatchObject({ note: "saw 42 rows", checked: false });
    expect(items[1].retired).toBeTruthy();
    expect(pipeline.deferrals![0]).toMatchObject({ resolved: true, resolution: "the publish stage creates it" });
    expect(page.html()).not.toContain('id="ed-text"');
  });
});

describe("HARNESS_DASHBOARD_HTML", () => {
  it("loads nothing from anywhere, so the host's default policy fits", () => {
    expect(HARNESS_DASHBOARD_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(HARNESS_DASHBOARD_HTML).not.toMatch(/<link[^>]+href=/i);
    expect(HARNESS_DASHBOARD_HTML).not.toMatch(/https?:\/\//);
  });

  it("parses as a script, which a template-literal slip would break", () => {
    const script = HARNESS_DASHBOARD_HTML.split("<script>")[1].split("</script>")[0];
    expect(() => new Function(script)).not.toThrow();
  });

  // Claude's panel sat at "Rendering widget" because the page sent `clientInfo`
  // where the spec says `appInfo`; a host validating the request never answered it.
  it("opens with the spec's ui/initialize, and reports size only once initialised", async () => {
    const sent: { method?: string; id?: number; params?: Record<string, unknown> }[] = [];
    let onMessage: (event: { source: unknown; data: unknown }) => void = () => undefined;
    const parent = { postMessage: (msg: (typeof sent)[number]) => sent.push(msg) };
    const observed: unknown[] = [];
    const element = { style: { setProperty: () => undefined }, scrollWidth: 1, scrollHeight: 1, innerHTML: "" };
    const window = {
      parent,
      addEventListener: (_: string, listener: typeof onMessage) => (onMessage = listener),
    };
    const document = { documentElement: element, body: element, getElementById: () => element };
    class ResizeObserver {
      constructor(private readonly callback: () => void) {}
      observe(target: unknown) {
        observed.push(target);
        this.callback();
      }
    }
    const script = HARNESS_DASHBOARD_HTML.split("<script>")[1].split("</script>")[0];
    new Function("window", "document", "ResizeObserver", "setTimeout", "setInterval", script)(
      window, document, ResizeObserver, () => 0, () => 0,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("ui/initialize");
    expect(sent[0].params).toMatchObject({ appInfo: { name: expect.any(String) }, protocolVersion: "2026-01-26" });
    expect(sent[0].params).not.toHaveProperty("clientInfo");

    onMessage({ source: parent, data: { jsonrpc: "2.0", id: sent[0].id, result: { hostCapabilities: { serverTools: {} } } } });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    const methods = sent.map((m) => m.method);
    expect(methods.indexOf("ui/notifications/initialized")).toBeGreaterThan(0);
    expect(methods.indexOf("ui/notifications/size-changed")).toBeGreaterThan(
      methods.indexOf("ui/notifications/initialized"),
    );
  });
});

describe("HarnessMcpServer suggestions", () => {
  const board = {
    configured: true,
    sources: [{ id: "jira", label: "JIRA" }],
    scannedAt: AT,
    failures: [],
    suggestions: [
      { sourceId: "jira", sourceLabel: "JIRA", ref: "NMGB-1", title: "Export drops a row", rank: "Blocker", hidden: false },
      { sourceId: "jira", sourceLabel: "JIRA", ref: "NMGB-3", title: "Minor", rank: "Minor", hidden: true },
    ],
  };

  async function withSuggestions(appCapable: boolean) {
    const started: unknown[] = [];
    const suggestions = {
      board: async () => board,
      startScan: async () => ({ ok: true, value: { message: "Scanning." } }),
      options: async () => ({ routes: [], usingBuiltInRoutes: true, branchPrefixes: ["feat"], baseBranches: ["DEV"] }),
      startTask: async (request: unknown) => {
        started.push(request);
        return { ok: true, value: { task: { id: "t9", pipeline: undefined }, changed: true, message: "Created." } };
      },
    } as unknown as import("../services/suggestionControlService").SuggestionControlService;
    const server = new HarnessMcpServer(
      new HarnessControlService(new InMemoryTaskRepository(), ROOT, { now: () => AT }),
      HARNESS_DASHBOARD_HTML,
      { name: "test", version: "0", repositoryRoot: ROOT },
      undefined,
      undefined,
      suggestions,
    );
    let id = 0;
    const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<Json> =>
      ((await server.handle({ jsonrpc: "2.0", id: ++id, method, params })) as { result: Json }).result;
    await rpc("initialize", {
      capabilities: appCapable ? { extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME_TYPE] } } } : {},
    });
    const call = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
    return { rpc, call, started };
  }

  it("lets the model read the list but never scan or start a task", async () => {
    const { rpc, call } = await withSuggestions(false);
    const names = (await rpc("tools/list")).tools.map((t: { name: string }) => t.name);
    expect(names).toContain("harness_list_suggestions");
    expect(names).not.toContain("harness_scan_suggestions");
    expect(names).not.toContain("harness_start_task");

    const text = (await call("harness_list_suggestions")).content[0].text;
    expect(text).toContain("NMGB-1 — Export drops a row · Blocker");
    expect(text).not.toContain("NMGB-3");
    expect(text).toContain("1 more below");
  });

  it("offers scanning and starting to the dashboard only", async () => {
    const { rpc, call, started } = await withSuggestions(true);
    const tools: { name: string; _meta?: Json }[] = (await rpc("tools/list")).tools;
    for (const name of ["harness_scan_suggestions", "harness_task_options", "harness_start_task"]) {
      expect(tools.find((t) => t.name === name)?._meta?.ui?.visibility).toEqual(["app"]);
    }

    expect((await call("harness_scan_suggestions")).structuredContent).toMatchObject({ ok: true });
    const result = await call("harness_start_task", {
      sourceId: "jira",
      ref: "NMGB-1",
      name: "Export",
      branchPrefix: "fix",
      baseBranch: "DEV",
      routeId: "",
    });
    expect(result.structuredContent).toMatchObject({ ok: true, taskId: "t9" });
    expect(started[0]).toMatchObject({ ref: "NMGB-1", routeId: undefined });
    expect((await call("harness_refresh")).structuredContent.suggestions).toEqual(board);
  });
});

// A page small enough to drive without a DOM library: innerHTML is the rendered output,
// an element exists exactly when the markup carries its id or attribute, and tools/call
// is answered by the test. Elements are kept per id or attribute value, so the handler
// the page wired is the one a test fires.
function mountDashboard(
  respond: (name: string, args: Json) => Json | Promise<Json>,
  hostCapabilities: Json = { serverTools: {} },
) {
  type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: Json };
  const sent: Msg[] = [];
  const answered = new Set<number>();
  let onMessage: (event: { source: unknown; data: unknown }) => void = () => undefined;
  const parent = { postMessage: (msg: Msg) => sent.push(msg) };
  const root: Json = { innerHTML: "", className: "", style: { setProperty: () => undefined }, scrollWidth: 1, scrollHeight: 1 };
  const elements = new Map<string, Json>();
  const element = (key: string, init: Json) => {
    if (!elements.has(key)) elements.set(key, { focus: () => undefined, ...init });
    return elements.get(key);
  };
  const decode = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const document = {
    documentElement: root,
    body: root,
    getElementById: (id: string) =>
      id === "root" ? root
      : (root.innerHTML as string).includes(`id="${id}"`) ? element(`#${id}`, { id, value: "", checked: false })
      : null,
    querySelectorAll: (selector: string) => {
      const attr = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      if (!attr) return [];
      // Each match is the whole tag, so an element answers for any attribute it carries:
      // two buttons sharing data-edit="note" differ by their data-id.
      return [...(root.innerHTML as string).matchAll(new RegExp(`<[^<>]*\\s${attr}="[^"]*"[^<>]*>`, "g"))].map((m) =>
        element(`${attr}=${m[0]}`, {
          getAttribute: (name: string = attr) => decode(new RegExp(`\\s${name}="([^"]*)"`).exec(m[0])?.[1] ?? ""),
        }),
      );
    },
    querySelector: () => null,
  };
  const window = {
    parent,
    scrollTo: () => undefined,
    addEventListener: (_: string, listener: typeof onMessage) => (onMessage = listener),
  };
  class ResizeObserver {
    observe() {}
  }
  const script = HARNESS_DASHBOARD_HTML.split("<script>")[1].split("</script>")[0];
  new Function("window", "document", "ResizeObserver", "setTimeout", "setInterval", script)(
    window, document, ResizeObserver, () => 0, () => 0,
  );

  // Answers every request the page has made, until it stops making them.
  async function settle() {
    for (let round = 0; round < 20; round++) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      const due = sent.filter((m) => m.id !== undefined && m.method && !answered.has(m.id));
      if (!due.length) return;
      for (const m of due) {
        answered.add(m.id!);
        const result =
          m.method === "ui/initialize" ? { hostCapabilities }
          : m.method === "tools/call" ? await respond(m.params.name, m.params.arguments)
          : {};
        onMessage({ source: parent, data: { jsonrpc: "2.0", id: m.id, result } });
      }
    }
  }
  return {
    settle,
    show: (structuredContent: Json) =>
      onMessage({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } } }),
    html: () => root.innerHTML as string,
    byId: (id: string): Json => document.getElementById(id),
    attrs: (attr: string): Json[] => document.querySelectorAll(`[${attr}]`),
    calls: () => sent.filter((m) => m.method === "tools/call").map((m) => m.params),
    sent: () => sent,
  };
}

describe("the dashboard's suggested work", () => {
  const item = (ref: string, extra: Json = {}) => ({
    sourceId: "jira",
    sourceLabel: "JIRA",
    ref,
    title: `Title of ${ref}`,
    hidden: false,
    ...extra,
  });
  const board = (extra: Json = {}) => ({
    configured: true,
    sources: [{ id: "jira", label: "JIRA" }],
    scannedAt: AT,
    failures: [],
    suggestions: [
      item("NMGB-1", {
        title: "Export <drops> a row",
        rank: "Blocker",
        url: "https://jira.example/browse/NMGB-1",
        detail: "From the CRM",
      }),
      item("NMGB-3", { rank: "Minor", hidden: true }),
    ],
    ...extra,
  });
  const options = {
    routes: [
      { id: "report-change", label: "Report change", description: "Change a report end to end.", stageCount: 12 },
      { id: "sql-quick", label: "SQL quick", description: "", stageCount: 4 },
    ],
    usingBuiltInRoutes: false,
    branchPrefixes: ["feature", "fix"],
    baseBranches: ["DEV", "main"],
  };
  const refreshed = (suggestions: Json) => ({ structuredContent: { repositoryRoot: ROOT, runs: [], run: null, suggestions } });

  async function mounted(suggestions: Json, respond: (name: string, args: Json) => Json = () => refreshed(suggestions), caps?: Json) {
    const page = mountDashboard(respond, caps);
    await page.settle();
    page.show({ repositoryRoot: ROOT, runs: [], run: null, suggestions });
    await page.settle();
    return page;
  }

  it("is absent, not empty, where no source is configured", async () => {
    expect((await mounted(null)).html()).not.toContain("Suggested work");
    expect((await mounted({ ...board(), configured: false, suggestions: [] })).html()).not.toContain("Suggested work");
  });

  it("lists what is outstanding, escaped, with the hidden ones behind a toggle", async () => {
    const page = await mounted(board());
    const html = page.html();
    expect(html).toContain("Suggested work");
    expect(html).toContain("Export &lt;drops&gt; a row");
    expect(html).toContain("Blocker");
    expect(html).toContain("scanned ");
    expect(html).not.toContain("Title of NMGB-3");
    expect(html).toContain("Show 1 hidden");
    expect(html).toContain('id="sg-scan"');

    page.byId("sg-hidden").onclick();
    expect(page.html()).toContain("Title of NMGB-3");
    expect(page.html()).toContain("Hide 1 hidden");
  });

  it("words an empty list on what happened", async () => {
    expect((await mounted(board({ scannedAt: undefined, suggestions: [] }))).html()).toContain("never been scanned");
    expect((await mounted(board({ suggestions: [] }))).html()).toContain("Nothing outstanding in your sources.");
  });

  it("names each failing source", async () => {
    const html = (await mounted(board({ failures: ["JIRA: the MCP server is not connected"] }))).html();
    expect(html).toContain("1 source failed");
    expect(html).toContain("JIRA: the MCP server is not connected");
  });

  it("links a ref only where the host says it opens links, and asks the host to open it", async () => {
    expect((await mounted(board())).attrs("data-url")).toHaveLength(0);

    const page = await mounted(board(), () => refreshed(board()), { serverTools: {}, openLinks: {} });
    const links = page.attrs("data-url");
    expect(links).toHaveLength(1);
    links[0].onclick({ preventDefault: () => undefined });
    expect(page.sent().filter((m) => m.method === "ui/open-link").map((m) => m.params)).toEqual([
      { url: "https://jira.example/browse/NMGB-1" },
    ]);
  });

  it("starts a scan and shows it running until the list lands", async () => {
    let scanning = false;
    const page = await mounted(board(), (name) => {
      if (name !== "harness_scan_suggestions") return refreshed(board(scanning ? { scanningSince: AT } : {}));
      scanning = true;
      return { structuredContent: { ok: true, changed: true, message: "Scanning 1 source." } };
    });
    page.byId("sg-scan").onclick();
    await page.settle();

    expect(page.calls().map((c: Json) => c.name)).toEqual(["harness_scan_suggestions", "harness_refresh"]);
    expect(page.html()).toContain("Scanning since");
    expect(page.html()).not.toContain('id="sg-scan"');
    expect(page.html()).toContain("Scanning 1 source.");
  });

  it("asks what VS Code's create flow asks, and opens the run it routed", async () => {
    const page = await mounted(board(), (name) => {
      if (name === "harness_task_options") return { structuredContent: options };
      if (name === "harness_start_task") {
        return { structuredContent: { ok: true, changed: true, message: "Created.", taskId: "t9", routed: true } };
      }
      return refreshed(board());
    });
    const [start] = page.attrs("data-start");
    expect(start.getAttribute()).toBe("jira|NMGB-1");
    start.onclick();
    await page.settle();

    const form = page.html();
    expect(form).toContain('id="sg-name" value="Export &lt;drops&gt; a row"');
    expect(form).toContain("NMGB-1 — https://jira.example/browse/NMGB-1 — From the CRM");
    expect(form).toContain('<option value="DEV" selected>');
    expect(form).toContain("Chat task — no route");
    expect(form).toContain("assess first");

    // A chat task has no route to assess against, so the box goes with the route.
    page.byId("sg-route").value = "";
    page.byId("sg-route").onchange();
    expect(page.html()).not.toContain("assess first");
    page.byId("sg-route").value = "sql-quick";
    page.byId("sg-route").onchange();
    page.byId("sg-assess").checked = true;
    page.byId("sg-assess").type = "checkbox";
    page.byId("sg-assess").onchange();
    page.byId("sg-prefix").value = "fix";
    page.byId("sg-prefix").onchange();
    page.byId("sg-create").onclick();
    await page.settle();

    const calls = page.calls();
    expect(calls.map((c: Json) => c.name)).toEqual(["harness_task_options", "harness_start_task", "harness_refresh"]);
    expect(calls[1].arguments).toEqual({
      sourceId: "jira",
      ref: "NMGB-1",
      name: "Export <drops> a row",
      branchPrefix: "fix",
      baseBranch: "DEV",
      brief: "NMGB-1 — https://jira.example/browse/NMGB-1 — From the CRM",
      routeId: "sql-quick",
      assessFirst: true,
    });
    expect(calls[2].arguments).toEqual({ taskId: "t9" });
    expect(page.html()).not.toContain('id="sg-create"');
  });

  it("omits the route for a chat task and keeps the form when the server refuses", async () => {
    const page = await mounted(board(), (name) => {
      if (name === "harness_task_options") return { structuredContent: options };
      if (name === "harness_start_task") {
        return { isError: true, structuredContent: { ok: false, kind: "refused", message: "NMGB-1 is not in the last scan. Scan again." } };
      }
      return refreshed(board());
    });
    page.attrs("data-start")[0].onclick();
    await page.settle();
    page.byId("sg-route").value = "";
    page.byId("sg-route").onchange();
    page.byId("sg-create").onclick();
    await page.settle();

    const started = page.calls().find((c: Json) => c.name === "harness_start_task");
    expect(started.arguments).not.toHaveProperty("routeId");
    expect(started.arguments).not.toHaveProperty("assessFirst");
    expect(page.html()).toContain('id="sg-create"');
    expect(page.html()).toContain("NMGB-1 is not in the last scan. Scan again.");
  });
});
