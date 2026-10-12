// The harness board as a pane beside the transcript.
//
// Reads from `harnessMcpServer.js --watch`, which pushes the board as JSON lines
// whenever the state file changes; the feed runs only while the pane is open.
// Decisions go through the same server one call at a time, as MCP `tools/call`
// with the revision the pane drew from, so a decision about a run that has
// since moved is refused rather than applied. The pane never writes the state
// file itself and never decides anything: it shows the run and carries clicks.

const PANE = "harness";
const SERVER = "/../../dist/harnessMcpServer.js";
const GROUPS = [
  ["needs-you", "Needs you"],
  ["working", "Working"],
  ["waiting-others", "Waiting on others"],
  ["parked", "Parked"],
  ["done", "Done"],
];
// The VS Code tree's icons, as glyphs in its colours (charts.yellow, .blue, .purple, .green).
const GROUP_ICON = {
  "needs-you": ["●", "warning"],
  working: ["◐", "suggestion"],
  "waiting-others": ["◷", "merged"],
  parked: ["○", "subtle"],
  done: ["✓", "success"],
};
const TONE_ICON = {
  ask: ["?", "warning"],
  fail: ["✕", "error"],
  act: ["●", "warning"],
  run: ["◐", "suggestion"],
  wait: ["◷", "merged"],
  idle: ["○", "subtle"],
  done: ["✓", "success"],
};
const STAGE_ICON = {
  done: ["✓", "success"],
  skipped: ["↷", "subtle"],
  running: ["◐", "suggestion"],
  pending: ["○", "subtle"],
  failed: ["✕", "error"],
  awaiting: ["?", "warning"],
  held: ["!", "warning"],
};

const view = {
  repo: undefined,
  server: undefined,
  feed: undefined,
  feedError: undefined,
  board: undefined,
  runs: new Map(),
  openedGroups: new Set(),
  closedGroups: new Set(),
  openTasks: new Set(),
  openStages: new Set(),
  output: new Set(),
  // Full stage reports, by "taskId:stageId", each with the revision it was read at.
  reports: new Map(),
  // Answers typed so far, by question item id, until the last one sends them all.
  answers: new Map(),
  // The run the keys act on: the one opened last.
  focus: undefined,
  confirm: undefined,
  busy: undefined,
  flash: undefined,
};

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "harness",
      description: "Show every harness run, grouped by what it needs from you",
      argumentHint: "[repository path]",
      immediate: true,
    });
    return next(e);
  });

  on("command.run", { command: "harness" }, async ($, e) => {
    const repo = e.args.trim() || (await $.session.repo())?.root;
    if (!repo) return { text: "harness: not in a git repository; pass one, /harness C:\\Dev\\repo" };
    if (repo !== view.repo) stopFeed();
    view.repo = repo;
    view.server = $.plugin.root + SERVER;
    if (!view.feed) startFeed($);
    const opened = await $.ui.open({ id: PANE, title: "Harness", focus: true, closeOnEscape: true });
    return opened.isPlaced ? {} : { text: "harness: " + opened.reason };
  });

  // Never stands between the person and closing the pane: if stopping the feed
  // throws, the close goes ahead anyway.
  on("ui.close", ($, e, next) => {
    if (e.id === PANE) stopFeed();
    return next(e);
  }).catch(($, e, next) => (next.called ? undefined : next(e)));

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) => {
    return drawTree($, $.ui.resolve(e), e.props.bodyColumns || 80);
  });
}

// --- the feed ----------------------------------------------------------------

function startFeed($) {
  view.feedError = undefined;
  const feed = $.process.spawn({ argv: ["node", view.server, "--repo", view.repo, "--watch"] });
  view.feed = feed;
  void (async () => {
    let pending = "";
    let errors = "";
    try {
      for await (const piece of feed) {
        if (piece.stream === "stderr") {
          errors = (errors + piece.text).slice(-2000);
          continue;
        }
        if (piece.stream !== "stdout") continue;
        pending += piece.text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) take(JSON.parse(line));
        $.ui.invalidate("ui.render");
      }
    } catch (error) {
      errors += String(error);
    }
    // Ended on its own rather than by the pane closing: say so, or the board
    // would sit there looking live.
    if (view.feed === feed) {
      view.feed = undefined;
      view.feedError = lastLine(errors) || "the feed stopped";
      $.ui.invalidate("ui.render");
    }
  })();
}

