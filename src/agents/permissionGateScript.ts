/**
 * Source of the `PreToolUse` hook script, written to disk by
 * `PermissionGateService` and launched by the CLI once per gated tool call.
 *
 * Shipped as a string rather than a file because the extension is bundled to a
 * single `dist/extension.js`; a sibling `.js` would have to be added to the vsix
 * and kept in step by hand.
 *
 * Design constraints, all of which cost something if broken:
 *
 * - **Silence means pass.** Emitting no stdout leaves the CLI's own classifier in
 *   charge, so a gate that cannot reach the extension degrades to today's
 *   behaviour instead of blocking or granting.
 * - **Never throw.** An unhandled error here surfaces as a hook failure on a
 *   stage that had nothing wrong with it, so everything is wrapped and every
 *   failure path exits 0 silently.
 * - **Exit fast when nobody is listening.** The extension deletes its inbox when
 *   it stops watching; the script treats a missing inbox as "pass" so a stale
 *   settings file can never wedge a run.
 *
 * Plain ES5-ish CommonJS on purpose: it runs under whatever node the machine has,
 * not under the bundler's target.
 */
export const PERMISSION_GATE_SCRIPT = `"use strict";
// Written by the Task Workspaces extension. Blocks a tool call until the
// extension answers, then tells the CLI what to do. Editing this file has no
// lasting effect: it is rewritten whenever the extension starts a stage.
var fs = require("fs");
var path = require("path");

var inbox = process.argv[2];
var POLL_MS = 200;

function pass() {
  // No output: the CLI's own permission layer decides, exactly as if this hook
  // were not installed.
  process.exit(0);
}

function respond(decision, reason) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason: reason || "Decided in Task Workspaces.",
        },
      }) + "\\n",
    );
  } catch (e) {
    /* falls through to exit 0, i.e. pass */
  }
  process.exit(0);
}

function readPayload(done) {
  var chunks = "";
  var settled = false;
  function finish() {
    if (settled) return;
    settled = true;
    done(chunks);
  }
  try {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (c) {
      chunks += c;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    // A hook whose stdin never closes must not hang the agent forever.
    setTimeout(finish, 5000);
  } catch (e) {
    finish();
  }
}

function main(payload) {
  if (!inbox || !fs.existsSync(inbox)) return pass();

  // Unique per call: pid plus a monotonic-enough suffix. The extension routes its
  // answer back by this name.
  var id =
    String(process.pid) +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.floor(Math.random() * 1e6).toString(36);
  var requestPath = path.join(inbox, id + ".request.json");
  var decisionPath = path.join(inbox, id + ".decision.json");

  try {
    // Written to a temp name and renamed, so the extension's watcher never reads
    // a half-written request.
    var temp = requestPath + ".partial";
    fs.writeFileSync(temp, payload, "utf8");
    fs.renameSync(temp, requestPath);
  } catch (e) {
    return pass();
  }

  var waited = 0;
  var timer = setInterval(function () {
    waited += POLL_MS;
    var answer;
    try {
      if (!fs.existsSync(decisionPath)) {
        // The extension has gone away; stop holding the agent up.
        if (!fs.existsSync(inbox)) {
          clearInterval(timer);
          return pass();
        }
        return;
      }
      answer = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
    } catch (e) {
      return; // Half-written answer; try again on the next tick.
    }
    clearInterval(timer);
    try {
      fs.unlinkSync(decisionPath);
      fs.unlinkSync(requestPath);
    } catch (e) {
      /* tidiness only */
    }
    if (!answer || answer.decision === "pass") return pass();
    return respond(answer.decision, answer.reason);
  }, POLL_MS);

  // Nothing here enforces an upper bound: the CLI's own hook timeout does, and
  // duplicating it would only make the two disagree.
  void waited;
}

try {
  readPayload(main);
} catch (e) {
  pass();
}
`;
