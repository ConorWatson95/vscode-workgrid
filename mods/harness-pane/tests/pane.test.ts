import { expect, test } from "claude-code/testing";

const stage = {
  id: "s-gate",
  name: "Verify locally",
  kind: "humanVerification",
  state: "awaiting",
  statusLabel: "Awaiting approval",
  detail: "1 outstanding",
  modelsRun: [],
  evidence: { basis: "verified", summary: "", selfReported: false },
  subtasks: [],
  costUsd: 0,
  elapsedMs: 0,
  checklist: [
    { id: "c1", text: "Export opens in Excel", checked: false, holding: true, kind: "verify", raisedBy: "s-gate" },
  ],
  canApprove: true,
  canRetry: false,
};

const urgent = {
  taskId: "t1",
  name: "Pyramid export",
  route: "report-change",
  group: "needs-you",
  groupLabel: "Needs you",
  currentStage: "Verify locally",
  ticket: "NMGB-1",
  updatedAt: "2026-10-09T07:00:00Z",
  attention: { need: "Approve Verify locally", status: "Awaiting approval", tone: "act", stageId: "s-gate" },
  progress: { done: 3, total: 5 },
  strip: ["done", "done", "done", "awaiting", "pending"],
};
const busy = {
  ...urgent,
  taskId: "t2",
  name: "Dealer rebate",
  ticket: undefined,
  group: "working",
  groupLabel: "Working",
  attention: { status: "Implementing the data", tone: "run" },
};
const snapshot = {
  ...urgent,
  branch: "feature/nmgb-1",
  worktreePath: "C:/w/t1",
  revision: "rev-1",
  stages: [stage],
  deferrals: [],
  costUsd: 1,
  discardedCostUsd: 0,
};

const FEED = [
  { type: "run", run: snapshot },
  { type: "run", run: { ...snapshot, ...busy, stages: [] } },
  { type: "board", repositoryRoot: "C:/repo", runs: [urgent, busy] },
]
  .map((m) => JSON.stringify(m))
  .join("\n") + "\n";

const PANE_PROPS = {
  title: "Harness",
  isFocused: true,
  bodyColumns: 80,
  placement: "dock",
  scroll: { top: 0, bodyRows: 40, rows: 40 },
};

async function settle(find: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 200 && !(await find()); i++) await Promise.resolve();
}

test("the board puts what needs you first, and Approve sends the revision it drew", async ($, on) => {
  const calls: { argv: readonly string[]; stdin?: string }[] = [];
  on("command.register", () => ({ value: undefined }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.spawn", async function* () {
    // Split mid-line, as a pipe does.
    yield { stream: "stdout", text: FEED.slice(0, 100) };
    yield { stream: "stdout", text: FEED.slice(100) };
    return { value: { code: 0, signal: null } };
  });
  on("process.run", ($, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin });
    const reply = { jsonrpc: "2.0", id: 2, result: { structuredContent: { ok: true, message: "Approved Verify locally." } } };
    return { value: { exitCode: 0, stdout: JSON.stringify(reply) + "\n", stderr: "" } };
  });

  await $.command.run({ command: "harness", args: "C:/repo" });

  const ui = await $.ui.mount({
    plugin: "harness-pane",
    surface: "terminal",
    component: "Pane",
    requestId: "harness",
    props: PANE_PROPS as never,
  });
  await settle(() => ui.find({ key: "run:t1" }));

  // The tree's defaults: what needs you and what is working are open.
  expect(await ui.find({ key: "group:needs-you" })).toBeDefined();
  expect(await ui.find({ key: "run:t2" })).toBeDefined();
  // A task is one line: its name, then what it wants as a dim description.
  expect(await ui.find({ type: "Text", text: /^Approve Verify locally( · .*)? · NMGB-1$/ })).toBeDefined();
  expect(await ui.find({ key: "item:c1" })).toBeUndefined();

  // Opening it opens the stage that needs you, with its checklist and actions.
  await ui.press({ key: "run:t1" });
  expect(await ui.find({ key: "stage:t1:s-gate" })).toBeDefined();
  expect(await ui.find({ key: "item:c1" })).toBeDefined();

  await ui.press({ key: "approve:t1:s-gate" });
  await ui.input({ key: "note", text: "looks right", submit: true } as never);
  await settle(() => ui.find({ type: "Text", text: /Approved Verify locally/ }));

  expect(calls).toHaveLength(1);
  const sent = calls[0]!.stdin!.trim().split("\n").map((line) => JSON.parse(line));
  expect(sent[2].params).toEqual({
    name: "harness_approve_stage",
    arguments: { taskId: "t1", stageId: "s-gate", revision: "rev-1", note: "looks right" },
  });
  // Declares MCP Apps support, without which the server offers no decision tools.
  expect(sent[0].params.capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes).toContain(
    "text/html;profile=mcp-app",
  );
  await ui.unmount();
});