function stopFeed() {
  const feed = view.feed;
  view.feed = undefined;
  view.board = undefined;
  view.runs.clear();
  view.openTasks.clear();
  view.openStages.clear();
  view.reports.clear();
  view.answers.clear();
  view.focus = undefined;
  view.confirm = undefined;
  if (feed) void feed.return();
}

function take(message) {
  if (message.type === "board") view.board = message.runs;
  else if (message.type === "run") view.runs.set(message.run.taskId, message.run);
  else if (message.type === "gone") {
    view.runs.delete(message.taskId);
    view.openTasks.delete(message.taskId);
    if (view.focus === message.taskId) view.focus = undefined;
  }
}

// --- decisions -----------------------------------------------------------------

/**
 * One MCP call, as a host that declares MCP Apps support: the decision tools are
 * offered only to such a host, which is what keeps them out of the model's reach.
 * Resolves the `tools/call` result, or throws with the best account of why not.
 */
async function callTool($, tool, args) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
        clientInfo: { name: "harness-pane", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
  ];
  const result = await $.process.run(["node", view.server, "--repo", view.repo], {
    stdin: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    timeoutMs: 60000,
  });
  const reply = result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  if (reply?.result) return reply.result;
  throw new Error(reply?.error?.message ?? (lastLine(result.stderr) || "No answer from the harness."));
}

