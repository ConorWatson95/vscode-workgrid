import { describe, expect, it } from "vitest";
import { SuggestionSource } from "../domain/suggestionSourceFile";
import { BUILT_IN_ROUTES } from "../domain/taskRoute";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { StoredScan } from "../persistence/suggestionScanFile";
import { InMemoryTaskRepository } from "../persistence/taskRepository";
import { ok } from "../utilities/result";
import { SuggestionControlDeps, SuggestionControlService } from "./suggestionControlService";
import { CreateTaskInput } from "./taskWorkspaceService";

const ROOT = "C:/repo";
const AT = "2026-10-12T09:00:00.000Z";
const route = BUILT_IN_ROUTES[0];

const source: SuggestionSource = {
  id: "jira",
  label: "JIRA",
  scanPrompt: "issues assigned to me",
  order: { ranks: ["Blocker", "Major", "Minor"], showFrom: "Major" },
};

const scan: StoredScan = {
  scan: {
    scannedAt: AT,
    outcomes: [
      {
        sourceId: "jira",
        sourceLabel: "JIRA",
        suggestions: [
          { sourceId: "jira", ref: "NMGB-3", title: "Minor thing", rank: "Minor" },
          { sourceId: "jira", ref: "NMGB-1", title: "Export drops a row", rank: "Blocker", url: "https://j/NMGB-1" },
          { sourceId: "jira", ref: "NMGB-2", title: "Already going", rank: "Major" },
        ],
      },
    ],
  },
};

