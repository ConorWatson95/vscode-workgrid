/**
 * Source of the `ask_user` MCP server, written to disk by `AskUserService` and
 * launched by the CLI as a stdio MCP server.
 *
 * Shipped as a string for the same reason as the permission gate script: the
 * extension bundles to a single `dist/extension.js`, so a sibling `.js` would
 * have to be added to the vsix and kept in step by hand.
 *
 * Constraints that cost something if broken:
 *
 * - **Never write anything but JSON-RPC to stdout.** A stray log line is framed
 *   as a protocol message and the CLI drops the server, so the tool silently
 *   vanishes. Diagnostics go to stderr, which the CLI captures separately.
 * - **Always answer a `tools/call`.** An unanswered call blocks the agent until
 *   the MCP tool timeout with nothing to show for it, so every failure path
 *   returns a result telling the agent to carry on.
 * - **Never throw.** An uncaught error kills the server mid-turn, which the agent
 *   sees as the whole toolset disappearing.
 *
 * Plain CommonJS on purpose: it runs under whatever node the machine has, not
 * under the bundler's target.
 */
export const ASK_USER_SERVER_SCRIPT = String.raw`"use strict";
// Written by the Task Workspaces extension. Exposes one tool, ask_user, which
// blocks until the extension supplies an answer. Editing this file has no lasting
// effect: it is rewritten whenever the extension starts a stage.
var fs = require("fs");
var path = require("path");

var inbox = process.argv[2];
var POLL_MS = 300;

var ABANDONED =
  "Nobody is available to answer. Proceed using your best judgement, and state " +
  "clearly in your reply which assumptions you had to make.";

function note(message) {
  // stderr only. Anything on stdout is parsed as a protocol frame.
  try {
    process.stderr.write("[ask_user] " + message + "\n");
  } catch (e) {
    /* nothing useful to do */
  }
}

function send(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch (e) {
    note("could not write response: " + e);
  }
}

function result(id, text) {
  send({
    jsonrpc: "2.0",
    id: id,
    result: { content: [{ type: "text", text: text }] },
  });
}

var TOOL = {
  name: "ask_user",
  description:
    "Ask the human operator one or more questions and wait for their answers. " +
    "Use this whenever you need information you cannot determine from the " +
    "repository, the task brief or the project's documentation — for example a " +
    "business rule, which environment to target, or which of several plausible " +
    "readings of the request is intended. Prefer asking over guessing. The call " +
    "blocks until the operator answers, and you keep everything you have worked " +
    "out so far, so asking is cheap. Ask every question you have in one call.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: { type: "string" },
        description:
          "One self-contained question per entry. Each must be answerable on " +
          "its own, without reference to the others.",
      },
      context: {
        type: "string",
        description:
          "Optional: why you are asking, and what you will do with the answer.",
      },
    },
    required: ["questions"],
  },
};

function handleCall(request) {
  var id = request.id;
  var args = (request.params && request.params.arguments) || {};
  var questions = Array.isArray(args.questions) ? args.questions : [];
  questions = questions.filter(function (q) {
    return typeof q === "string" && q.trim().length > 0;
  });

  if (questions.length === 0) {
    return result(
      id,
      "No questions were supplied, so there is nothing to ask. Continue, or " +
        "call ask_user again with at least one question.",
    );
  }
  if (!inbox || !fs.existsSync(inbox)) {
    note("no inbox; telling the agent to proceed");
    return result(id, ABANDONED);
  }

  var callId =
    String(process.pid) +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.floor(Math.random() * 1e6).toString(36);
  var requestPath = path.join(inbox, callId + ".ask.json");
  var answerPath = path.join(inbox, callId + ".answers.json");

  try {
    // Temp name then rename, so the extension's watcher never reads a partial file.
    var temp = requestPath + ".partial";
    fs.writeFileSync(
      temp,
      JSON.stringify({ questions: questions, context: args.context }),
      "utf8",
    );
    fs.renameSync(temp, requestPath);
  } catch (e) {
    note("could not park the question: " + e);
    return result(id, ABANDONED);
  }

  var timer = setInterval(function () {
    var answer;
    try {
      if (!fs.existsSync(answerPath)) {
        // The extension removes the inbox when it stops listening.
        if (!fs.existsSync(inbox)) {
          clearInterval(timer);
          note("inbox went away while waiting");
          result(id, ABANDONED);
        }
        return;
      }
      answer = JSON.parse(fs.readFileSync(answerPath, "utf8"));
    } catch (e) {
      return; // Half-written; try again next tick.
    }
    clearInterval(timer);
    try {
      fs.unlinkSync(answerPath);
      fs.unlinkSync(requestPath);
    } catch (e) {
      /* tidiness only */
    }

    if (!answer || answer.abandoned) return result(id, ABANDONED);

    var answers = Array.isArray(answer.answers) ? answer.answers : [];
    var lines = questions.map(function (question, index) {
      var given = answers[index];
      return (
        "Q: " +
        question +
        "\nA: " +
        (typeof given === "string" && given.trim() ? given.trim() : "(no answer given)")
      );
    });
    result(id, "The operator answered:\n\n" + lines.join("\n\n"));
  }, POLL_MS);
}

function handle(line) {
  var request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    return;
  }

  try {
    if (request.method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "taskworkspaces", version: "1.0.0" },
        },
      });
    }
    if (request.method === "tools/list") {
      return send({ jsonrpc: "2.0", id: request.id, result: { tools: [TOOL] } });
    }
    if (request.method === "tools/call") {
      if (request.params && request.params.name === "ask_user") {
        return handleCall(request);
      }
      return send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: "unknown tool " + (request.params && request.params.name),
        },
      });
    }
    // Notifications carry no id and expect no reply; anything else with an id
    // gets an empty success so the client is never left waiting.
    if (request.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  } catch (e) {
    note("handler failed: " + e);
    if (request && request.id !== undefined) result(request.id, ABANDONED);
  }
}

var buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  buffer += chunk;
  var index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    var line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
  }
});
process.stdin.on("error", function () {
  process.exit(0);
});
process.on("uncaughtException", function (e) {
  note("uncaught: " + e);
});
`;