async function decide($, label, tool, args) {
  view.busy = label;
  view.flash = undefined;
  $.ui.invalidate("ui.render");
  try {
    const result = await callTool($, tool, args);
    const outcome = result.structuredContent;
    view.flash = outcome
      ? { ok: outcome.ok, text: outcome.message }
      : { ok: !result.isError, text: result.content?.[0]?.text ?? "Done." };
  } catch (error) {
    view.flash = { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  // A refusal keeps the question open: "that names nothing" is answered by
  // retyping the finding, not by starting the whole sequence again.
  if (view.flash.ok) view.confirm = undefined;
  view.busy = undefined;
  $.ui.invalidate("ui.render");
}

/**
 * The stage's whole report, fetched when asked for: it runs to tens of
 * thousands of characters and the feed carries only an excerpt. Kept against
 * the revision it was read at, so a report about a run that has since moved is
 * read again rather than shown as current.
 */
async function loadReport($, run, stage) {
  const key = run.taskId + ":" + stage.id;
  view.reports.set(key, { revision: run.revision, loading: true });
  $.ui.invalidate("ui.render");
  let entry;
  try {
    const result = await callTool($, "harness_get_stage_report", { taskId: run.taskId, stageId: stage.id });
    entry = { revision: run.revision, text: result.content?.[0]?.text ?? "" , failed: Boolean(result.isError) };
  } catch (error) {
    entry = { revision: run.revision, text: error instanceof Error ? error.message : String(error), failed: true };
  }
  if (view.reports.get(key)?.loading) view.reports.set(key, entry);
  $.ui.invalidate("ui.render");
}

function approve($, run, stage, note) {
  const args = { taskId: run.taskId, stageId: stage.id, revision: run.revision };
  if (note && note.trim()) args.note = note.trim();
  return decide($, "Approving " + stage.name + "…", "harness_approve_stage", args);
}

function retry($, run, stage) {
  return decide($, "Retrying " + stage.name + "…", "harness_retry_stage", {
    taskId: run.taskId,
    stageId: stage.id,
    revision: run.revision,
  });
}

function correct($, run, stage, finding) {
  return decide($, "Filing the fix…", "harness_correct_stage", {
    taskId: run.taskId,
    stageId: stage.id,
    revision: run.revision,
    finding,
  });
}

function rerun($, run, stage, reason) {
  const args = { taskId: run.taskId, stageId: stage.id, revision: run.revision };
  if (reason && reason.trim()) args.reason = reason.trim();
  return decide($, "Re-opening " + stage.name + "…", "harness_rerun_stage", args);
}

/** The text is the finding when the stage recorded none, and a note otherwise. */
function sendBack($, run, stage, target, how, text) {
  const args = { taskId: run.taskId, fromStageId: stage.id, targetStageId: target.id, revision: run.revision, how };
  if (text && text.trim()) args[stage.sendBack.needsFindings ? "findings" : "note"] = text.trim();
  return decide($, "Sending back to " + target.name + "…", "harness_send_back", args);
}

function tick($, run, item) {
  return decide($, (item.checked ? "Unticking" : "Ticking") + "…", "harness_set_checklist_item", {
    taskId: run.taskId,
    itemId: item.id,
    checked: !item.checked,
  });
}

// --- drawing ---------------------------------------------------------------------
//
// A tree, because that is what the VS Code view is and what the eye already reads:
// group, task, stage, item, one line each, the name in full strength and what it
// is doing in a dim description after it. Icons are glyphs in the tree's colours
// so the terminal draws the same tree the desktop does.

function drawTree($, ui, columns) {
  const { Box, Text, Button } = ui;
  const head = [];
  if (view.feedError) head.push(<Text color="error">Feed stopped: {view.feedError}</Text>);
  if (view.flash) head.push(drawFlash(ui));
  if (!view.board) {
    return (
      <Box flexDirection="column">
        {head}
        <Text dimColor>{view.feedError ? "Run /harness again to restart it." : "Reading the task store…"}</Text>
      </Box>
    );
  }
  if (view.board.length === 0) {
    return (
      <Box flexDirection="column">
        {head}
        <Text dimColor>No routed tasks in {baseName(view.repo)}.</Text>
      </Box>
    );
  }

  const rows = [...head];
  if (view.board.some((run) => run.group === "needs-you")) {
    rows.push(
      <Box flexDirection="row" gap={1}>
        <Button key="next" plain hotkey="n" dimColor label="Next that needs you" onPress={() => openNext($)} />
      </Box>,
    );
  }
  let digit = 0;
  for (const [group, label] of GROUPS) {
    const runs = view.board.filter((run) => run.group === group);
    if (runs.length === 0) continue;
    const open = groupOpen(group);
    rows.push(
      <Row ui={ui} depth={0}>
        <Chevron ui={ui} open={open} />
        <Icon ui={ui} glyph={GROUP_ICON[group][0]} color={GROUP_ICON[group][1]} />
        <Button key={"group:" + group} plain label={label} onPress={() => toggle($, view.closedGroups, view.openedGroups, group)} />
        <Text dimColor>{runs.length}</Text>
      </Row>,
    );
    if (!open) continue;
    for (const run of runs) {
      const hotkey = group === "needs-you" && digit < 9 ? String(++digit) : undefined;
      rows.push(...drawTask($, ui, run, hotkey, columns));
    }
  }
  return <Box flexDirection="column">{rows}</Box>;
}

function drawTask($, ui, run, hotkey, columns) {
  const { Text, Button } = ui;
  const open = view.openTasks.has(run.taskId);
  const [glyph, color] = TONE_ICON[run.attention.tone] ?? TONE_ICON.idle;
  const description = [run.attention.need ?? run.attention.status, ageText(run.attention.since), run.ticket]
    .filter(Boolean)
    .join(" · ");
  const rows = [
    <Row ui={ui} depth={1}>
      <Chevron ui={ui} open={open} />
      <Icon ui={ui} glyph={glyph} color={color} />
      <Button
        key={"run:" + run.taskId}
        plain
        hotkey={hotkey}
        label={clip(run.name, Math.floor(columns * 0.55))}
        onPress={() => toggleTask($, run)}
      />
      <Text dimColor wrap="truncate-end">{description}</Text>
    </Row>,
  ];
  if (!open) return rows;
  const snapshot = view.runs.get(run.taskId);
  if (!snapshot) return [...rows, <Row ui={ui} depth={2}><Text dimColor>Loading…</Text></Row>];
  if (!snapshot.inFlight) {
    const advance = drawAdvance($, ui, snapshot, view.focus === run.taskId);
    if (advance) rows.push(advance);
  }
  for (const part of foldStages(snapshot)) {
    if (part.stage) {
      rows.push(...drawStage($, ui, snapshot, part.stage, columns));
      continue;
    }
    const key = run.taskId + ":fold:" + part.from;
    const open = view.output.has(key);
    const [glyph, color] = STAGE_ICON[part.state];
    rows.push(
      <Row ui={ui} depth={2}>
        <Chevron ui={ui} open={open} />
        <Icon ui={ui} glyph={glyph} color={color} />
        <Button
          key={"fold:" + key}
          plain
          dimColor
          label={part.stages.length + (part.state === "pending" ? " still to come" : " passed")}
          onPress={() => toggle($, view.output, undefined, key)}
        />
        <Text dimColor wrap="truncate-end">
          {part.stages[0].name + " … " + part.stages[part.stages.length - 1].name}
        </Text>
      </Row>,
    );
    if (open) for (const stage of part.stages) rows.push(...drawStage($, ui, snapshot, stage, columns));
  }
  return rows;
}

/**
 * A route is twenty-odd stages, and what a person opens a task to see is the one
 * or two that are live. Three or more settled stages in a row fold into one line,
 * as do three or more still to come; a stage that is open, or the one the run is
 * stopped at, is never folded away.
 */
function foldStages(run) {
  const kind = (stage) => {
    if (stage.id === run.attention.stageId || view.openStages.has(run.taskId + ":" + stage.id)) return undefined;
    if (stage.state === "done" || stage.state === "skipped") return "done";
    if (stage.state === "pending") return "pending";
    return undefined;
  };
  const parts = [];
  let index = 0;
  while (index < run.stages.length) {
    const state = kind(run.stages[index]);
    let end = index;
    while (state && end < run.stages.length && kind(run.stages[end]) === state) end++;
    if (state && end - index >= 3) {
      parts.push({ state, from: run.stages[index].id, stages: run.stages.slice(index, end) });
      index = end;
    } else {
      parts.push({ stage: run.stages[index] });
      index++;
    }
  }
  return parts;
}

function drawStage($, ui, run, stage, columns) {
  const { Text, Button } = ui;
  const key = run.taskId + ":" + stage.id;
  const open = view.openStages.has(key);
  const [glyph, color] = STAGE_ICON[stage.state] ?? STAGE_ICON.pending;
  const here = stage.id === run.attention.stageId;
  const description = [stage.held ? "held · " + stage.held : stage.failure ?? stage.statusLabel, stage.detail]
    .filter(Boolean)
    .join(" · ");
  const asked = run.question && run.question.stageName === stage.name;
  const openable = asked || stage.checklist.length > 0 || stage.canApprove || stage.canRetry || stage.state !== "pending";
  const rows = [
    <Row ui={ui} depth={2}>
      {openable ? <Chevron ui={ui} open={open} /> : <Text> </Text>}
      <Icon ui={ui} glyph={glyph} color={color} />
      <Button
        key={"stage:" + key}
        plain
        dimColor={!here && stage.state === "pending"}
        label={clip(stage.name, Math.floor(columns * 0.5))}
        onPress={() => (openable ? toggle($, view.openStages, undefined, key) : undefined)}
      />
      <Text dimColor wrap="truncate-end">{description}</Text>
    </Row>,
  ];
  if (!open || !openable) return rows;

  const actsHere = view.focus === run.taskId && here;
  if (asked) rows.push(...drawQuestion($, ui, run));
  for (const item of stage.checklist) {
    rows.push(
      <Row ui={ui} depth={3}>
        <Icon ui={ui} glyph={item.checked ? "✓" : "○"} color={item.checked ? "success" : "subtle"} />
        <Button
          key={"item:" + item.id}
          plain
          dimColor={item.checked}
          label={clip(item.text, Math.floor(columns * 0.6))}
          onPress={() => (view.busy ? undefined : tick($, run, item))}
        />
        <Text dimColor wrap="truncate-end">
          {[item.checked ? (item.checkedBy === "check" ? "verified" : "done") : item.kind === "action" ? "for you to do" : "for you to verify", item.coveredBy]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </Row>,
    );
  }
  const actions = drawActions($, ui, run, stage, actsHere);
  if (actions) rows.push(<Row ui={ui} depth={3}>{actions}</Row>);
  if (stage.state !== "pending") rows.push(...drawReport($, ui, run, stage));
  return rows;
}

/**
 * Each question in full, then a box for its answer. Answers are kept here until
 * the last one is given, then sent together: the stage asked them together, and
 * a live session receives them in one reply.
 */
function drawQuestion($, ui, run) {
  const { Text, Input } = ui;
  const question = run.question;
  if (question.submitted) {
    return [
      <Row ui={ui} depth={3}>
        <Icon ui={ui} glyph="✓" color="success" />
        <Text dimColor>Answered · waiting for VS Code to {question.live ? "hand it to the session" : "add it to the brief"}</Text>
      </Row>,
    ];
  }
  const rows = [];
  let focused = false;
  question.items.forEach((text, index) => {
    const id = question.itemIds[index];
    const answer = view.answers.get(id);
    rows.push(
      <Row ui={ui} depth={3}>
        <Icon ui={ui} glyph="?" color="warning" />
        <ui.Box flexShrink={1}>
          <Text wrap="wrap">{text}</Text>
        </ui.Box>
      </Row>,
    );
    if (answer !== undefined) {
      rows.push(
        <Row ui={ui} depth={4}>
          <Text dimColor wrap="wrap">→ {answer}</Text>
        </Row>,
      );
      return;
    }
    rows.push(
      <Row ui={ui} depth={4}>
        <Input
          key={"answer:" + id}
          autoFocus={!focused && !view.confirm ? true : undefined}
          label="Answer: "
          placeholder={question.live ? "the session is waiting for this" : "added to the brief"}
          submitLabel={index === question.items.length - 1 ? "send" : "next"}
          onSubmit={(value) => answerItem($, run, id, value)}
        />
      </Row>,
    );
    focused = true;
  });
  return rows;
}

function answerItem($, run, id, value) {
  if (!value || !value.trim()) return;
  view.answers.set(id, value.trim());
  const ids = run.question.itemIds;
  if (ids.some((itemId) => !view.answers.has(itemId))) {
    $.ui.invalidate("ui.render");
    return;
  }
  const answers = {};
  for (const itemId of ids) answers[itemId] = view.answers.get(itemId);
  return decide($, "Sending answers…", "harness_answer_questions", {
    taskId: run.taskId,
    askedAt: run.question.askedAt,
    answers,
  }).then(() => {
    // Kept on a refusal, so a question replaced meanwhile is visible as such
    // rather than as answers that vanished.
    if (view.flash?.ok) for (const itemId of ids) view.answers.delete(itemId);
    $.ui.invalidate("ui.render");
  });
}

/**
 * Advancing starts a headless runner, so the route moves whether or not VS Code is
 * open. While a run holds the route this shows who has it and offers Stop instead:
 * a second Advance would only be refused by the run lease.
 */
function drawAdvance($, ui, run, hotkeys) {
  const { Text, Button } = ui;
  const advancing = run.advancing;
  if (advancing) {
    const who = advancing.by === "headless" ? "headless" : "in VS Code";
    return (
      <Row ui={ui} depth={2}>
        <Icon ui={ui} glyph="●" color="merged" />
        <Text dimColor>
          {advancing.stopRequested ? "Stopping" : "Advancing " + who} · {ageText(advancing.since) || "just now"}
        </Text>
        {advancing.stopRequested ? null : <Text> </Text>}
        {advancing.stopRequested ? null : (
          <Button
            key={"stop:" + run.taskId}
            plain
            hotkey={hotkeys ? "x" : undefined}
            label="Stop"
            onPress={() =>
              view.busy ? undefined : decide($, "Asking the run to stop…", "harness_stop_route", { taskId: run.taskId })
            }
          />
        )}
      </Row>
    );
  }
  if (run.attention.tone === "done") return null;
  return (
    <Row ui={ui} depth={2}>
      <Text> </Text>
      <Icon ui={ui} glyph="▶" color="suggestion" />
      <Button
        key={"advance:" + run.taskId}
        plain
        hotkey={hotkeys ? "v" : undefined}
        label="Advance route"
        onPress={() =>
          view.busy ? undefined : decide($, "Starting a run…", "harness_advance_route", { taskId: run.taskId })
        }
      />
    </Row>
  );
}

function drawActions($, ui, run, stage, hotkeys) {
  const { Box, Text, Button, Input } = ui;
  if (view.busy) return <Text color="suggestion">{view.busy}</Text>;
  const confirm = view.confirm?.key === run.taskId + ":" + stage.id ? view.confirm.kind : undefined;
  if (confirm === "approve") {
    return (
      <Box flexDirection="column">
        <Input
          key="note"
          autoFocus
          label="Note for later stages: "
          placeholder="optional, Enter to approve"
          submitLabel="approve"
          onSubmit={(note) => approve($, run, stage, note)}
        />
        <Button key="cancel" hotkey="c" label="Cancel" onPress={() => setConfirm($, undefined)} />
      </Box>
    );
  }
  if (confirm === "retry") {
    return (
      <Box flexDirection="row" gap={1}>
        <Text>Retry {stage.name}?</Text>
        <Button key="yes" hotkey="y" variant="primary" label="Retry" onPress={() => retry($, run, stage)} />
        <Button key="cancel" hotkey="c" label="Cancel" onPress={() => setConfirm($, undefined)} />
      </Box>
    );
  }
  const repair = drawRepair($, ui, run, stage, confirm);
  if (repair) return repair;
  const key = run.taskId + ":" + stage.id;
  const buttons = [];
  if (stage.canApprove) {
    buttons.push(
      <Button
        key={"approve:" + key}
        hotkey={hotkeys ? "a" : undefined}
        variant="primary"
        label="Approve"
        onPress={() => setConfirm($, { kind: "approve", key })}
      />,
    );
  }
  if (stage.canRetry) {
    buttons.push(
      <Button key={"retry:" + key} hotkey={hotkeys ? "r" : undefined} label="Retry" onPress={() => setConfirm($, { kind: "retry", key })} />,
    );
  }
  if (stage.canCorrect) {
    buttons.push(
      <Button key={"fix:" + key} hotkey={hotkeys ? "f" : undefined} label="Fix" onPress={() => setConfirm($, { kind: "fix", key })} />,
    );
  }
  if (stage.sendBack) {
    buttons.push(
      <Button
        key={"sendback:" + key}
        hotkey={hotkeys ? "s" : undefined}
        label="Send back"
        onPress={() => setConfirm($, { kind: "sendback", key })}
      />,
    );
  }
  if (stage.canRerun) {
    buttons.push(
      <Button key={"rerun:" + key} hotkey={hotkeys ? "e" : undefined} label="Re-run" onPress={() => setConfirm($, { kind: "rerun", key })} />,
    );
  }
  if (buttons.length === 0 && !stage.actionNote) return null;
  return (
    <Box flexDirection="row" gap={1}>
      {buttons}
      {stage.actionNote ? <Text dimColor>{stage.actionNote}</Text> : null}
    </Box>
  );
}

/**
 * Fix, Re-run and Send back, each the extension's dialog sequence as rows: the
 * same questions in the same order, with the price — what gets re-opened — shown
 * before the last press rather than after it.
 */
function drawRepair($, ui, run, stage, confirm) {
  const { Box, Text, Button, Input } = ui;
  const cancel = <Button key="cancel" hotkey="c" label="Cancel" onPress={() => setConfirm($, undefined)} />;
  const later = laterThatRan(run, stage);
  const advice = stage.repairAdvice ? <Text color="warning" wrap="wrap">{stage.repairAdvice}</Text> : null;

  if (confirm === "fix") {
    return (
      <Box flexDirection="column">
        {advice}
        <Text dimColor>
          {stage.name} keeps what it produced and gets one session that changes only what you name.
          {later > 0 ? ` ${later} later stage(s) will be re-opened.` : ""}
        </Text>
        <Input
          key="finding"
          autoFocus
          label="What needs fixing: "
          placeholder="which screen or file, what it did, what it should do"
          submitLabel="fix"
          onSubmit={(finding) => correct($, run, stage, finding)}
        />
        {cancel}
      </Box>
    );
  }
  if (confirm === "rerun") {
    return (
      <Box flexDirection="column">
        <Text dimColor>
          Discards {stage.name}
          {later > 0 ? ` and ${later} later stage(s) that ran` : ""}, and runs it again from scratch.
        </Text>
        <Input
          key="reason"
          autoFocus
          label="Why: "
          placeholder="handed to the new session; empty if the fix was in harness.json"
          submitLabel="re-run"
          onSubmit={(reason) => rerun($, run, stage, reason)}
        />
        {cancel}
      </Box>
    );
  }
  if (confirm !== "sendback") return null;

  const chosen = view.confirm.target && stage.sendBack.targets.find((t) => t.id === view.confirm.target);
  if (!chosen) {
    // Nearest first, as the route orders them; the count is the price of each.
    return (
      <Box flexDirection="column">
        <Text>Send {stage.name}'s findings back to:</Text>
        {stage.sendBack.targets.map((target, index) => (
          <Box flexDirection="row" gap={1}>
            <Button
              key={"target:" + target.id}
              hotkey={index < 9 ? String(index + 1) : undefined}
              label={target.name}
              onPress={() => setConfirm($, { ...view.confirm, target: target.id })}
            />
            <Text dimColor>re-opens {target.reopens} stage(s){index === 0 ? " · nearest" : ""}</Text>
          </Box>
        ))}
        {cancel}
      </Box>
    );
  }
  const how = view.confirm.how ?? (chosen.correctable ? undefined : "rerun");
  if (!how) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button
            key="how:fix"
            hotkey="f"
            variant="primary"
            label="Fix the findings"
            onPress={() => setConfirm($, { ...view.confirm, how: "fix" })}
          />
          <Text dimColor>{chosen.name} keeps its work · recommended</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="how:rerun" hotkey="e" label="Re-run it" onPress={() => setConfirm($, { ...view.confirm, how: "rerun" })} />
          <Text dimColor>discards {chosen.reopens} stage(s) · for when the approach was wrong</Text>
        </Box>
        {cancel}
      </Box>
    );
  }
  const asks = stage.sendBack.needsFindings;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {how === "fix" ? `${chosen.name} will fix them, keeping its work.` : `Re-opens ${chosen.reopens} stage(s) from ${chosen.name}.`}
      </Text>
      <Input
        key="sendnote"
        autoFocus
        label={asks ? "What went wrong: " : "Anything to add: "}
        placeholder={asks ? "this becomes the finding the stage is given" : "optional, Enter to send"}
        submitLabel="send back"
        onSubmit={(text) => sendBack($, run, stage, chosen, how, text)}
      />
      {cancel}
    </Box>
  );
}