test("a refused decision is shown, not swallowed", async ($, on) => {
  on("command.register", () => ({ value: undefined }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.spawn", async function* () {
    yield { stream: "stdout", text: FEED };
    return { value: { code: 0, signal: null } };
  });
  on("process.run", () => {
    const reply = {
      jsonrpc: "2.0",
      id: 2,
      result: { structuredContent: { ok: false, kind: "stale", message: "The run moved since you looked." } },
    };
    return { value: { exitCode: 0, stdout: JSON.stringify(reply) + "\n", stderr: "" } };
  });

  await $.command.run({ command: "harness", args: "C:/repo" });
  const ui = await $.ui.mount({
    plugin: "harness-pane",
    surface: "desktop",
    component: "Pane",
    requestId: "harness",
    props: PANE_PROPS as never,
  });
  await settle(() => ui.find({ key: "run:t1" }));
  await ui.press({ key: "run:t1" });
  await ui.press({ key: "item:c1" });
  await settle(() => ui.find({ type: "Text", text: /moved since you looked/ }));
  expect(await ui.find({ type: "Text", text: /moved since you looked/ })).toBeDefined();
  await ui.unmount();
});

test("Report fetches the stage's whole report, which the feed does not carry", async ($, on) => {
  const calls: string[] = [];
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.spawn", async function* () {
    yield { stream: "stdout", text: FEED };
    return { value: { code: 0, signal: null } };
  });
  on("process.run", ($, e) => {
    calls.push(e.init?.stdin ?? "");
    const reply = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "# The whole report" }] } };
    return { value: { exitCode: 0, stdout: JSON.stringify(reply) + "\n", stderr: "" } };
  });

  await $.command.run({ command: "harness", args: "C:/repo" });
  const ui = await $.ui.mount({
    plugin: "harness-pane",
    surface: "desktop",
    component: "Pane",
    requestId: "harness",
    props: PANE_PROPS as never,
  });
  await settle(() => ui.find({ key: "run:t1" }));
  await ui.press({ key: "run:t1" });
  await ui.press({ key: "report:t1:s-gate" });
  await settle(() => ui.find({ type: "Markdown", text: /The whole report/ } as never));

  expect(await ui.find({ type: "Markdown", text: /The whole report/ } as never)).toBeDefined();
  expect(calls[0]).toContain("harness_get_stage_report");
  // Hidden and shown again at the same revision, it is not fetched twice.
  await ui.press({ key: "report:t1:s-gate" });
  await ui.press({ key: "report:t1:s-gate" });
  expect(calls).toHaveLength(1);
  await ui.unmount();
});

async function mountWith($: any, on: any, run: unknown, reply: (args: any) => unknown) {
  const calls: any[] = [];
  const feed = [
    { type: "run", run },
    { type: "board", repositoryRoot: "C:/repo", runs: [urgent] },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n") + "\n";
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.spawn", async function* () {
    yield { stream: "stdout", text: feed };
    return { value: { code: 0, signal: null } };
  });
  on("process.run", ($: unknown, e: any) => {
    const sent = String(e.init?.stdin ?? "").trim().split("\n").map((line) => JSON.parse(line))[2].params;
    calls.push(sent);
    const result = { structuredContent: reply(sent.arguments) };
    return { value: { exitCode: 0, stdout: JSON.stringify({ jsonrpc: "2.0", id: 2, result }) + "\n", stderr: "" } };
  });
  await $.command.run({ command: "harness", args: "C:/repo" });
  const ui = await $.ui.mount({
    plugin: "harness-pane",
    surface: "desktop",
    component: "Pane",
    requestId: "harness",
    props: PANE_PROPS as never,
  });
  await settle(() => ui.find({ key: "run:t1" }));
  await ui.press({ key: "run:t1" });
  return { ui, calls };
}

