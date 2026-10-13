/**
 * The Engineering Harness dashboard, served as an MCP App (`ui://` resource).
 *
 * Shipped as a string, like the gate hook and the `ask_user` server: one artefact,
 * no build step of its own, nothing fetched at runtime — so the host's default
 * content-security policy (no network) is exactly right.
 *
 * **A board first, a run second.** The harness exists so one person can supervise
 * several concurrent tasks, so the first thing on screen is every task grouped by what
 * it needs — the tree's own groups, worst first — each row saying the act in one line
 * ("Approve …", "Answer 2 questions …") and how long it has waited. One click opens the
 * run on the stage that needs you, with what you must read to decide and the buttons to
 * decide it; "Next" walks the rest of the queue. The first version opened on a single
 * run behind a dropdown, which answered "what is this task doing?" when the question a
 * supervisor asks is "what is waiting on me?".
 *
 * A **view**, and nothing more. It holds which run and stage are open and what is typed
 * into the note box; every fact on screen comes from a tool result, and every button is
 * a `tools/call` to an app-only tool that runs the engine's own transition. It
 * refreshes by polling `harness_refresh`, so a change made in VS Code appears here
 * within one interval.
 *
 * A re-render must not cost the operator what they are typing. It did: a tick made in
 * VS Code while the approval note was open re-rendered the panel and discarded the
 * note. So the note lives in view state, the composer survives a refresh with a line
 * saying the run moved, and the approval is checked against the revision the operator
 * was looking at when they pressed Approve. A change underneath is then refused as
 * stale rather than approved over, and the refusal keeps the note and re-arms against
 * what is now on screen — confirming again is a decision about the current run.
 *
 * **Suggested work sits under the runs**, and only where the project configures a
 * source: absent rather than empty, so a project without one is not shown a section it
 * can do nothing with. A scan is a detached paid session, so the page starts it and the
 * ordinary poll shows the list when it lands. Starting a task asks what VS Code's create
 * flow asks, in a form held in view state for the same reason the note is.
 *
 * Written without template literals or `${`, because it lives inside one.
 */