function laterThatRan(run, stage) {
  const index = run.stages.findIndex((s) => s.id === stage.id);
  return run.stages.slice(index + 1).filter((s) => s.state !== "pending").length;
}

/**
 * "Report" opens the excerpt at once and fetches the whole report behind it, so
 * the few seconds a fetch takes are spent reading the end of the stage's reply
 * rather than looking at a spinner.
 */
function drawReport($, ui, run, stage) {
  const { Text, Button, Markdown } = ui;
  const key = run.taskId + ":" + stage.id;
  const shown = view.output.has(key);
  const report = view.reports.get(key);
  const current = report && report.revision === run.revision ? report : undefined;
  const rows = [
    <Row ui={ui} depth={3}>
      <Button
        key={"report:" + key}
        plain
        dimColor
        label={shown ? "Hide report" : "Report"}
        onPress={() => {
          toggle($, view.output, undefined, key);
          if (!view.output.has(key) || current) return;
          void loadReport($, run, stage);
        }}
      />
      {shown && current?.loading ? <Text dimColor>reading the full report…</Text> : null}
    </Row>,
  ];
  if (!shown) return rows;
  if (current && !current.loading) {
    rows.push(
      <Row ui={ui} depth={3}>
        {current.failed ? <Text color="error">{current.text}</Text> : <Markdown text={current.text} />}
      </Row>,
    );
  } else if (stage.excerpt) {
    rows.push(
      <Row ui={ui} depth={3}>
        <Markdown text={stage.excerpt} dimColor />
      </Row>,
    );
  }
  return rows;
}