const repairable = {
  ...snapshot,
  stages: [
    { ...stage, id: "s-impl", name: "Implement", kind: "implementation", state: "done", checklist: [], canApprove: false, canCorrect: true, canRerun: true },
    {
      ...stage,
      canCorrect: true,
      canRerun: true,
      sendBack: {
        targets: [{ id: "s-impl", name: "Implement", reopens: 2, correctable: true }],
        needsFindings: true,
      },
    },
  ],
};

test("Send back asks where, then how, then what went wrong, and sends what was chosen", async ($, on) => {
  const { ui, calls } = await mountWith($, on, repairable, () => ({ ok: true, message: "Sent back." }));

  await ui.press({ key: "sendback:t1:s-gate" });
  expect((await ui.find({ type: "Text", text: /re-opens 2 stage\(s\) · nearest/ }))).toBeDefined();
  await ui.press({ key: "target:s-impl" });
  await ui.press({ key: "how:fix" });
  await ui.input({ key: "sendnote", text: "Specified cast is not valid on DEV", submit: true } as never);
  await settle(() => ui.find({ type: "Text", text: /Sent back\./ }));

  expect(calls[0]).toEqual({
    name: "harness_send_back",
    arguments: {
      taskId: "t1",
      fromStageId: "s-gate",
      targetStageId: "s-impl",
      revision: "rev-1",
      how: "fix",
      findings: "Specified cast is not valid on DEV",
    },
  });
  // Done: the sequence closes.
  expect(await ui.find({ key: "sendnote" })).toBeUndefined();
  await ui.unmount();
});

test("a fix the harness refuses keeps its box open to retype", async ($, on) => {
  const { ui, calls } = await mountWith($, on, repairable, (args) =>
    args.finding === "Incorrect."
      ? { ok: false, kind: "weakBrief", message: "That says it is wrong, not what is wrong." }
      : { ok: true, message: "Implement will fix that." },
  );

  await ui.press({ key: "stage:t1:s-impl" });
  await ui.press({ key: "fix:t1:s-impl" });
  await ui.input({ key: "finding", text: "Incorrect.", submit: true } as never);
  await settle(() => ui.find({ type: "Text", text: /not what is wrong/ }));
  expect(await ui.find({ key: "finding" })).toBeDefined();

  await ui.input({ key: "finding", text: "the total column double-counts returns", submit: true } as never);
  await settle(() => ui.find({ type: "Text", text: /will fix that/ }));
  expect(calls.map((c) => c.name)).toEqual(["harness_correct_stage", "harness_correct_stage"]);
  expect(await ui.find({ key: "finding" })).toBeUndefined();
  await ui.unmount();
});

test("answers are taken one at a time and sent together, for VS Code to deliver", async ($, on) => {
  const asking = {
    ...snapshot,
    question: {
      stageName: "Verify locally",
      askedAt: "2026-10-09T07:00:00Z",
      live: true,
      items: ["Which tab?", "Monthly or weekly?"],
      itemIds: ["q1", "q2"],
      submitted: false,
    },
  };
  const { ui, calls } = await mountWith($, on, asking, () => ({ ok: true, message: "Answered." }));

  await ui.input({ key: "answer:q1", text: "tab 3", submit: true } as never);
  expect(calls).toHaveLength(0);
  expect(await ui.find({ type: "Text", text: /→ tab 3/ })).toBeDefined();
  await ui.input({ key: "answer:q2", text: "monthly", submit: true } as never);
  await settle(() => ui.find({ type: "Text", text: /^Answered\.$/ }));

  expect(calls).toEqual([
    {
      name: "harness_answer_questions",
      arguments: { taskId: "t1", askedAt: "2026-10-09T07:00:00Z", answers: { q1: "tab 3", q2: "monthly" } },
    },
  ]);
  await ui.unmount();
});

test("Advance starts a run and reports what the runner said", async ($, on) => {
  const { ui, calls } = await mountWith($, on, snapshot, () => ({
    ok: true,
    message: "Advancing in a headless runner (pid 42).",
  }));
  await ui.press({ key: "advance:t1" });
  await settle(() => ui.find({ type: "Text", text: /headless runner \(pid 42\)/ }));
  expect(calls).toEqual([{ name: "harness_advance_route", arguments: { taskId: "t1" } }]);
  await ui.unmount();
});

