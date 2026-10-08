/**
 * The Engineering Harness dashboard, served as an MCP App (`ui://` resource).
 *
 * Shipped as a string, like the gate hook and the `ask_user` server: one artefact,
 * no build step of its own, nothing fetched at runtime — so the host's default
 * content-security policy (no network) is exactly right.
 *
 * A **view**, and nothing more. It holds which run and stage are selected and what
 * is typed into the note box; every fact on screen comes from a tool result, and
 * every button is a `tools/call` to an app-only tool that runs the engine's own
 * transition. It refreshes by polling `harness_refresh`, so a change made in VS Code
 * appears here within one interval, and re-renders only when the run's revision
 * moves.
 *
 * A re-render must not cost the operator what they are typing. It did: a tick made in
 * VS Code while the approval note was open re-rendered the panel and discarded the
 * note. So the note lives in view state, the composer survives a refresh with a line
 * saying the run moved, and the approval is checked against the revision the operator
 * was looking at when they pressed Approve. A change underneath is then refused as
 * stale rather than approved over, and the refusal keeps the note and re-arms against
 * what is now on screen — confirming again is a decision about the current run.
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
    --bg2: var(--color-background-secondary, light-dark(#f5f4ef, #2a2a28));
    --fg: var(--color-text-primary, light-dark(#1f1e1d, #f0eee6));
    --muted: var(--color-text-secondary, light-dark(#6b6a66, #a8a69e));
    --line: var(--color-border-primary, light-dark(#e3e1d9, #3a3a37));
    --ok: light-dark(#2f7d32, #6cc070);
    --run: light-dark(#1f5fbf, #6fa2f0);
    --warn: light-dark(#a15c00, #e3a446);
    --bad: light-dark(#b3261e, #f0786f);
    --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    --mono: var(--font-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--font); }
  .wrap { padding: 14px 16px 16px; }
  header { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 10px; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; }
  select, input, button { font: inherit; color: inherit; }
  select, input[type=text] { background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
  select { max-width: 100%; }
  .grid { display: grid; grid-template-columns: minmax(200px, 38%) 1fr; gap: 14px; }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  ol.stages { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  ol.stages li { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-top: 1px solid var(--line); cursor: pointer; }
  ol.stages li:first-child { border-top: 0; }
  ol.stages li:hover { background: var(--bg2); }
  ol.stages li.sel { background: var(--bg2); box-shadow: inset 3px 0 0 var(--run); }
  .g { width: 1.2em; text-align: center; font-weight: 700; flex: none; }
  .s-done .g { color: var(--ok); } .s-skipped .g { color: var(--muted); }
  .s-running .g { color: var(--run); } .s-pending .g { color: var(--muted); }
  .s-failed .g { color: var(--bad); } .s-awaiting .g, .s-held .g { color: var(--warn); }
  .nm { flex: 1; min-width: 0; }
  .nm small { display: block; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
  .panel h2 { font-size: 14px; margin: 0 0 2px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 10px; margin: 10px 0; }
  dt { color: var(--muted); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .box { border-radius: 6px; padding: 7px 9px; margin: 8px 0; background: var(--bg2); overflow-wrap: anywhere; }
  .box.warn { border-left: 3px solid var(--warn); } .box.bad { border-left: 3px solid var(--bad); }
  .box.info { border-left: 3px solid var(--run); }
  ul.check { list-style: none; padding: 0; margin: 6px 0; }
  ul.check li { display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; }
  ul.check li.holding span { font-weight: 600; }
  ul.check small { color: var(--muted); display: block; font-weight: 400; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
  .actions input { flex: 1 1 220px; }
  button { border: 1px solid var(--line); background: var(--bg2); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
  button.primary { background: var(--run); border-color: var(--run); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  pre { font: 12px/1.4 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; background: var(--bg2); padding: 8px; border-radius: 6px; margin: 6px 0 0; }
  details summary { cursor: pointer; color: var(--muted); margin-top: 8px; }
  .flash { margin-top: 8px; font-size: 12px; }
  .flash.ok { color: var(--ok); } .flash.bad { color: var(--bad); }
  .foot { margin-top: 10px; color: var(--muted); font-size: 11px; }
  .empty { color: var(--muted); padding: 20px 0; }
</style>
</head>
<body>
<div class="wrap" id="root"><div class="empty">Connecting to the harness…</div></div>
<script>
(function () {
  "use strict";
  var GLYPH = { done: "✓", skipped: "–", running: "●", pending: "○", failed: "!", awaiting: "?", held: "?" };
  var POLL_MS = 3000;

  var state = {
    runs: [], run: null, repositoryRoot: "",
    taskId: null, stageId: null,
    lastRevision: null, flash: null, confirming: false,
    report: null, busy: false, polling: false, canCall: true
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
        if (args.taskId) state.taskId = args.taskId;
        break;
      case "ui/notifications/tool-result":
        accept(msg.params);
        break;
      case "ui/notifications/host-context-changed":
        applyContext(msg.params);
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
  }

  // --- data -----------------------------------------------------------------
  function accept(result) {
    var data = result && result.structuredContent;
    if (!data || !data.runs) return;
    state.runs = data.runs;
    state.repositoryRoot = data.repositoryRoot || state.repositoryRoot;
    var run = data.run || null;
    var moved = !run || !state.run || run.revision !== state.lastRevision || run.taskId !== state.run.taskId;
    state.run = run;
    if (run) {
      state.taskId = run.taskId;
      if (!state.stageId || !run.stages.some(function (s) { return s.id === state.stageId; })) {
        state.stageId = focusStage(run);
      }
    }
    if (moved) {
      state.lastRevision = run ? run.revision : null;
      if (state.confirming) {
        if (state.rearm) {
          state.decisionRevision = run ? run.revision : null;
          state.rearm = false;
        } else {
          state.movedWhileDeciding = true;
        }
      }
      render();
    } else {
      renderRunList();
    }
  }

  function focusStage(run) {
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
    return call("harness_refresh", { taskId: state.taskId || undefined })
      .then(accept)
      .catch(function () { state.canCall = false; renderFooter(); });
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
      state.lastRevision = null; // force a render of whatever is true now
      return refresh();
    });
  }

  // --- rendering ------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) { return n ? "$" + n.toFixed(2) : "$0"; }
  function minutes(ms) { return ms ? Math.round(ms / 60000) + "m" : "0m"; }
  function $(id) { return document.getElementById(id); }

  function render() {
    var root = $("root");
    var run = state.run;
    if (!run) {
      root.innerHTML = '<header><h1>Engineering Harness</h1></header><div class="empty">No routed tasks in ' + esc(state.repositoryRoot || "this repository") + ".</div>" + footer();
      return;
    }
    var stage = run.stages.filter(function (s) { return s.id === state.stageId; })[0];
    var typing = document.activeElement && document.activeElement.id === "note" ? document.activeElement : null;
    var caret = typing ? typing.selectionStart : null;
    root.innerHTML =
      '<header><h1>Engineering Harness</h1><span class="sub" id="runsub"></span></header>' +
      '<div style="margin-bottom:10px"><select id="runpick"></select></div>' +
      (run.inFlight ? '<div class="box info">A session is running on <b>' + esc(run.inFlight) + "</b>.</div>" : "") +
      questionBox(run) + deferralBox(run) +
      '<div class="grid"><ol class="stages" id="stages">' + run.stages.map(stageRow).join("") + "</ol>" +
      '<div class="panel">' + (stage ? stagePanel(run, stage) : "") + "</div></div>" +
      footer();
    renderRunList();
    wire(run, stage);
    var note = $("note");
    if (note && typing) { note.focus(); if (caret !== null) note.setSelectionRange(caret, caret); }
  }

  function renderRunList() {
    var pick = $("runpick");
    if (!pick || !state.run) return;
    pick.innerHTML = state.runs.map(function (r) {
      return '<option value="' + esc(r.taskId) + '"' + (r.taskId === state.run.taskId ? " selected" : "") + ">" +
        esc(r.name) + " — " + esc(r.groupLabel) + (r.currentStage ? " · " + esc(r.currentStage) : "") + "</option>";
    }).join("");
    var sub = $("runsub");
    if (sub) sub.textContent = (state.run.route || "") + " · " + state.run.branch + " · " + money(state.run.costUsd) + " spent" +
      (state.run.discardedCostUsd ? " (" + money(state.run.discardedCostUsd) + " discarded)" : "");
  }

  function renderFooter() { var f = $("foot"); if (f) f.outerHTML = footer(); }
  function footer() {
    return '<div class="foot" id="foot">' +
      (state.canCall ? "Live: re-reads the harness state every " + POLL_MS / 1000 + "s." : "Live refresh unavailable in this host; re-run the dashboard to update.") +
      " Stop, re-run, correct and send-back stay in VS Code.</div>";
  }

  function stageRow(s) {
    return '<li data-stage="' + esc(s.id) + '" class="s-' + s.state + (s.id === state.stageId ? " sel" : "") + '">' +
      '<span class="g">' + GLYPH[s.state] + '</span><span class="nm">' + esc(s.name) +
      "<small>" + esc(s.statusLabel) + (s.detail ? " · " + esc(s.detail) : "") + "</small></span></li>";
  }

  function questionBox(run) {
    if (!run.question || !run.question.items.length) return "";
    return '<div class="box warn"><b>' + esc(run.question.stageName) + "</b> is asking" +
      (run.question.live ? " (waiting now)" : "") + ":<ul>" +
      run.question.items.map(function (q) { return "<li>" + esc(q) + "</li>"; }).join("") +
      "</ul>Answer it in VS Code.</div>";
  }

  function deferralBox(run) {
    if (!run.deferrals.length) return "";
    return '<div class="box warn"><b>' + run.deferrals.length + " declined item(s)</b> nobody owns yet:<ul>" +
      run.deferrals.map(function (d) { return "<li>" + esc(d.text) + ' <span class="sub">(' + esc(d.raisedBy) + ")</span></li>"; }).join("") +
      "</ul></div>";
  }

  function stagePanel(run, s) {
    var rows = [
      ["Status", esc(s.statusLabel) + (s.detail ? " · " + esc(s.detail) : "")],
      ["Kind", esc(s.kind)],
      ["Model", esc(s.model || "default") + (s.modelsRun.length ? " → ran " + esc(s.modelsRun.join(", ")) : "")],
      ["Cost", money(s.costUsd) + " · " + minutes(s.elapsedMs) + " of session"],
      ["Evidence", (s.evidence.selfReported ? "⚠ " : "") + esc(s.evidence.summary)]
    ];
    if (s.verification) rows.push(["Check", "exit " + s.verification.exitCode + " · <code>" + esc(s.verification.command) + "</code>"]);
    if (s.subtasks.length > 1) rows.push(["Subtasks", s.subtasks.map(function (t) { return esc(t.status); }).join(", ")]);

    var html = "<h2>" + esc(s.name) + "</h2><dl>" + rows.map(function (r) { return "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>"; }).join("") + "</dl>";
    if (s.held) html += '<div class="box warn"><b>Held:</b> ' + esc(s.held) + "</div>";
    if (s.failure) html += '<div class="box bad"><b>Failed:</b> ' + esc(s.failure.split("\n")[0]) + "</div>";

    if (s.checklist.length) {
      html += "<div><b>" + (s.kind === "humanVerification" ? "Human verification" : "Steps for you") + "</b>" +
        '<ul class="check">' + s.checklist.map(function (c) {
          return '<li class="' + (c.holding ? "holding" : "") + '"><input type="checkbox" data-item="' + esc(c.id) + '"' +
            (c.checked ? " checked" : "") + (state.busy || run.inFlight ? " disabled" : "") + "><span>" + esc(c.text) +
            (c.checkedBy === "check" ? "<small>ticked by check " + esc(c.coveredBy || "") + "</small>" :
              c.coveredBy ? "<small>covered by " + esc(c.coveredBy) + "</small>" :
              !c.checked && !c.holding ? "<small>not holding this gate</small>" : "") +
            (c.note ? "<small>" + esc(c.note) + "</small>" : "") + "</span></li>";
        }).join("") + "</ul></div>";
    }

    var buttons = "";
    if (!s.canApprove) state.confirming = false;
    if (s.canApprove) {
      buttons += state.confirming
        ? '<input type="text" id="note" placeholder="Anything later stages should know? (optional)" value="' + esc(state.note) + '">' +
          '<button class="primary" id="confirm"' + (state.busy ? " disabled" : "") + ">Confirm approval</button>" +
          '<button id="cancel">Cancel</button>'
        : '<button class="primary" id="approve"' + (state.busy ? " disabled" : "") + ">Approve…</button>";
    }
    if (s.canRetry) buttons += '<button id="retry"' + (state.busy ? " disabled" : "") + ">Retry stage</button>";
    buttons += '<button id="report">Full report</button>';
    html += '<div class="actions">' + buttons + "</div>";
    if (state.confirming && state.movedWhileDeciding) {
      html += '<div class="flash bad">This run changed while you were writing. Confirming checks it against what you saw when you pressed Approve, so a change that matters is refused, not approved over.</div>';
    }
    if (s.actionNote) html += '<div class="flash">' + esc(s.actionNote) + "</div>";
    if (state.flash) html += '<div class="flash ' + (state.flash.ok ? "ok" : "bad") + '">' + esc(state.flash.text) + "</div>";

    if (state.report && state.report.stageId === s.id) {
      html += "<details open><summary>Full report</summary><pre>" + esc(state.report.text) + "</pre></details>";
    } else if (s.excerpt) {
      html += "<details><summary>Last reply</summary><pre>" + esc(s.excerpt) + "</pre></details>";
    }
    return html;
  }

  function wire(run, s) {
    var pick = $("runpick");
    if (pick) pick.onchange = function () {
      state.taskId = pick.value; state.stageId = null; state.flash = null; state.report = null; state.lastRevision = null;
      refresh();
    };
    Array.prototype.forEach.call(document.querySelectorAll("[data-stage]"), function (li) {
      li.onclick = function () {
        state.stageId = li.getAttribute("data-stage"); state.flash = null; state.confirming = false; render();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-item]"), function (box) {
      box.onchange = function () {
        act("harness_set_checklist_item", { taskId: run.taskId, itemId: box.getAttribute("data-item"), checked: box.checked });
      };
    });
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
    if (noteBox) noteBox.oninput = function () { state.note = noteBox.value; };
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

  // --- lifecycle ------------------------------------------------------------
  if (window.parent === window) {
    $("root").innerHTML = '<div class="empty">This page is an MCP App: open it from Claude with the harness_dashboard tool.</div>';
    return;
  }

  new ResizeObserver(function () {
    notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }).observe(document.body);

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    clientInfo: { name: "task-workspaces-harness-dashboard", version: "0.1.0" }
  }).then(function (result) {
    applyContext(result && result.hostContext);
    var caps = (result && result.hostCapabilities) || {};
    if (caps.serverTools === undefined && Object.keys(caps).length > 0) state.canCall = false;
    notify("ui/notifications/initialized", {});
    startPolling();
    // If the tool result does not arrive (some hosts deliver it before the view
    // asks), fetch the snapshot ourselves rather than sit on "Connecting".
    setTimeout(function () { if (!state.run) refresh(); }, 1500);
  }).catch(function (e) {
    $("root").innerHTML = '<div class="empty">Could not connect to the host: ' + esc(e.message) + "</div>";
  });
})();
</script>
</body>
</html>`;
