import { describe, expect, it } from "vitest";
import {
  buildGateSettings,
  describeGateRequest,
  gateCallKey,
  denialCallKey,
  gateHookOutput,
  parseGateRequest,
} from "./permissionGateProtocol";

const payload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "s1",
    cwd: "C:/Dev/worktrees/x",
    permission_mode: "acceptEdits",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "mkdir -p out", description: "make out" },
    ...overrides,
  });

describe("parseGateRequest", () => {
  it("reads the fields the UI and rule suggestion need", () => {
    const request = parseGateRequest("r1", payload())!;
    expect(request).toMatchObject({
      id: "r1",
      sessionId: "s1",
      toolName: "Bash",
      cwd: "C:/Dev/worktrees/x",
      permissionMode: "acceptEdits",
    });
    expect(request.toolInput.command).toBe("mkdir -p out");
  });

  it("returns undefined for unparseable input rather than throwing", () => {
    // A wedged stage is far worse than an ungated call.
    expect(parseGateRequest("r1", "not json")).toBeUndefined();
    expect(parseGateRequest("r1", "null")).toBeUndefined();
  });

  it("requires a tool name, since nothing can be shown or matched without one", () => {
    expect(parseGateRequest("r1", payload({ tool_name: "" }))).toBeUndefined();
    expect(parseGateRequest("r1", payload({ tool_name: 42 }))).toBeUndefined();
  });

  it("tolerates a missing tool input", () => {
    const request = parseGateRequest("r1", payload({ tool_input: undefined }))!;
    expect(request.toolInput).toEqual({});
  });
});

describe("describeGateRequest", () => {
  it("prefers a command for command tools", () => {
    const request = parseGateRequest("r1", payload())!;
    expect(describeGateRequest(request)).toBe("mkdir -p out");
  });

  it("uses the path for file tools", () => {
    const request = parseGateRequest(
      "r1",
      payload({ tool_name: "Write", tool_input: { file_path: "C:/Temp/q.ps1" } }),
    )!;
    expect(describeGateRequest(request)).toBe("C:/Temp/q.ps1");
  });

  it("falls back to the tool name when there is nothing to show", () => {
    const request = parseGateRequest(
      "r1",
      payload({ tool_name: "Odd", tool_input: {} }),
    )!;
    expect(describeGateRequest(request)).toBe("Odd");
  });
});

describe("gateCallKey", () => {
  it("groups a refused command with its rewordings", () => {
    // The observed failure mode: five variants of one script invocation. Asking
    // the user five times for one capability is the thing to avoid.
    const a = parseGateRequest("1", payload({ tool_input: { command: "pwsh -File Get-JiraAttachment.ps1 -Id 1" } }))!;
    const b = parseGateRequest("2", payload({ tool_input: { command: "pwsh -NoProfile -File Get-JiraAttachment.ps1 -Id 2" } }))!;
    expect(gateCallKey(a)).toBe(gateCallKey(b));
  });

  it("separates different tools using the same argument", () => {
    const bash = parseGateRequest("1", payload({ tool_name: "Bash", tool_input: { command: "git status" } }))!;
    const ps = parseGateRequest("2", payload({ tool_name: "PowerShell", tool_input: { command: "git status" } }))!;
    expect(gateCallKey(bash)).not.toBe(gateCallKey(ps));
  });

  it("groups writes into the same scratch directory", () => {
    const one = parseGateRequest("1", payload({ tool_name: "Write", tool_input: { file_path: "C:/Temp/a/one.ps1" } }))!;
    const two = parseGateRequest("2", payload({ tool_name: "Write", tool_input: { file_path: "C:/Temp/b/two.ps1" } }))!;
    expect(gateCallKey(one)).toBe(gateCallKey(two));
  });
});