test("a route being advanced offers Stop instead of a second Advance", async ($, on) => {
  const advancing = { by: "headless", pid: 42, since: "2026-10-09T07:00:00Z", stopRequested: false };
  const { ui, calls } = await mountWith($, on, { ...snapshot, advancing }, () => ({ ok: true, message: "Asked the run to stop." }));
  expect(await ui.find({ key: "advance:t1" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^Advancing headless/ })).toBeDefined();
  await ui.press({ key: "stop:t1" });
  await settle(() => ui.find({ type: "Text", text: /^Asked the run to stop\.$/ }));
  expect(calls).toEqual([{ name: "harness_stop_route", arguments: { taskId: "t1" } }]);
  await ui.unmount();
});

test("a run already asked to stop says so and offers nothing", async ($, on) => {
  const advancing = { by: "vscode", pid: 7, since: "2026-10-09T07:00:00Z", stopRequested: true };
  const { ui } = await mountWith($, on, { ...snapshot, advancing }, () => ({}));
  expect(await ui.find({ key: "stop:t1" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^Stopping/ })).toBeDefined();
  await ui.unmount();
});

test("a held tool call is allowed or denied from the pane", async ($, on) => {
  const heldCalls = [{ id: "g1", tool: "Bash", detail: "git push", since: "2026-10-09T07:00:00Z", decided: false }];
  const { ui, calls } = await mountWith($, on, { ...snapshot, heldCalls }, () => ({ ok: true, message: "Allowed Bash." }));
  expect(await ui.find({ type: "Text", text: /^Bash · git push/ })).toBeDefined();
  await ui.press({ key: "held:session:true:g1" });
  await settle(() => ui.find({ type: "Text", text: /^Allowed Bash\.$/ }));
  expect(calls).toEqual([
    { name: "harness_decide_held_call", arguments: { taskId: "t1", callId: "g1", allow: true, scope: "session" } },
  ]);
  await ui.unmount();
});

test("a long route folds what has passed and what is still to come around the stage that needs you", async ($, on) => {
  const done = (n: number) => ({ ...stage, id: "d" + n, name: "Done " + n, state: "done", checklist: [], canApprove: false });
  const later = (n: number) => ({ ...stage, id: "p" + n, name: "Later " + n, state: "pending", checklist: [], canApprove: false });
  const long = { ...snapshot, stages: [done(1), done(2), done(3), done(4), stage, later(1), later(2), later(3), done(5)] };
  const feed = [
    { type: "run", run: long },
    { type: "board", repositoryRoot: "C:/repo", runs: [urgent] },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n") + "\n";
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.spawn", async function* () {
    yield { stream: "stdout", text: feed };
    return { value: { code: 0, signal: null } };
  });

  await $.command.run({ command: "harness", args: "C:/repo" });
  const ui = await $.ui.mount({
    plugin: "harness-pane",
    surface: "desktop",
    component: "Pane",
    requestId: "harness",
    props: PANE_PROPS as never,
  });
  await settle(() => ui.find({ key: "run:t1" }));
  await ui.press({ key: "run:t1" });

  expect(await ui.find({ key: "stage:t1:s-gate" })).toBeDefined();
  expect(await ui.find({ key: "stage:t1:d1" })).toBeUndefined();
  expect((await ui.find({ key: "fold:t1:fold:d1" }))?.props.label).toBe("4 passed");
  expect((await ui.find({ key: "fold:t1:fold:p1" }))?.props.label).toBe("3 still to come");
  // A lone settled stage is not worth a fold of its own.
  expect(await ui.find({ key: "stage:t1:d5" })).toBeDefined();

  await ui.press({ key: "fold:t1:fold:d1" });
  expect(await ui.find({ key: "stage:t1:d1" })).toBeDefined();
  await ui.unmount();
});