/** One tree line: indented by depth, its parts on one row, nothing wrapping. */
function Row({ ui, depth, children }) {
  const { Box } = ui;
  return (
    <Box flexDirection="row" gap={1} marginLeft={depth * 2} overflow="hidden">
      {children}
    </Box>
  );
}

function Chevron({ ui, open }) {
  const { Text } = ui;
  return <Text dimColor>{open ? "▾" : "▸"}</Text>;
}

function Icon({ ui, glyph, color }) {
  const { Text } = ui;
  return <Text color={color}>{glyph}</Text>;
}

function drawFlash(ui) {
  const { Text } = ui;
  return <Text color={view.flash.ok ? "success" : "error"}>{view.flash.text}</Text>;
}

// --- state changes -------------------------------------------------------------

/** Groups follow the tree's defaults until the person opens or closes one. */
function groupOpen(group) {
  if (view.openedGroups.has(group)) return true;
  if (view.closedGroups.has(group)) return false;
  return group === "needs-you" || group === "working";
}

function toggle($, set, opposite, key) {
  if (opposite) {
    // A group's open state is a default plus an override in one direction or the other.
    const open = groupOpen(key);
    set.delete(key);
    opposite.delete(key);
    (open ? set : opposite).add(key);
  } else if (set.has(key)) set.delete(key);
  else set.add(key);
  $.ui.invalidate("ui.render");
}