export const HARNESS_DASHBOARD_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Engineering Harness</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, light-dark(#ffffff, #1f1f1e));
    --bg2: var(--color-background-secondary, light-dark(#f6f5f1, #272725));
    --bg3: var(--color-background-tertiary, light-dark(#ebe9e2, #33332f));
    --fg: var(--color-text-primary, light-dark(#1f1e1d, #f0eee6));
    --muted: var(--color-text-secondary, light-dark(#66645e, #a9a79f));
    --faint: var(--color-text-tertiary, light-dark(#9b998f, #75736c));
    --line: var(--color-border-primary, light-dark(#e5e2d9, #383835));
    --accent: light-dark(#2a62c4, #7fa9f3);
    --on-accent: light-dark(#ffffff, #10213f);
    --ask: light-dark(#a86400, #e9aa4c);
    --fail: light-dark(#bb2d24, #f27c72);
    --wait: light-dark(#7556b0, #b49cea);
    --ok: light-dark(#2d7a37, #72c57c);
    --radius: 10px;
    --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    --mono: var(--font-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  }
  * { box-sizing: border-box; }
  html, body { overflow-x: hidden; }
  main > section { min-width: 0; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 13.5px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
  button, input, select, textarea { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .app { padding: 12px 14px 14px; }

  .tone-ask { --tone: var(--ask); } .tone-fail { --tone: var(--fail); } .tone-act { --tone: var(--accent); }
  .tone-run { --tone: var(--accent); } .tone-wait { --tone: var(--wait); } .tone-idle { --tone: var(--faint); }
  .tone-done { --tone: var(--ok); }

  /* top bar */
  header.top { display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; margin-bottom: 14px; }
  .brand { display: flex; align-items: center; gap: 8px; }
  .brand b { font-weight: 600; }
  .repo { color: var(--muted); }
  .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
  .pulse.on { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
  .tally { display: flex; gap: 6px; flex: 1; flex-wrap: wrap; }
  .chip { display: inline-flex; gap: 5px; align-items: baseline; border: 1px solid var(--line); background: transparent; border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
  .chip:hover { background: var(--bg2); }
  .chip b { color: var(--tone, var(--fg)); font-weight: 650; font-variant-numeric: tabular-nums; }
  .ghost { background: transparent; border: 1px solid transparent; border-radius: 7px; padding: 3px 8px; color: var(--muted); }
  .ghost:hover { background: var(--bg2); color: var(--fg); }

  .split main { display: grid; grid-template-columns: minmax(300px, 38%) minmax(0, 1fr); gap: 18px; align-items: start; }

  /* board */
  .group { margin-bottom: 16px; }
  .ghead { display: flex; align-items: center; gap: 6px; width: 100%; background: none; border: 0; padding: 0 2px 6px; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); text-align: left; }
  .ghead .caret { width: 10px; color: var(--faint); }
  .ghead .count { color: var(--faint); font-weight: 500; }
  .rows { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: transparent; border: 0; border-top: 1px solid var(--line); padding: 9px 12px 9px 15px; position: relative; }
  .row:first-child { border-top: 0; }
  .row::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 0 3px 3px 0; background: var(--tone); }
  .row:hover { background: var(--bg2); }
  .row.sel { background: color-mix(in srgb, var(--accent) 9%, var(--bg)); }
  .row:focus-visible { outline-offset: -2px; }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .title { display: flex; gap: 7px; align-items: baseline; min-width: 0; }
  .ref { font: 600 11.5px/1.4 var(--mono); color: var(--muted); flex: none; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
  .need { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tone-act .need { color: var(--fg); }
  .tone-ask .need { color: var(--ask); } .tone-fail .need { color: var(--fail); }
  .meta { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .age { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .strip { display: flex; gap: 1.5px; width: 64px; height: 4px; }
  .strip i { flex: 1; border-radius: 1px; background: var(--bg3); }
  .strip .s-done { background: color-mix(in srgb, var(--ok) 70%, var(--bg3)); }
  .strip .s-skipped { background: var(--faint); opacity: .5; }
  .strip .s-running { background: var(--accent); }
  .strip .s-awaiting { background: var(--accent); }
  .strip .s-held { background: var(--ask); }
  .strip .s-failed { background: var(--fail); }
  .calm { border: 1px dashed var(--line); border-radius: var(--radius); padding: 14px; color: var(--muted); text-align: center; margin-bottom: 16px; }
  .split .need { white-space: normal; }
  .split .strip { width: 44px; }
  @media (max-width: 420px) { .strip { display: none; } }

  /* suggested work */
  .sghead { display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; padding-bottom: 6px; }
  .sghead .ghead { flex: 1; width: auto; padding-bottom: 0; }
  .sghead .age { white-space: nowrap; }
  .sghead .bad { color: var(--fail); }
  .group .callout { margin: 0 0 8px; }
  .group > .flash { margin: 0 0 8px; }
  .row.sg:hover { background: transparent; }
  .row.hid { opacity: .6; }
  a.ref { color: var(--accent); text-decoration: none; }
  a.ref:hover { text-decoration: underline; }
  .btn.sm { padding: 3px 10px; font-size: 12px; }
  .sgform { display: grid; gap: 8px; border-top: 1px solid var(--line); background: var(--bg2); padding: 10px 12px 12px 15px; }
  .sgform .f { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
  .sgform input[type=text], .sgform select, .sgform textarea { width: 100%; min-width: 0; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; color: var(--fg); font-size: 13px; }
  .sgform textarea { min-height: 64px; resize: vertical; }
  .sgform .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .sgform .tick { display: flex; gap: 8px; align-items: center; font-size: 12.5px; cursor: pointer; }
  .sgform .tick input { accent-color: var(--accent); }
  .sgform .hint, .sgform .actions, .sgform .flash { margin: 0; }
  .toggle-hidden { margin-top: 6px; }

  /* run */
  .crumbs { display: flex; align-items: center; gap: 6px; margin: -2px 0 8px -8px; }
  .crumbs .spacer { flex: 1; }
  .crumbs .more { color: var(--faint); font-size: 12px; }
  .runhead h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.3; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .runhead h2 .ref { font-size: 13px; }
  .runhead .sub { color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
  .runhead .desc { font-size: 12.5px; margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .remove { margin-top: 14px; }
  .remove .hint { margin-bottom: 6px; }
  .route { list-style: none; display: flex; gap: 4px; overflow-x: auto; padding: 12px 0 10px; margin: 0; scrollbar-width: none; }
  .route::-webkit-scrollbar { display: none; }
  .node { display: flex; align-items: center; gap: 5px; max-width: 160px; border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 2px 9px 2px 7px; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .node:hover { background: var(--bg2); color: var(--fg); }
  .node .lbl { overflow: hidden; text-overflow: ellipsis; }
  .node .g { font-weight: 700; width: 1em; text-align: center; }
  .node.sel { border-color: var(--accent); color: var(--fg); box-shadow: inset 0 0 0 1px var(--accent); }
  .n-done .g { color: var(--ok); } .n-skipped .g, .n-pending .g { color: var(--faint); }
  .n-running .g { color: var(--accent); } .n-awaiting .g { color: var(--accent); }
  .n-held .g { color: var(--ask); } .n-failed .g { color: var(--fail); }
  @media (prefers-reduced-motion: no-preference) { .n-running .g { animation: blink 1.4s ease-in-out infinite; } }
  @keyframes blink { 50% { opacity: .35; } }

  .focus { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px 16px; position: relative; overflow: hidden; }
  .focus::before { content: ""; position: absolute; left: 0; top: 0; right: 0; height: 3px; background: var(--tone, var(--line)); }
  .kicker { font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--tone, var(--muted)); }
  .focus h3 { margin: 2px 0 0; font-size: 16px; font-weight: 600; line-height: 1.35; }
  .askline { margin: 6px 0 0; font-size: 14px; }
  .detail { margin: 4px 0 0; color: var(--muted); }
  .facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 10px; font-size: 12px; color: var(--muted); }
  .facts code { font: 11.5px var(--mono); }
  .pill { display: inline-block; border-radius: 999px; padding: 0 8px; font-size: 11.5px; font-weight: 550; border: 1px solid; }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); }
  .pill.warn { color: var(--ask); border-color: color-mix(in srgb, var(--ask) 40%, transparent); background: color-mix(in srgb, var(--ask) 8%, transparent); }
  .callout { margin-top: 12px; padding: 8px 11px; border-radius: 8px; background: var(--bg2); border-left: 3px solid var(--line); overflow-wrap: anywhere; }
  .callout.warn { border-left-color: var(--ask); } .callout.bad { border-left-color: var(--fail); } .callout.info { border-left-color: var(--accent); }
  .callout ul { margin: 4px 0 0; padding-left: 18px; }
  .section-label { margin: 16px 0 4px; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .checks { list-style: none; margin: 0; padding: 0; }
  .checks label { display: flex; gap: 9px; align-items: flex-start; padding: 5px 8px; margin: 0 -8px; border-radius: 7px; cursor: pointer; }
  .checks label:hover { background: var(--bg2); }
  .checks input { margin: 3px 0 0; width: 15px; height: 15px; flex: none; accent-color: var(--accent); }
  .checks .ticked > span { color: var(--muted); }
  .checks small { display: block; color: var(--muted); font-size: 11.5px; }
  .itemacts { display: flex; gap: 10px; margin: -2px 0 4px 24px; }
  .linkbtn { border: 0; background: none; padding: 0; color: var(--accent); font-size: 11.5px; cursor: pointer; }
  .linkbtn:disabled { color: var(--muted); cursor: default; }
  .editor { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 2px 0 8px 24px; }
  .editor input[type=text], .editor select { flex: 1 1 220px; min-width: 0; background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; }
  .defer li { margin-bottom: 6px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
  .actions input[type=text] { flex: 1 1 240px; background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
  .btn { border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 6px 14px; font-weight: 550; }
  .btn:hover { background: var(--bg2); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .btn.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--fg)); }
  .btn:disabled { opacity: .5; cursor: default; }
  .hint { margin-top: 8px; font-size: 12px; color: var(--muted); }
  .flash { margin-top: 10px; font-size: 12.5px; }
  .flash.ok { color: var(--ok); } .flash.bad { color: var(--fail); }
  details.reply { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
  details summary:hover { color: var(--fg); }
  pre { font: 12px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; background: var(--bg2); padding: 10px 12px; border-radius: 8px; margin: 8px 0 0; }
  .card { border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin-top: 12px; }
  details.all { margin-top: 12px; }
  .list { list-style: none; margin: 8px 0 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .list button { display: flex; gap: 9px; align-items: baseline; width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--line); padding: 6px 12px; }
  .list li:first-child button { border-top: 0; }
  .list button:hover { background: var(--bg2); }
  .list .sel { background: color-mix(in srgb, var(--accent) 9%, var(--bg)); }
  .list .nm { flex: 1; min-width: 0; }
  .list small { color: var(--muted); }
  .loading { color: var(--muted); padding: 24px 0; }
  .foot { margin-top: 16px; color: var(--faint); font-size: 11px; }
  .empty { color: var(--muted); padding: 20px 0; }
</style>
</head>
<body>
<div class="app" id="root"><div class="empty">Connecting to the harness…</div></div>
<script>
(function () {
  "use strict";
  var POLL_MS = 3000;
  var GROUPS = ["needs-you", "working", "waiting-others", "parked", "done", "no-route"];
  var GLYPH = { done: "✓", skipped: "–", running: "●", pending: "○", failed: "!", awaiting: "?", held: "?" };
  var KICKER = { ask: "Waiting for your answer", fail: "Failed", act: "Needs you", run: "Working", wait: "With others", idle: "Idle", done: "Done" };
  var STATE_TONE = { done: "done", skipped: "idle", running: "run", pending: "idle", failed: "fail", awaiting: "act", held: "ask" };

  var state = {
    runs: [], run: null, repositoryRoot: "",
    view: "board", taskId: null, stageId: null,
    lastKey: null, lastPaint: 0, lastRevision: null,
    flash: null, confirming: false, note: "", report: null,
    // The one item or declined entry being written about: { kind, id, text, checkId }.
    edit: null,
    busy: false, canCall: true, allOpen: false,
    displayMode: "inline", modes: [],
    closed: { parked: true, done: true, "no-route": true },
    // Suggested work: the board as the server sent it, the new-task options (fetched once),
    // the one open start form, and the section's own message line.
    suggestions: null, options: null, form: null, sgFlash: null, showHidden: false, canOpenLinks: false
  };

  // --- JSON-RPC over postMessage --------------------------------------------
  var nextId = 1, pending = {};
  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && !msg.method) {
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || "error")); else p.resolve(msg.result);
      return;
    }
    switch (msg.method) {
      case "ui/notifications/tool-input":
        var args = (msg.params && msg.params.arguments) || {};
        if (args.taskId) { state.view = "run"; state.taskId = args.taskId; }
        break;
      case "ui/notifications/tool-result":
        accept(msg.params, true);
        break;
      case "ui/notifications/host-context-changed":
        applyContext(msg.params);
        paint();
        break;
      case "ui/resource-teardown":
        stopPolling();
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      default:
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  });

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.style.colorScheme = ctx.theme;
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) Object.keys(vars).forEach(function (k) { document.documentElement.style.setProperty(k, vars[k]); });
    if (ctx.displayMode) state.displayMode = ctx.displayMode;
    if (ctx.availableDisplayModes) state.modes = ctx.availableDisplayModes;
  }

  // --- data -----------------------------------------------------------------
  function accept(result, fromHost) {
    var data = result && result.structuredContent;
    if (!data || !data.runs) return;
    state.runs = data.runs;
    state.repositoryRoot = data.repositoryRoot || state.repositoryRoot;
    // "Scan started" stops being true the moment the scan lands.
    if (state.suggestions && state.suggestions.scanningSince && !(data.suggestions && data.suggestions.scanningSince)) state.sgFlash = null;
    state.suggestions = data.suggestions || null;
    // An item that left the list was started elsewhere or dropped by the source, so a form
    // still open on it would create a task for something no longer offered.
    if (state.form && !state.busy && !suggestionByKey(state.form.key)) state.form = null;
    var run = data.run || null;
    // The tool that opened the panel named a run: open on it.
    if (fromHost && run) { state.view = "run"; state.taskId = run.taskId; }
    // A reply for a run the operator has since left says nothing about the one open now.
    if (run && run.taskId !== state.taskId) run = null;

    if (run) {
      var moved = !state.run || state.run.taskId !== run.taskId || run.revision !== state.lastRevision;
      state.run = run;
      if (!state.stageId || !run.stages.some(function (s) { return s.id === state.stageId; })) {
        state.stageId = focusStage(run);
      }
      if (moved) {
        state.lastRevision = run.revision;
        if (state.confirming) {
          if (state.rearm) { state.decisionRevision = run.revision; state.rearm = false; }
          else state.movedWhileDeciding = true;
        }
      }
    }
    paint();
  }

  // Re-renders only when something on screen changed, or once a minute so ages move.
  function paint() {
    var key = JSON.stringify(state.runs) + "|" + (state.run ? state.run.revision : "") + "|" + state.view + "|" + state.taskId +
      "|" + state.stageId + "|" + state.displayMode + "|" + JSON.stringify(state.suggestions);
    if (key === state.lastKey && Date.now() - state.lastPaint < 60000) return;
    state.lastKey = key;
    render();
  }

  function focusStage(run) {
    var summary = summaryOf(run.taskId);
    var wanted = summary && summary.attention && summary.attention.stageId;
    if (wanted && run.stages.some(function (s) { return s.id === wanted; })) return wanted;
    var order = ["awaiting", "held", "failed", "running"];
    for (var i = 0; i < order.length; i++) {
      var hit = run.stages.filter(function (s) { return s.state === order[i]; })[0];
      if (hit) return hit.id;
    }
    var next = run.stages.filter(function (s) { return s.state === "pending"; })[0];
    return (next || run.stages[run.stages.length - 1] || {}).id || null;
  }

  function call(name, args) {
    return request("tools/call", { name: name, arguments: args || {} });
  }

  function refresh() {
    if (!state.canCall) return Promise.resolve();
    var args = state.view === "run" && state.taskId ? { taskId: state.taskId } : {};
    return call("harness_refresh", args)
      .then(function (r) { accept(r, false); })
      .catch(function () { state.canCall = false; render(); });
  }

  var timer = null;
  function startPolling() { if (!timer) timer = setInterval(function () { if (!document.hidden && !state.busy) refresh(); }, POLL_MS); }
  function stopPolling() { if (timer) clearInterval(timer); timer = null; }

  // keepComposing(sc) returning true leaves the approval composer open — used for a
  // stale refusal, where the note is still wanted and only the facts moved.
  function act(name, args, keepComposing) {
    state.busy = true;
    state.flash = null;
    render();
    var keep = false;
    call(name, args).then(function (result) {
      var sc = (result && result.structuredContent) || {};
      var text = (result && result.content && result.content[0] && result.content[0].text) || "";
      keep = !!(keepComposing && keepComposing(sc));
      if (!result.isError) state.edit = null;
      state.flash = keep
        ? { ok: false, text: (sc.message || text) + " Your note is kept." }
        : { ok: !result.isError, text: sc.message || text };
    }).catch(function (e) {
      state.flash = { ok: false, text: e.message };
    }).then(function () {
      state.busy = false;
      state.confirming = keep;
      state.rearm = keep;
      state.movedWhileDeciding = false;
      if (!keep) state.note = "";
      state.lastRevision = null;
      state.lastKey = null;
      return refresh();
    });
  }

  // --- suggested work -------------------------------------------------------
  function resultText(result) { return (result && result.content && result.content[0] && result.content[0].text) || ""; }

  // A scan returns as soon as it has started; the poll brings the list in when it lands.
  function scan() {
    state.busy = true;
    state.sgFlash = null;
    render();
    call("harness_scan_suggestions", {}).then(function (result) {
      var sc = (result && result.structuredContent) || {};
      state.sgFlash = { ok: !!result && !result.isError && sc.ok !== false, text: sc.message || resultText(result) };
    }).catch(function (e) {
      state.sgFlash = { ok: false, text: e.message };
    }).then(function () {
      state.busy = false;
      state.lastKey = null;
      return refresh();
    });
  }

  // One form at a time, prefilled from the item. The options are a property of the
  // project rather than of the item, so they are fetched once and kept.
  function openStartForm(key) {
    var s = suggestionByKey(key);
    if (!s) return;
    state.form = {
      key: key, sourceId: s.sourceId, ref: s.ref, name: s.title, prefix: "", base: "", route: "", assess: false,
      brief: [s.ref, s.url, s.detail].filter(Boolean).join(" — "), error: null
    };
    state.sgFlash = null;
    if (state.options) { formDefaults(); render(); return; }
    render();
    call("harness_task_options", {}).then(function (result) {
      var o = result && result.structuredContent;
      if (!o || result.isError || !o.routes) throw new Error(resultText(result) || "Could not load the options for a new task.");
      state.options = o;
      if (state.form && state.form.key === key) formDefaults();
      render();
    }).catch(function (e) {
      if (state.form && state.form.key === key) state.form = null;
      state.sgFlash = { ok: false, text: e.message };
      render();
    });
  }
  function formDefaults() {
    var o = state.options, f = state.form;
    f.prefix = o.branchPrefixes[0] || "";
    f.base = o.baseBranches[0] || "";
    f.route = o.routes.length ? o.routes[0].id : "";
  }

  function createTask() {
    var f = state.form;
    if (!f || state.busy) return;
    if (!f.name.trim()) { f.error = "A task needs a name."; render(); return; }
    var args = { sourceId: f.sourceId, ref: f.ref, name: f.name.trim(), branchPrefix: f.prefix, baseBranch: f.base, brief: f.brief };
    if (f.route) { args.routeId = f.route; args.assessFirst = f.assess; }
    var opened = null;
    state.busy = true;
    f.error = null;
    render();
    call("harness_start_task", args).then(function (result) {
      var sc = (result && result.structuredContent) || {};
      if (!result || result.isError || !sc.ok) { f.error = sc.message || resultText(result) || "The task was not created."; return; }
      state.form = null;
      state.sgFlash = { ok: true, text: sc.message || resultText(result) };
      if (sc.routed && sc.taskId) opened = sc.taskId;
    }).catch(function (e) {
      f.error = e.message;
    }).then(function () {
      state.busy = false;
      state.lastKey = null;
      // A routed task is a run, so it opens like one; a chat task has nothing to show here.
      if (opened) openRun(opened);
      else { render(); refresh(); }
    });
  }

  // --- navigation -----------------------------------------------------------
  function openRun(taskId) {
    if (state.taskId !== taskId) {
      var summary = summaryOf(taskId);
      state.stageId = (summary && summary.attention && summary.attention.stageId) || null;
      state.flash = null; state.report = null; state.confirming = false; state.note = "";
      state.lastRevision = null;
    }
    state.view = "run";
    state.taskId = taskId;
    if (state.run && state.run.taskId !== taskId) state.run = null;
    render();
    refresh();
  }
  function closeRun() {
    state.view = "board"; state.confirming = false; state.report = null; state.flash = null;
    render();
  }
  function queue() { return sorted("needs-you"); }
  function nextNeeding() {
    var q = queue();
    if (!q.length) return null;
    var at = -1;
    for (var i = 0; i < q.length; i++) if (q[i].taskId === state.taskId) at = i;
    var next = q[(at + 1) % q.length];
    return next.taskId === state.taskId ? null : next;
  }

  // --- formatting -------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) { return n ? "$" + n.toFixed(2) : "$0"; }
  function minutes(ms) { return ms ? Math.max(1, Math.round(ms / 60000)) + "m" : "0m"; }
  function age(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }
  function $(id) { return document.getElementById(id); }
  function summaryOf(taskId) { return state.runs.filter(function (r) { return r.taskId === taskId; })[0] || null; }
  function wide() { return (document.documentElement.clientWidth || 0) >= 880; }
  function repoName() {
    var parts = String(state.repositoryRoot || "").split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || "";
  }
  // Oldest first where the row is a wait, so the forgotten one surfaces; otherwise as listed.
  function sorted(group) {
    var rows = state.runs.filter(function (r) { return r.group === group; });
    if (group === "needs-you" || group === "waiting-others") {
      rows = rows.slice().sort(function (a, b) {
        var x = a.attention.since || "9", y = b.attention.since || "9";
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
    return rows;
  }
  function ref(r) { return r && r.ticket ? '<span class="ref">' + esc(r.ticket) + "</span>" : ""; }
  function clock(iso) {
    var d = new Date(Date.parse(iso));
    if (isNaN(d.getTime())) return "";
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  // A suggestion is the source's ref within that source, as the server keys it.
  function suggestionKey(s) { return s.sourceId + "|" + s.ref; }
  function suggestionByKey(key) {
    return ((state.suggestions && state.suggestions.suggestions) || []).filter(function (s) { return suggestionKey(s) === key; })[0] || null;
  }
  // Only a host that says it opens links gets one, and only a web address: the url is
  // whatever the source wrote, and a page link that does nothing reads as broken.
  function linkable(url) { return state.canOpenLinks && /^https?:/i.test(String(url || "")); }

  // --- rendering --------------------------------------------------------------
  function render() {
    var root = $("root");
    // Whatever field had focus gets it back, caret and all: a poll landing mid-sentence
    // must not cost the operator their place in the note or the start form.
    var active = document.activeElement;
    var typing = active && active.id && /^(note$|sg-|ed-)/.test(active.id) ? active.id : null;
    var caret = null;
    try { if (typing && typeof active.selectionStart === "number") caret = [active.selectionStart, active.selectionEnd]; } catch (e) { caret = null; }
    var split = state.view === "run" && wide();
    root.className = "app" + (split ? " split" : "");
    var showBoard = state.view === "board" || split;
    root.innerHTML = topBar() + "<main>" +
      (showBoard ? '<section class="board">' + board() + "</section>" : "") +
      (state.view === "run" ? '<section class="run">' + runPane() + "</section>" : "") +
      "</main>" + footer();
    wire();
    state.lastPaint = Date.now();
    var field = typing && $(typing);
    if (field) {
      field.focus();
      try { if (caret) field.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
    }
    // Scrolls the strip only. scrollIntoView would also scroll every ancestor — the
    // page, and in a same-origin host the host's own page — sideways.
    var sel = document.querySelector(".node.sel");
    var strip = sel && sel.closest(".route");
    if (strip) strip.scrollLeft = Math.max(0, sel.parentNode.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + sel.offsetWidth / 2);
  }

  function topBar() {
    function chip(group, words, tone) {
      var n = state.runs.filter(function (r) { return r.group === group; }).length;
      if (!n && group !== "needs-you") return "";
      return '<button class="chip tone-' + tone + '" data-jump="' + group + '"><b>' + n + "</b>" + words + "</button>";
    }
    var full = state.displayMode === "fullscreen";
    var canToggle = state.modes.indexOf(full ? "inline" : "fullscreen") !== -1;
    return '<header class="top"><div class="brand"><span class="pulse' + (state.canCall ? " on" : "") + '" title="' +
      (state.canCall ? "Live" : "Not refreshing") + '"></span><b>Harness</b><span class="repo">' + esc(repoName()) + "</span></div>" +
      '<nav class="tally">' + chip("needs-you", " need you", "act") + chip("working", " working", "run") +
      chip("waiting-others", " with others", "wait") + "</nav>" +
      (canToggle ? '<button class="ghost" id="mode">' + (full ? "Exit full screen" : "Full screen") + "</button>" : "") +
      "</header>";
  }

  function board() {
    var flash = state.boardFlash
      ? '<div class="flash ' + (state.boardFlash.ok ? "ok" : "bad") + '">' + esc(state.boardFlash.text) + "</div>"
      : "";
    return flash + runGroups() + suggestionsSection();
  }

  function runGroups() {
    if (!state.runs.length) return '<div class="empty">No routed tasks in ' + esc(state.repositoryRoot || "this repository") + ".</div>";
    var html = "";
    GROUPS.forEach(function (group) {
      var rows = sorted(group);
      if (!rows.length) {
        if (group === "needs-you") html += '<div class="calm">Nothing needs you right now.</div>';
        return;
      }
      var open = !state.closed[group];
      html += '<section class="group" id="g-' + group + '"><button class="ghead" data-toggle="' + group + '">' +
        '<span class="caret">' + (open ? "▾" : "▸") + "</span>" + esc(rows[0].groupLabel) +
        '<span class="count">' + rows.length + "</span></button>" +
        (open ? '<div class="rows">' + rows.map(row).join("") + "</div>" : "") + "</section>";
    });
    return html;
  }

  function row(r) {
    var a = r.attention || { status: r.groupLabel, tone: "idle" };
    var selected = state.view === "run" && r.taskId === state.taskId;
    // The description and ticket, as the row's tooltip: the name says which task,
    // this says what the work is.
    var tip = [r.description, [r.ticket, r.ticketUrl].filter(Boolean).join(" · ")].filter(Boolean).join("\n\n");
    return '<button class="row tone-' + a.tone + (selected ? " sel" : "") + '" data-task="' + esc(r.taskId) + '"' +
      (tip ? ' title="' + esc(tip) + '"' : "") + ">" +
      '<span class="what"><span class="title">' + ref(r) + '<span class="name">' + esc(r.name) + "</span></span>" +
      '<span class="need">' + esc(a.need || a.status) + "</span></span>" +
      '<span class="meta">' + (a.since ? '<span class="age" title="' + esc(a.since) + '">' + age(a.since) + "</span>" : "") +
      '<span class="strip" title="' + r.progress.done + " of " + r.progress.total + ' stages done">' +
      r.strip.map(function (s) { return '<i class="s-' + s + '"></i>'; }).join("") + "</span></span></button>";
  }

  // Worded on what happened, never on what is missing: a list that has never been
  // scanned and one that came back empty are different facts with different next steps.
  function suggestionsSection() {
    var b = state.suggestions;
    if (!b || !b.configured) return "";
    var all = b.suggestions || [];
    var shown = all.filter(function (s) { return state.showHidden || !s.hidden; });
    var hidden = all.filter(function (s) { return s.hidden; }).length;
    var failures = b.failures || [];
    var open = !state.closed.suggestions;
    var when = b.scannedAt ? age(b.scannedAt) : "";
    var scanned = !b.scannedAt ? "never scanned" : when === "now" ? "scanned just now" : "scanned " + (when ? when + " ago" : "");
    var html = '<section class="group" id="g-suggestions"><div class="sghead"><button class="ghead" data-toggle="suggestions">' +
      '<span class="caret">' + (open ? "▾" : "▸") + "</span>Suggested work" +
      '<span class="count">' + all.filter(function (s) { return !s.hidden; }).length + "</span></button>" +
      '<span class="age"' + (b.scannedAt ? ' title="' + esc(b.scannedAt) + '"' : "") + ">" + esc(scanned) + "</span>" +
      (failures.length ? '<span class="age bad">' + failures.length + (failures.length === 1 ? " source failed" : " sources failed") + "</span>" : "") +
      (b.scanningSince
        ? '<span class="age" title="' + esc(b.scanningSince) + '">Scanning since ' + esc(clock(b.scanningSince)) + "</span>"
        : '<button class="btn sm" id="sg-scan"' + (state.busy ? " disabled" : "") + ">Scan</button>") +
      "</div>";
    if (!open) return html + "</section>";
    if (state.sgFlash) html += '<div class="flash ' + (state.sgFlash.ok ? "ok" : "bad") + '">' + esc(state.sgFlash.text) + "</div>";
    if (failures.length) html += '<div class="callout bad"><ul>' + failures.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul></div>";
    if (!all.length) {
      html += '<div class="calm">' + (b.scanningSince
        ? "Scanning your sources. The list appears here when it finishes, usually within a few minutes."
        : b.scannedAt ? "Nothing outstanding in your sources."
        : "Your sources have never been scanned. Scan to see what they are holding.") + "</div>";
    } else if (!shown.length) {
      html += '<div class="calm">Nothing outstanding above the cut-off.</div>';
    } else {
      var sources = {};
      all.forEach(function (s) { sources[s.sourceId] = true; });
      var several = Object.keys(sources).length > 1;
      html += '<div class="rows">' + shown.map(function (s) { return suggestionRow(s, several); }).join("") + "</div>";
    }
    if (hidden) {
      html += '<button class="ghost toggle-hidden" id="sg-hidden">' + (state.showHidden ? "Hide " : "Show ") + hidden + " hidden</button>";
    }
    return html + "</section>";
  }

  function suggestionRow(s, several) {
    var key = suggestionKey(s);
    var forming = state.form && state.form.key === key;
    var label = linkable(s.url)
      ? '<a class="ref" href="#" data-url="' + esc(s.url) + '" title="' + esc(s.url) + '">' + esc(s.ref) + "</a>"
      : '<span class="ref"' + (s.url ? ' title="' + esc(s.url) + '"' : "") + ">" + esc(s.ref) + "</span>";
    var facts = [s.rank, s.state, several ? s.sourceLabel : ""].filter(Boolean).join(" · ");
    return '<div class="row sg tone-idle' + (s.hidden ? " hid" : "") + '">' +
      '<span class="what"><span class="title">' + label + '<span class="name" title="' + esc(s.title) + '">' + esc(s.title) + "</span></span>" +
      (facts ? '<span class="need">' + esc(facts) + "</span>" : "") + "</span>" +
      '<span class="meta">' + (forming ? "" : '<button class="btn sm" data-start="' + esc(key) + '"' + (state.busy ? " disabled" : "") + ">Start task</button>") +
      "</span></div>" + (forming ? startForm() : "");
  }

  function startForm() {
    var f = state.form, o = state.options;
    if (!o) return '<div class="sgform"><div class="hint">Loading the options for a new task…</div></div>';
    function choices(list, chosen) {
      return list.map(function (v) { return '<option value="' + esc(v) + '"' + (v === chosen ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("");
    }
    var route = o.routes.filter(function (r) { return r.id === f.route; })[0];
    var off = state.busy ? " disabled" : "";
    return '<div class="sgform">' +
      '<label class="f">Name<input type="text" id="sg-name" value="' + esc(f.name) + '"' + off + "></label>" +
      '<div class="pair"><label class="f">Branch type<select id="sg-prefix"' + off + ">" + choices(o.branchPrefixes, f.prefix) + "</select></label>" +
      '<label class="f">Base branch<select id="sg-base"' + off + ">" + choices(o.baseBranches, f.base) + "</select></label></div>" +
      '<label class="f">Route<select id="sg-route"' + off + ">" +
      o.routes.map(function (r) {
        return '<option value="' + esc(r.id) + '"' + (r.id === f.route ? " selected" : "") + ">" + esc(r.label) + " · " + r.stageCount + " stages</option>";
      }).join("") +
      '<option value=""' + (route ? "" : " selected") + ">Chat task — no route</option></select></label>" +
      (route && route.description ? '<div class="hint">' + esc(route.description) + "</div>" : "") +
      (route && o.usingBuiltInRoutes ? '<div class="hint">This project declares no routes, so these are the built-in ones.</div>' : "") +
      (route ? '<label class="tick"><input type="checkbox" id="sg-assess"' + (f.assess ? " checked" : "") + off + ">Some of this work already exists (assess first)</label>" : "") +
      '<label class="f">Brief<textarea id="sg-brief"' + off + ">" + esc(f.brief) + "</textarea></label>" +
      '<div class="actions"><button class="btn primary" id="sg-create"' + off + ">" + (state.busy ? "Creating…" : "Create") + "</button>" +
      '<button class="btn" id="sg-cancel"' + off + ">Cancel</button></div>" +
      (f.error ? '<div class="flash bad">' + esc(f.error) + "</div>" : "") + "</div>";
  }

  function runPane() {
    var summary = summaryOf(state.taskId);
    var run = state.run && state.run.taskId === state.taskId ? state.run : null;
    var next = nextNeeding();
    var remaining = queue().filter(function (r) { return r.taskId !== state.taskId; }).length;
    var html = '<div class="crumbs"><button class="ghost" id="back">' + (wide() ? "✕ Close" : "‹ All tasks") + "</button>" +
      '<span class="spacer"></span>' +
      (next ? '<span class="more">' + remaining + " more need you</span>" +
        '<button class="ghost" id="next" title="' + esc(next.name) + '">Next ›</button>' : "") + "</div>";
    var name = run ? run.name : summary ? summary.name : "";
    html += '<div class="runhead"><h2>' + ref(summary) + "<span>" + esc(name) + "</span></h2>";
    if (!run) return html + '</div><div class="loading">Loading…</div>';
    html += '<div class="sub">' + esc(run.route || "") + " · " + esc(run.branch) + " · " + money(run.costUsd) + " spent" +
      (run.discardedCostUsd ? " (" + money(run.discardedCostUsd) + " discarded)" : "") + "</div>" +
      (run.ticketUrl && linkable(run.ticketUrl)
        ? '<div class="sub"><a class="ref" href="#" data-url="' + esc(run.ticketUrl) + '">' + esc(run.ticketUrl) + "</a></div>"
        : run.ticketUrl ? '<div class="sub">' + esc(run.ticketUrl) + "</div>" : "") +
      (run.description ? '<p class="desc">' + esc(run.description) + "</p>" : "") + "</div>";
    if (run.inFlight) html += '<div class="callout info">A session is running on <b>' + esc(run.inFlight) + "</b>. Decisions wait until it stops.</div>";
    html += '<ol class="route">' + run.stages.map(function (s, i) {
      return '<li><button class="node n-' + s.state + (s.id === state.stageId ? " sel" : "") + '" data-stage="' + esc(s.id) +
        '" title="' + (i + 1) + ". " + esc(s.name) + " — " + esc(s.statusLabel) + '"><span class="g">' + GLYPH[s.state] +
        '</span><span class="lbl">' + esc(s.name) + "</span></button></li>";
    }).join("") + "</ol>";
    var stage = run.stages.filter(function (s) { return s.id === state.stageId; })[0];
    if (stage) html += focusCard(run, stage, summary);
    if (run.deferrals.length) {
      var locked = state.busy || run.inFlight;
      html += '<div class="card"><div class="section-label" style="margin-top:4px">Declined work nobody owns · ' + run.deferrals.length + '</div><ul class="defer">' +
        run.deferrals.map(function (d) {
          var e = state.edit && state.edit.kind === "settle" && state.edit.id === d.id;
          return "<li>" + esc(d.text) + ' <span class="detail">(' + esc(d.raisedBy) + ")</span>" +
            (e
              ? '<div class="editor" style="margin-left:0"><input type="text" id="ed-text" placeholder="Who owns this, or why it needs nobody" value="' + esc(state.edit.text) + '">' +
                '<button class="btn primary" id="ed-save"' + (locked ? " disabled" : "") + '>Settle</button><button class="btn" id="ed-cancel">Cancel</button></div>'
              : ' <button class="linkbtn" data-edit="settle" data-id="' + esc(d.id) + '"' + (locked ? " disabled" : "") + ">Settle…</button>") +
            "</li>";
        }).join("") +
        '</ul><div class="hint">The route holds before shipping until each has an owner.</div></div>';
    }
    html += '<details class="all" id="all"' + (state.allOpen ? " open" : "") + "><summary>All " + run.stages.length +
      ' stages</summary>' + (run.evidenceLine ? '<div class="hint">' + esc(run.evidenceLine) + "</div>" : "") + '<ol class="list">' +
      run.stages.map(function (s) {
        return '<li><button class="n-' + s.state + (s.id === state.stageId ? " sel" : "") + '" data-stage="' + esc(s.id) + '">' +
          '<span class="g">' + GLYPH[s.state] + '</span><span class="nm">' + esc(s.name) + "</span><small>" + esc(s.statusLabel) +
          (s.detail ? " · " + esc(s.detail) : "") + "</small></button></li>";
      }).join("") + "</ol></details>";
    return html + removeCard(run);
  }

  // Removing a task, as VS Code's "Remove worktree" does: the worktree goes, the branch
  // stays. Two steps, because nothing here can undo it, and a dirty worktree is asked
  // about again with the count in front of the person.
  function removeCard(run) {
    if (run.inFlight || run.advancing) return "";
    var e = state.edit && state.edit.kind === "remove" && state.edit.id === run.taskId ? state.edit : null;
    if (!e) {
      return '<div class="remove"><button class="linkbtn" id="rm-open"' + (state.busy ? " disabled" : "") + ">Remove task…</button></div>";
    }
    var off = state.busy ? " disabled" : "";
    var said = e.stage === "dirty"
      ? ["The uncommitted changes are discarded with the worktree.", "Discard changes and remove"]
      : e.stage === "failed"
        ? ["Git would not remove the folder. Stop tracking the task and remove the folder yourself?", "Stop tracking anyway"]
        : ["Removes the worktree at " + run.worktreePath + ". Branch " + run.branch + " is kept.", "Remove"];
    return '<div class="remove card">' +
      (e.flash ? '<div class="flash bad" style="margin:0 0 6px">' + esc(e.flash) + "</div>" : "") +
      '<div class="hint">' + esc(said[0]) + "</div>" +
      '<div class="actions"><button class="btn" id="rm-confirm"' + off + ">" + (state.busy ? "Removing…" : esc(said[1])) + "</button>" +
      '<button class="btn" id="rm-cancel"' + off + ">Cancel</button></div></div>";
  }

  function removeTask(run) {
    var e = state.edit;
    var args = { taskId: run.taskId };
    if (e.stage === "dirty") args.discardChanges = true;
    if (e.stage === "failed") args.untrack = true;
    state.busy = true;
    render();
    call("harness_remove_task", args).then(function (result) {
      var sc = (result && result.structuredContent) || {};
      var text = sc.message || resultText(result);
      if (!result.isError) {
        state.edit = null;
        closeRun();
        state.boardFlash = { ok: true, text: text };
        return;
      }
      state.edit = {
        kind: "remove", id: run.taskId, flash: text,
        stage: sc.kind === "dirty" ? "dirty" : sc.kind === "removalFailed" ? "failed" : e.stage
      };
    }).catch(function (err) {
      state.edit = { kind: "remove", id: run.taskId, stage: e.stage, flash: err.message };
    }).then(function () {
      state.busy = false;
      // The refresh repaints only on a moved revision, and a refusal moves nothing.
      state.lastRevision = null;
      state.lastKey = null;
      return refresh();
    });
  }

  function focusCard(run, s, summary) {
    var a = summary && summary.attention;
    var isAttention = !!(a && a.stageId === s.id && a.need);
    var tone = isAttention ? a.tone : STATE_TONE[s.state];
    var html = '<article class="focus tone-' + tone + '"><div class="kicker">' + esc(isAttention ? KICKER[a.tone] : s.statusLabel) +
      (isAttention && a.since ? " · " + age(a.since) : "") + "</div><h3>" + esc(s.name) + "</h3>";
    if (isAttention) html += '<p class="askline">' + esc(a.need) + "</p>";
    else if (s.detail) html += '<p class="detail">' + esc(s.detail) + "</p>";

    var facts = [];
    if (s.state !== "pending") {
      facts.push(s.evidence.selfReported
        ? '<span class="pill warn" title="' + esc(s.evidence.summary) + '">Self-reported</span>'
        : '<span class="pill ok" title="' + esc(s.evidence.summary) + '">' + esc(s.evidence.summary) + "</span>");
    }
    if (s.verification) facts.push("check exit " + s.verification.exitCode + " · <code>" + esc(s.verification.command) + "</code>");
    if (s.costUsd || s.elapsedMs) facts.push(money(s.costUsd) + " · " + minutes(s.elapsedMs));
    facts.push(esc(s.modelsRun.length ? s.modelsRun.join(", ") : s.model || "default model"));
    html += '<div class="facts">' + facts.map(function (f) { return "<span>" + f + "</span>"; }).join("") + "</div>";

    if (s.held) html += '<div class="callout warn"><b>Held:</b> ' + esc(s.held) + "</div>";
    if (s.failure) html += '<div class="callout bad"><b>Failed:</b> ' + esc(s.failure.split("\n")[0]) + "</div>";
    if (run.question && run.question.items.length && run.question.stageName === s.name) {
      html += '<div class="callout warn"><b>' + esc(run.question.stageName) + "</b> is asking" + (run.question.live ? " (waiting now)" : "") +
        ":<ul>" + run.question.items.map(function (q) { return "<li>" + esc(q) + "</li>"; }).join("") + "</ul>Answer it in the harness pane or VS Code.</div>";
    }
    var held = (run.heldCalls || []).filter(function (c) { return !c.decided; });
    if (held.length && run.inFlight === s.name) {
      html += '<div class="callout warn"><b>' + esc(s.name) + "</b> is waiting for permission:<ul>" +
        held.map(function (c) { return "<li><code>" + esc(c.tool) + "</code> " + esc(c.detail) + "</li>"; }).join("") +
        "</ul>Allow or deny it in the harness pane.</div>";
    }

    if (s.checklist.length) {
      var open = s.checklist.filter(function (c) { return !c.checked; }).length;
      html += '<div class="section-label">' + (s.kind === "humanVerification" ? "Verify" : "Steps for you") + " · " +
        (open ? open + " of " + s.checklist.length + " open" : "all " + s.checklist.length + " done") + '</div><ul class="checks">' +
        s.checklist.map(function (c) {
          return '<li><label class="' + (c.checked ? "ticked" : "") + '"><input type="checkbox" data-item="' + esc(c.id) + '"' +
            (c.checked ? " checked" : "") + (state.busy || run.inFlight ? " disabled" : "") + "><span>" + esc(c.text) +
            (c.checkedBy === "check" ? "<small>ticked by check " + esc(c.coveredBy || "") + "</small>" :
              c.coveredBy ? "<small>covered by " + esc(c.coveredBy) + "</small>" :
              !c.checked && !c.holding ? "<small>not holding this gate</small>" : "") +
            (c.note ? "<small>" + esc(c.note) + "</small>" : "") + "</span></label>" + itemTools(run, s, c) + "</li>";
        }).join("") + "</ul>";
    }

    var buttons = "";
    if (!s.canApprove) state.confirming = false;
    if (s.canApprove) {
      buttons += state.confirming
        ? '<input type="text" id="note" placeholder="Anything later stages should know? (optional)" value="' + esc(state.note) + '">' +
          '<button class="btn primary" id="confirm"' + (state.busy ? " disabled" : "") + ">Confirm approval</button>" +
          '<button class="btn" id="cancel">Cancel</button>'
        : '<button class="btn primary" id="approve"' + (state.busy ? " disabled" : "") + ">Approve…</button>";
    }
    if (s.canRetry) buttons += '<button class="btn" id="retry"' + (state.busy ? " disabled" : "") + ">Retry stage</button>";
    if (s.state !== "pending") buttons += '<button class="btn" id="report">Full report</button>';
    if (buttons) html += '<div class="actions">' + buttons + "</div>";
    if (state.confirming && state.movedWhileDeciding) {
      html += '<div class="flash bad">This run changed while you were writing. Confirming checks it against what you saw when you pressed Approve, so a change that matters is refused, not approved over.</div>';
    }
    if (s.actionNote) html += '<div class="hint">' + esc(s.actionNote) + "</div>";
    if (state.flash) html += '<div class="flash ' + (state.flash.ok ? "ok" : "bad") + '">' + esc(state.flash.text) + "</div>";

    // What the stage said is what a person reads before deciding, so it is open on a
    // stage waiting for a decision and folded elsewhere.
    var deciding = s.state === "awaiting" || s.state === "held" || s.state === "failed";
    if (state.report && state.report.stageId === s.id) {
      html += '<details class="reply" open><summary>Full report</summary><pre>' + esc(state.report.text) + "</pre></details>";
    } else if (s.excerpt) {
      html += '<details class="reply"' + (deciding ? " open" : "") + "><summary>What the stage reported</summary><pre>" + esc(s.excerpt) + "</pre></details>";
    }
    return html + "</article>";
  }

  // Note, withdraw and attach-a-check for one item, or the editor for whichever is open.
  // Withdrawing is offered only on an open verification item: a ticked one has evidence
  // somebody looked, and a step for the operator is theirs to do, not to withdraw.
  function itemTools(run, s, c) {
    var locked = state.busy || run.inFlight;
    var e = state.edit && state.edit.id === c.id && state.edit.kind !== "settle" ? state.edit : null;
    if (e) {
      var field = e.kind === "cover"
        ? '<select id="ed-check">' + (s.checks || []).map(function (k) {
            return '<option value="' + esc(k.id) + '"' + (k.id === e.checkId ? " selected" : "") + ">" + esc(k.id) + (k.passed ? " — passed" : " — failed") + "</option>";
          }).join("") + '<option value=""' + (e.checkId === "" ? " selected" : "") + ">Nothing checks this (a gap)</option></select>"
        : '<input type="text" id="ed-text" value="' + esc(e.text) + '" placeholder="' +
          (e.kind === "retire" ? "Why nothing can answer this — kept on the report" : "What you saw (empty clears it)") + '">';
      return '<div class="editor">' + field + '<button class="btn primary" id="ed-save"' + (locked ? " disabled" : "") + ">" +
        (e.kind === "retire" ? "Withdraw" : "Save") + '</button><button class="btn" id="ed-cancel">Cancel</button></div>';
    }
    var off = locked ? " disabled" : "";
    var tools = '<button class="linkbtn" data-edit="note" data-id="' + esc(c.id) + '"' + off + ">" + (c.note ? "Edit note" : "Note") + "</button>";
    var verify = c.kind === "verify" && s.kind === "humanVerification";
    if (verify && (s.checks || c.coveredBy)) {
      tools += '<button class="linkbtn" data-edit="cover" data-id="' + esc(c.id) + '"' + off + ">" + (c.coveredBy ? "Change check" : "Attach check") + "</button>";
    }
    if (verify && !c.checked) tools += '<button class="linkbtn" data-edit="retire" data-id="' + esc(c.id) + '"' + off + ">Withdraw…</button>";
    return '<div class="itemacts">' + tools + "</div>";
  }

  function footer() {
    return '<div class="foot">' +
      (state.canCall ? "Live — updates every " + POLL_MS / 1000 + "s." : "Live refresh unavailable in this host; ask again to update.") +
      " Stop, re-run, correct, send back and answering questions stay in VS Code.</div>";
  }

  // --- wiring -------------------------------------------------------------------
  function each(selector, fn) { Array.prototype.forEach.call(document.querySelectorAll(selector), fn); }

  function wire() {
    each("[data-task]", function (el) { el.onclick = function () { openRun(el.getAttribute("data-task")); }; });
    each("[data-toggle]", function (el) {
      el.onclick = function () { var g = el.getAttribute("data-toggle"); state.closed[g] = !state.closed[g]; render(); };
    });
    each("[data-jump]", function (el) {
      el.onclick = function () {
        var g = el.getAttribute("data-jump");
        state.closed[g] = false;
        if (!wide()) state.view = "board";
        render();
        var target = $("g-" + g);
        if (target) window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 8);
      };
    });
    each("[data-stage]", function (el) {
      el.onclick = function () {
        state.stageId = el.getAttribute("data-stage"); state.flash = null; state.confirming = false; state.edit = null; render();
      };
    });
    var mode = $("mode");
    if (mode) mode.onclick = function () {
      var target = state.displayMode === "fullscreen" ? "inline" : "fullscreen";
      request("ui/request-display-mode", { mode: target }).then(function (r) {
        state.displayMode = (r && r.mode) || target; render();
      }).catch(function () { /* the host said no; nothing to change */ });
    };
    var back = $("back");
    if (back) back.onclick = closeRun;
    var next = $("next");
    if (next) next.onclick = function () { var n = nextNeeding(); if (n) openRun(n.taskId); };
    var all = $("all");
    if (all) all.ontoggle = function () { state.allOpen = all.open; };
    wireSuggestions();

    var run = state.run;
    if (state.view !== "run" || !run || run.taskId !== state.taskId) return;
    var s = run.stages.filter(function (x) { return x.id === state.stageId; })[0];
    each("[data-item]", function (box) {
      box.onchange = function () {
        act("harness_set_checklist_item", { taskId: run.taskId, itemId: box.getAttribute("data-item"), checked: box.checked });
      };
    });
    wireEditor(run, s);
    var rmOpen = $("rm-open");
    if (rmOpen) rmOpen.onclick = function () { state.edit = { kind: "remove", id: run.taskId, stage: "confirm" }; render(); };
    var rmCancel = $("rm-cancel");
    if (rmCancel) rmCancel.onclick = function () { state.edit = null; render(); };
    var rmConfirm = $("rm-confirm");
    if (rmConfirm) rmConfirm.onclick = function () { removeTask(run); };
    if (!s) return;
    var approve = $("approve");
    if (approve) approve.onclick = function () {
      state.confirming = true;
      state.decisionRevision = run.revision;
      state.movedWhileDeciding = false;
      state.note = "";
      state.flash = null;
      render();
      var n = $("note"); if (n) n.focus();
    };
    var noteBox = $("note");
    if (noteBox) {
      noteBox.oninput = function () { state.note = noteBox.value; };
      noteBox.onkeydown = function (e) { if (e.key === "Enter") { var c = $("confirm"); if (c && !c.disabled) c.click(); } };
    }
    var cancel = $("cancel");
    if (cancel) cancel.onclick = function () { state.confirming = false; state.note = ""; state.movedWhileDeciding = false; render(); };
    var confirm = $("confirm");
    if (confirm) confirm.onclick = function () {
      act(
        "harness_approve_stage",
        { taskId: run.taskId, stageId: s.id, revision: state.decisionRevision || run.revision, note: state.note || "" },
        function (sc) { return sc.kind === "stale"; }
      );
    };
    var retry = $("retry");
    if (retry) retry.onclick = function () {
      act("harness_retry_stage", { taskId: run.taskId, stageId: s.id, revision: run.revision });
    };
    var report = $("report");
    if (report) report.onclick = function () {
      report.disabled = true;
      call("harness_get_stage_report", { taskId: run.taskId, stageId: s.id }).then(function (result) {
        var text = (result && result.content && result.content[0] && result.content[0].text) || "(empty)";
        state.report = { stageId: s.id, text: text };
        render();
      }).catch(function (e) { state.flash = { ok: false, text: e.message }; render(); });
    };
  }

  function wireEditor(run, s) {
    each("[data-edit]", function (el) {
      el.onclick = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        var kind = el.getAttribute("data-edit"), id = el.getAttribute("data-id");
        var item = s && s.checklist.filter(function (c) { return c.id === id; })[0];
        var first = s && s.checks && s.checks[0] ? s.checks[0].id : "";
        state.edit = {
          kind: kind, id: id,
          text: kind === "note" && item ? item.note || "" : "",
          checkId: kind === "cover" ? (item && item.coveredBy) || first : ""
        };
        state.flash = null;
        render();
        var f = $(kind === "cover" ? "ed-check" : "ed-text"); if (f) f.focus();
      };
    });
    var e = state.edit;
    if (!e) return;
    var text = $("ed-text");
    if (text) {
      text.oninput = function () { e.text = text.value; };
      text.onkeydown = function (k) {
        if (k.key === "Enter") { var b = $("ed-save"); if (b && !b.disabled) b.click(); }
        else if (k.key === "Escape") { state.edit = null; render(); }
      };
    }
    var pick = $("ed-check");
    if (pick) pick.onchange = function () { e.checkId = pick.value; };
    var cancel = $("ed-cancel");
    if (cancel) cancel.onclick = function () { state.edit = null; render(); };
    var save = $("ed-save");
    if (save) save.onclick = function () {
      if (e.kind === "settle") act("harness_settle_deferral", { taskId: run.taskId, itemId: e.id, resolution: e.text });
      else if (e.kind === "retire") act("harness_retire_checklist_item", { taskId: run.taskId, itemId: e.id, reason: e.text });
      else if (e.kind === "note") act("harness_note_checklist_item", { taskId: run.taskId, itemId: e.id, note: e.text });
      else {
        var args = { taskId: run.taskId, itemId: e.id };
        if (e.checkId) args.checkId = e.checkId;
        act("harness_cover_checklist_item", args);
      }
    };
  }

  function wireSuggestions() {
    var scanButton = $("sg-scan");
    if (scanButton) scanButton.onclick = scan;
    var toggle = $("sg-hidden");
    if (toggle) toggle.onclick = function () { state.showHidden = !state.showHidden; render(); };
    each("[data-start]", function (el) { el.onclick = function () { openStartForm(el.getAttribute("data-start")); }; });
    each("[data-url]", function (el) {
      el.onclick = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        request("ui/open-link", { url: el.getAttribute("data-url") }).then(function (r) {
          if (r && r.isError) throw new Error("The host would not open " + el.getAttribute("data-url") + ".");
        }).catch(function (err) { state.sgFlash = { ok: false, text: err.message }; render(); });
      };
    });
    var f = state.form;
    if (!f) return;
    // Typing only updates view state; a re-render is needed only where the form's shape
    // changes, which is choosing between a route and a chat task.
    function bind(id, field, event, reshape) {
      var el = $(id);
      if (!el) return;
      el[event] = function () { f[field] = el.type === "checkbox" ? el.checked : el.value; if (reshape) render(); };
    }
    bind("sg-name", "name", "oninput");
    bind("sg-brief", "brief", "oninput");
    bind("sg-prefix", "prefix", "onchange");
    bind("sg-base", "base", "onchange");
    bind("sg-route", "route", "onchange", true);
    bind("sg-assess", "assess", "onchange");
    var name = $("sg-name");
    if (name) name.onkeydown = function (e) { if (e.key === "Enter") createTask(); };
    var create = $("sg-create");
    if (create) create.onclick = createTask;
    var cancel = $("sg-cancel");
    if (cancel) cancel.onclick = function () { state.form = null; render(); };
  }

  // Escape goes back to the board and "n" to the next task needing you, unless typing.
  document.onkeydown = function (e) {
    var t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
    if (e.key === "Escape" && state.view === "run") closeRun();
    else if ((e.key === "n" || e.key === "j") && state.view === "run") { var n = nextNeeding(); if (n) openRun(n.taskId); }
  };
  var resizeTimer = null;
  window.onresize = function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { state.lastKey = null; paint(); }, 120);
  };

  // --- lifecycle ------------------------------------------------------------
  if (window.parent === window) {
    $("root").innerHTML = '<div class="empty">This page is an MCP App: open it from Claude with the harness_dashboard tool.</div>';
    return;
  }

  // appInfo, not clientInfo: the spec names it so, and a host validating the
  // request rejects the other spelling, leaving the view never initialised and
  // never shown — Claude's panel sat at "Rendering widget" on exactly that.
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    appInfo: { name: "task-workspaces-harness-dashboard", version: "0.2.0" }
  }).then(function (result) {
    applyContext(result && result.hostContext);
    var caps = (result && result.hostCapabilities) || {};
    if (caps.serverTools === undefined && Object.keys(caps).length > 0) state.canCall = false;
    state.canOpenLinks = !!caps.openLinks;
    notify("ui/notifications/initialized", {});
    // Size is reported only once initialised, as the reference App does: a host may
    // drop a size-changed that arrives before the handshake, and the first
    // observation is the one that sizes the panel.
    new ResizeObserver(function () {
      notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
    }).observe(document.body);
    startPolling();
    // If the tool result does not arrive (some hosts deliver it before the view
    // asks), fetch the board ourselves rather than sit on "Connecting".
    setTimeout(function () { if (!state.runs.length) refresh(); }, 1500);
  }).catch(function (e) {
    $("root").innerHTML = '<div class="empty">Could not connect to the host: ' + esc(e.message) + "</div>";
  });
})();
</script>
</body>
</html>`;