function existing(over: Partial<TaskWorkspace>): TaskWorkspace {
  return {
    id: "t-old",
    name: "Old",
    repositoryRoot: ROOT,
    worktreePath: "C:/wt/old",
    branchName: "feat/old",
    baseBranch: "DEV",
    status: "ready",
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function setup(over: Partial<SuggestionControlDeps> = {}, stored: StoredScan = scan) {
  const repository = new InMemoryTaskRepository();
  const created: CreateTaskInput[] = [];
  const service = new SuggestionControlService({
    repositoryRoot: ROOT,
    repository,
    harness: () => ({ routes: [route], usingBuiltInRoutes: true, suggestionSources: [source] }),
    readScan: async () => stored,
    alive: () => true,
    branches: async () => ({ list: ["main", "DEV"], current: "main" }),
    settings: () => ({
      branchPrefixes: () => ["feat", "fix"],
      defaultBaseBranch: () => "DEV",
      worktreeParentDir: () => "",
      copyIntoWorktree: () => [],
      linkSiblings: () => [],
    }),
    service: {
      createTask: async (input) => {
        created.push(input);
        const task = existing({
          id: "t-new",
          name: input.name,
          branchName: `${input.branchPrefix}/x`,
          baseBranch: input.baseBranch,
          description: input.description,
          origin: input.origin,
        });
        await repository.save(task);
        return ok(task);
      },
    },
    provisioner: {
      provision: () => ({ copied: [], missing: [], problems: [] }),
      linkSiblings: () => ({ copied: [], missing: [], problems: [] }),
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    now: () => AT,
    ...over,
  });
  return { service, repository, created };
}

describe("SuggestionControlService.board", () => {
  it("ranks the scan, flags what the source hides, and drops work already under way", async () => {
    const { service, repository } = setup();
    await repository.save(existing({ origin: { sourceId: "jira", ref: "NMGB-2", at: AT } }));

    const board = await service.board();
    expect(board.configured).toBe(true);
    expect(board.scannedAt).toBe(AT);
    expect(board.suggestions.map((s) => [s.ref, s.hidden])).toEqual([
      ["NMGB-1", false],
      ["NMGB-3", true],
    ]);
  });

  it("offers an archived task's ticket again", async () => {
    const { service, repository } = setup();
    await repository.save(existing({ status: "archived", origin: { sourceId: "jira", ref: "NMGB-2", at: AT } }));
    expect((await service.board()).suggestions.map((s) => s.ref)).toContain("NMGB-2");
  });

  it("reports a running scan only while its process is alive", async () => {
    const running: StoredScan = { ...scan, scanning: { startedAt: AT, pid: 42 } };
    expect((await setup({}, running).service.board()).scanningSince).toBe(AT);
    expect((await setup({ alive: () => false }, running).service.board()).scanningSince).toBeUndefined();
  });

  it("is absent rather than empty when nothing is configured", async () => {
    const { service } = setup({
      harness: () => ({ routes: [], usingBuiltInRoutes: true, suggestionSources: [] }),
    });
    const board = await service.board();
    expect(board.configured).toBe(false);
    expect(board.suggestions).toEqual([]);
  });
});

describe("SuggestionControlService.startScan", () => {
  it("does not start a second scan while one is running", async () => {
    let started = 0;
    const { service } = setup(
      { scans: { start: async () => (started++, { ok: true, message: "go" }) } },
      { ...scan, scanning: { startedAt: AT, pid: 1 } },
    );
    const outcome = await service.startScan();
    expect(outcome.ok).toBe(true);
    expect(started).toBe(0);
  });

  it("refuses with the remedy when no source is configured", async () => {
    const { service } = setup({
      harness: () => ({ routes: [], usingBuiltInRoutes: true, suggestionSources: [] }),
      scans: { start: async () => ({ ok: true, message: "go" }) },
    });
    const outcome = await service.startScan();
    expect(!outcome.ok && outcome.error.message).toMatch(/harness\.json/);
  });

  it("passes on the launcher's refusal", async () => {
    const { service } = setup({ scans: { start: async () => ({ ok: false, message: "no runner" }) } });
    const outcome = await service.startScan();
    expect(!outcome.ok && outcome.error.message).toBe("no runner");
  });
});

describe("SuggestionControlService.options", () => {
  it("puts the configured base branch first", async () => {
    const options = await setup().service.options();
    expect(options.baseBranches[0]).toBe("DEV");
    expect(options.branchPrefixes).toEqual(["feat", "fix"]);
    expect(options.routes[0]).toMatchObject({ id: route.id, stageCount: route.stages.length });
  });
});

describe("SuggestionControlService.startTask", () => {
  const request = {
    sourceId: "jira",
    ref: "NMGB-1",
    name: "Export drops a row",
    branchPrefix: "fix",
    baseBranch: "DEV",
    routeId: route.id,
  };

  it("creates the task with its origin, a brief from the ticket, and the route", async () => {
    const { service, repository, created } = setup();
    const outcome = await service.startTask(request);

    expect(outcome.ok).toBe(true);
    expect(created[0].origin).toEqual({ sourceId: "jira", ref: "NMGB-1", url: "https://j/NMGB-1", at: AT });
    expect(created[0].description).toBe("NMGB-1 — https://j/NMGB-1");
    const saved = await repository.get("t-new");
    expect(saved?.pipeline?.routeId).toBe(route.id);
  });

  it("makes a chat task when no route is chosen", async () => {
    const { service, repository } = setup();
    await service.startTask({ ...request, routeId: undefined });
    expect((await repository.get("t-new"))?.pipeline).toBeUndefined();
  });

  it("refuses a ticket another task already carries", async () => {
    const { service, repository, created } = setup();
    await repository.save(existing({ origin: { sourceId: "JIRA", ref: "nmgb-1", at: AT } }));
    const outcome = await service.startTask(request);
    expect(!outcome.ok && outcome.error.message).toMatch(/already the task/);
    expect(created).toHaveLength(0);
  });

  it("refuses an item the last scan does not hold, and a route the project lacks", async () => {
    const { service, created } = setup();
    expect((await service.startTask({ ...request, ref: "NMGB-9" })).ok).toBe(false);
    expect((await service.startTask({ ...request, routeId: "nope" })).ok).toBe(false);
    expect(created).toHaveLength(0);
  });
});