const suggestionBoard = {
  configured: true,
  sources: [{ id: "jira", label: "JIRA" }],
  scannedAt: "2026-10-09T05:00:00Z",
  failures: [],
  suggestions: [
    {
      sourceId: "jira",
      sourceLabel: "JIRA",
      ref: "NMGB-7",
      title: "Dealer league table",
      rank: "High",
      state: "To Do",
      url: "https://jira/NMGB-7",
      detail: "Phase 2",
      hidden: false,
    },
    { sourceId: "jira", sourceLabel: "JIRA", ref: "NMGB-9", title: "Old clean-up", rank: "Lowest", hidden: true },
  ],
};

const taskOptions = {
  routes: [{ id: "report-change", label: "Report change", description: "A report, end to end", stageCount: 20 }],
  usingBuiltInRoutes: false,
  branchPrefixes: ["feature", "fix"],
  baseBranches: ["DEV", "main"],
};

/** The board with suggestions beside it; task options are answered, anything else by `reply`. */
async function mountSuggestions($: any, on: any, board: unknown, reply: (args: any) => unknown = () => ({ ok: true, message: "Done." })) {
  const calls: any[] = [];
  const feed = [
    { type: "run", run: snapshot },
    { type: "board", repositoryRoot: "C:/repo", runs: [urgent] },
    { type: "suggestions", board },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n") + "\n";
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.spawn", async function* () {
    yield { stream: "stdout", text: feed };
    return { value: { code: 0, signal: null } };
  });
  on("process.run", ($: unknown, e: any) => {
    const sent = String(e.init?.stdin ?? "").trim().split("\n").map((line) => JSON.parse(line))[2].params;
    calls.push({ ...sent, timeoutMs: e.init?.timeoutMs });
    const result = { structuredContent: sent.name === "harness_task_options" ? taskOptions : reply(sent.arguments) };
    return { value: { exitCode: 0, stdout: JSON.stringify({ jsonrpc: "2.0", id: 2, result }) + "\n", stderr: "" } };
  });
  await $.command.run({ command: "harness", args: "C:/repo" });
  const ui = await $.ui.mount({
    plugin: "harness-pane",
    surface: "desktop",
    component: "Pane",
    requestId: "harness",
    props: PANE_PROPS as never,
  });
  await settle(() => ui.find({ key: "run:t1" }));
  return { ui, calls };
}

test("a project with no suggestion source gets no Suggested work, rather than an empty list", async ($, on) => {
  const { ui } = await mountSuggestions($, on, { configured: false, sources: [], failures: [], suggestions: [] });
  expect(await ui.find({ key: "group:suggested" })).toBeUndefined();
  expect(await ui.find({ key: "scan" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /Nothing outstanding/ })).toBeUndefined();
  await ui.unmount();
});

test("suggestions are listed under the runs, with what is below the rank floor held back", async ($, on) => {
  const { ui } = await mountSuggestions($, on, suggestionBoard);
  expect(await ui.find({ key: "group:suggested" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /^scanned \d+[mhd] ago$/ })).toBeDefined();
  expect(await ui.find({ key: "start:jira:NMGB-7" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /^Dealer league table$/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /^High · To Do$/ })).toBeDefined();
  expect(await ui.find({ key: "start:jira:NMGB-9" })).toBeUndefined();

  expect((await ui.find({ key: "suggestions:hidden" }))?.props.label).toBe("Show 1 hidden");
  await ui.press({ key: "suggestions:hidden" });
  expect(await ui.find({ key: "start:jira:NMGB-9" })).toBeDefined();
  await ui.unmount();
});

test("a scan in progress, and a source that failed, are said rather than shown as a quiet board", async ($, on) => {
  const scanning = {
    ...suggestionBoard,
    scanningSince: "2026-10-09T07:00:00Z",
    failures: ["JIRA: the atlassian server is not connected"],
    suggestions: [],
  };
  const { ui } = await mountSuggestions($, on, scanning);
  expect(await ui.find({ type: "Text", text: /^Scanning since \d\d:\d\d · 1 source failed$/ })).toBeDefined();
  expect(await ui.find({ key: "scan" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /atlassian server is not connected/ })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /Nothing outstanding in your sources/ })).toBeUndefined();
  await ui.unmount();
});