describe("denialCallKey", () => {
  it("agrees with gateCallKey for the same call", () => {
    // The whole scheme depends on this: a denial seen in the stream and the
    // retry that reaches the gate must land on one key, or the user is asked
    // about a capability the extension already knows was refused.
    const request = parseGateRequest(
      "1",
      payload({ tool_input: { command: "pwsh -File Get-JiraAttachment.ps1" } }),
    )!;
    expect(denialCallKey("Bash", "pwsh -File Get-JiraAttachment.ps1")).toBe(
      gateCallKey(request),
    );
  });

  it("tolerates a denial that carried no command", () => {
    expect(denialCallKey("Bash", undefined)).toBe("Bash:");
  });
});

describe("gateHookOutput", () => {
  it("emits nothing for pass, so the CLI's own classifier still decides", () => {
    // Critical: any permissionDecision at all overrides the classifier, so a
    // "pass" spelled as "allow" would grant everything the gate declined to hold.
    expect(gateHookOutput("pass")).toBe("");
  });

  it("emits an allow decision the CLI understands", () => {
    const parsed = JSON.parse(gateHookOutput("allow", "approved by Conor"));
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "approved by Conor",
    });
  });

  it("emits a deny decision with a default reason", () => {
    const parsed = JSON.parse(gateHookOutput("deny"));
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Denied");
  });

  it("ends with a newline, because the CLI reads hook output by line", () => {
    expect(gateHookOutput("allow").endsWith("\n")).toBe(true);
  });
});

describe("buildGateSettings", () => {
  const settings = () =>
    buildGateSettings({
      scriptPath: "C:/Users/Conor Watson/gate.js",
      interpreter: "node",
      inboxPath: "C:/Users/Conor Watson/inbox",
      timeoutSeconds: 900,
      tools: ["Bash", "PowerShell", "Write"],
    }) as any;

  it("quotes paths containing spaces", () => {
    const command = settings().hooks.PreToolUse[0].hooks[0].command;
    expect(command).toContain('"C:/Users/Conor Watson/gate.js"');
    expect(command).toContain('"C:/Users/Conor Watson/inbox"');
  });

  it("matches the requested tools as an alternation", () => {
    expect(settings().hooks.PreToolUse[0].matcher).toBe("Bash|PowerShell|Write");
  });

  it("carries the timeout, since the default would cut a human off", () => {
    expect(settings().hooks.PreToolUse[0].hooks[0].timeout).toBe(900);
  });

  it("declares no permissions unless asked to", () => {
    // Layered over the user's settings, so it adds machinery by default and never
    // widens what the agent may do off its own bat.
    expect(settings().permissions).toBeUndefined();
  });

  it("carries only the allow rules it was handed", () => {
    // The one intended use is the extension's own ask_user tool: without a rule
    // the CLI refuses it and the agent reports it cannot ask its operator
    // anything. Nothing task-derived may be passed here.
    const withAllow = buildGateSettings({
      scriptPath: "/gate.js",
      interpreter: "node",
      inboxPath: "/inbox",
      timeoutSeconds: 900,
      tools: ["Bash"],
      allow: ["mcp__taskworkspaces__ask_user"],
    }) as any;
    expect(withAllow.permissions).toEqual({
      allow: ["mcp__taskworkspaces__ask_user"],
    });
  });

  it("installs no hook when no tools are gated", () => {
    // An empty matcher would gate *everything*. The file is still written because
    // it carries the ask_user allow rule, which is switched on separately.
    const noTools = buildGateSettings({
      scriptPath: "/gate.js",
      interpreter: "node",
      inboxPath: "/inbox",
      timeoutSeconds: 900,
      tools: [],
      allow: ["mcp__taskworkspaces__ask_user"],
    }) as any;
    expect(noTools.hooks).toBeUndefined();
    expect(noTools.permissions.allow).toEqual(["mcp__taskworkspaces__ask_user"]);
  });

  it("omits blank allow entries rather than writing an empty rule", () => {
    const withBlanks = buildGateSettings({
      scriptPath: "/gate.js",
      interpreter: "node",
      inboxPath: "/inbox",
      timeoutSeconds: 900,
      tools: ["Bash"],
      allow: ["   ", ""],
    }) as any;
    expect(withBlanks.permissions).toBeUndefined();
  });
});