/**
 * Opening a task opens the stage that needs you, and makes it the one the
 * keys act on: `a` and `r` reach the run you last opened, never another.
 */
function toggleTask($, run) {
  if (view.openTasks.has(run.taskId)) {
    view.openTasks.delete(run.taskId);
    if (view.focus === run.taskId) view.focus = undefined;
  } else {
    view.openTasks.add(run.taskId);
    view.focus = run.taskId;
    if (run.attention.stageId) view.openStages.add(run.taskId + ":" + run.attention.stageId);
  }
  view.confirm = undefined;
  view.flash = undefined;
  $.ui.invalidate("ui.render");
}

/** `n`: close what is open and open the next run that needs you. */
function openNext($) {
  const queue = (view.board ?? []).filter((run) => run.group === "needs-you");
  if (queue.length === 0) return;
  const index = queue.findIndex((run) => run.taskId === view.focus);
  const next = queue[(index + 1) % queue.length];
  view.openTasks.clear();
  view.openStages.clear();
  toggleTask($, next);
}

function setConfirm($, confirm) {
  view.confirm = confirm;
  $.ui.invalidate("ui.render");
}

// --- helpers ---------------------------------------------------------------------

function ageText(since) {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000));
  if (Number.isNaN(minutes)) return "";
  if (minutes < 60) return minutes + "m";
  if (minutes < 48 * 60) return Math.round(minutes / 60) + "h";
  return Math.round(minutes / 1440) + "d";
}

function clip(text, width) {
  return text.length <= width ? text : text.slice(0, Math.max(1, width - 1)).trimEnd() + "…";
}

function baseName(path) {
  return (path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function lastLine(text) {
  return (text ?? "").trim().split("\n").pop()?.trim() ?? "";
}