test("a board never scanned asks for a scan, and Scan starts one", async ($, on) => {
  const never = { ...suggestionBoard, scannedAt: undefined, suggestions: [] };
  const { ui, calls } = await mountSuggestions($, on, never, () => ({ ok: true, message: "Scanning in a headless runner." }));
  expect(await ui.find({ type: "Text", text: /^Never scanned\./ })).toBeDefined();
  await ui.press({ key: "scan" });
  await settle(() => ui.find({ type: "Text", text: /^Scanning in a headless runner\.$/ }));
  expect(calls).toEqual([{ name: "harness_scan_suggestions", arguments: {}, timeoutMs: 60000 }]);
  await ui.unmount();
});

test("Start task asks VS Code's questions, sends the answers, and opens the run it made", async ($, on) => {
  const { ui, calls } = await mountSuggestions($, on, suggestionBoard, () => ({
    ok: true,
    changed: true,
    message: 'Created "League table" on fix/league-table with the Report change route.',
    taskId: "t1",
    routed: true,
  }));
  await ui.press({ key: "start:jira:NMGB-7" });
  await settle(() => ui.find({ key: "start:name" }));

  // Prefilled from the ticket; the name is the one to shorten, since it becomes the branch.
  expect((await ui.find({ key: "start:name" }))?.props.value).toBe("Dealer league table");
  expect((await ui.find({ key: "start:brief" }))?.props.value).toBe("NMGB-7 — https://jira/NMGB-7 — Phase 2");
  expect((await ui.find({ key: "start:base" }))?.props.value).toBe("DEV");
  expect((await ui.find({ key: "start:route" }))?.props.value).toBe("report-change");

  await ui.input({ key: "start:name", text: "League table", kind: "change" });
  await ui.select({ key: "start:prefix", value: "fix" });
  await ui.press({ key: "start:assess" });
  await ui.press({ key: "start:create" });
  await settle(() => ui.find({ type: "Text", text: /^Created "League table"/ }));

  expect(calls).toEqual([
    { name: "harness_task_options", arguments: {}, timeoutMs: 60000 },
    {
      name: "harness_start_task",
      arguments: {
        sourceId: "jira",
        ref: "NMGB-7",
        name: "League table",
        branchPrefix: "fix",
        baseBranch: "DEV",
        routeId: "report-change",
        assessFirst: true,
        brief: "NMGB-7 — https://jira/NMGB-7 — Phase 2",
      },
      // A worktree takes longer to make than a decision takes to record.
      timeoutMs: 180000,
    },
  ]);
  expect(await ui.find({ key: "start:name" })).toBeUndefined();
  // The run it made is opened, at the stage that needs you.
  expect(await ui.find({ key: "stage:t1:s-gate" })).toBeDefined();
  await ui.unmount();
});

test("a chat task sends no route and offers no assessment", async ($, on) => {
  const { ui, calls } = await mountSuggestions($, on, suggestionBoard, () => ({
    ok: true,
    message: 'Created "Dealer league table" on feature/dealer-league-table.',
    taskId: "t9",
    routed: false,
  }));
  await ui.press({ key: "start:jira:NMGB-7" });
  await settle(() => ui.find({ key: "start:route" }));
  expect(await ui.find({ key: "start:assess" })).toBeDefined();
  await ui.select({ key: "start:route", value: "" });
  expect(await ui.find({ key: "start:assess" })).toBeUndefined();
  await ui.press({ key: "start:create" });
  await settle(() => ui.find({ type: "Text", text: /^Created "Dealer league table"/ }));

  expect(calls[1].arguments).toEqual({
    sourceId: "jira",
    ref: "NMGB-7",
    name: "Dealer league table",
    branchPrefix: "feature",
    baseBranch: "DEV",
    brief: "NMGB-7 — https://jira/NMGB-7 — Phase 2",
  });
  await ui.unmount();
});

test("a refused start keeps the form, so the answer is edited rather than retyped", async ($, on) => {
  const { ui } = await mountSuggestions($, on, suggestionBoard, () => ({
    ok: false,
    kind: "refused",
    message: "A branch called feature/dealer-league-table already exists.",
  }));
  await ui.press({ key: "start:jira:NMGB-7" });
  await settle(() => ui.find({ key: "start:create" }));
  await ui.press({ key: "start:create" });
  await settle(() => ui.find({ type: "Text", text: /already exists/ }));
  expect(await ui.find({ key: "start:name" })).toBeDefined();
  await ui.unmount();
});
