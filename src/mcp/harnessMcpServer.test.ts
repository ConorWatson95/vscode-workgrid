import { describe, expect, it } from "vitest";
import { TaskPipeline, TaskStage } from "../domain/taskPipeline";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { HarnessControlService } from "../services/harnessControlService";
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

async function setup(stages: TaskStage[] = [gate()], appCapable = true) {
  const repository = new InMemoryTaskRepository();
  await repository.save(task(stages));
  const service = new HarnessControlService(repository, ROOT, { now: () => AT });
  const server = new HarnessMcpServer(service, HARNESS_DASHBOARD_HTML, {
    name: "test",
    version: "0",
    repositoryRoot: ROOT,
  });
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

  it("keeps the revision out of what the model reads", async () => {
    const { call } = await setup();
    const result = await call("harness_dashboard");
    const revision = result.structuredContent.run.revision;

    expect(typeof revision).toBe("string");
    expect(result.content[0].text).toContain("Code review");
    expect(result.content[0].text).not.toContain(revision);
  });

  it("records an approval through the store, and a second press as already done", async () => {
    const { call, repository } = await setup();
    const shown = (await call("harness_refresh")).structuredContent.run;

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
    const shown = (await call("harness_refresh")).structuredContent.run;

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
    const shown = (await call("harness_refresh")).structuredContent.run;
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
});
