import { describe, it, expect } from "vitest";
import {
  DenialWatcher,
  collectPermissionDenials,
  formatDenialReport,
  isPermissionDenial,
  suggestAllowRules,
  durableAllowRule,
  suggestAllowRule,
} from "./permissionDenials";
import { ChatItem } from "./streamJson";

/** Verbatim refusals from a real route, which is what these must recognise. */
const REAL = {
  multipleOps:
    "This PowerShell command contains multiple operations. The following part requires approval: & ./tools/jira/Get-JiraAttachment.ps1 -IssueKey NMGB-2792",
  nested: "Command spawns a nested PowerShell process which cannot be validated",
  cwd: "Compound command changes working directory (Set-Location/Push-Location/Pop-Location/New-PSDrive) — relative paths cannot be validated against the original cwd and require manual approval",
  bare: "This command requires approval",
};

function tool(name: string, detail: string): ChatItem {
  return { kind: "tool", name, detail };
}
function failed(text: string): ChatItem {
  return { kind: "tool-result", text, isError: true };
}

describe("isPermissionDenial", () => {
  it("recognises every refusal a real route produced", () => {
    for (const text of Object.values(REAL)) {
      expect(isPermissionDenial(text)).toBe(true);
    }
  });

  it("does not treat an operating-system failure as a policy refusal", () => {
    // "Permission denied" on a file is a genuine error, not something an allow
    // rule fixes — reporting it as one would send the user to the wrong place.
    expect(isPermissionDenial("bash: ./deploy.sh: Permission denied")).toBe(false);
    expect(isPermissionDenial("EACCES: permission denied, open 'x.log'")).toBe(false);
  });

  it("ignores ordinary failures", () => {
    expect(isPermissionDenial("error TS2322: Type 'string' is not assignable")).toBe(false);
    expect(isPermissionDenial("")).toBe(false);
  });
});

describe("collectPermissionDenials", () => {
  it("attributes a refusal to the call that caused it", () => {
    const denials = collectPermissionDenials([
      tool("PowerShell", "& ./tools/jira/Get-JiraAttachment.ps1 -IssueKey NMGB-2792"),
      failed(REAL.multipleOps),
    ]);
    expect(denials).toHaveLength(1);
    expect(denials[0].tool).toBe("PowerShell");
    expect(denials[0].command).toContain("Get-JiraAttachment.ps1");
    expect(denials[0].reason).toContain("multiple operations");
  });

  it("collapses the retry loop into one entry with a count", () => {
    // The agent rewords the same call hoping to pass validation; five variations
    // of one script cost 39 seconds on a real route.
    const items: ChatItem[] = [];
    for (const text of [REAL.multipleOps, REAL.nested, REAL.cwd, REAL.bare]) {
      items.push(tool("PowerShell", "Get-JiraAttachment.ps1 -IssueKey NMGB-2792"), failed(text));
    }
    const denials = collectPermissionDenials(items);
    expect(denials).toHaveLength(1);
    expect(denials[0].attempts).toBe(4);
  });

  it("keeps genuinely different calls apart", () => {
    const denials = collectPermissionDenials([
      tool("PowerShell", "Get-JiraAttachment.ps1 -IssueKey A"),
      failed(REAL.bare),
      tool("Bash", "sqlcmd -Q 'select 1'"),
      failed(REAL.bare),
    ]);
    expect(denials.map((d) => d.tool)).toEqual(["PowerShell", "Bash"]);
  });

  it("ignores failures that are not refusals", () => {
    const denials = collectPermissionDenials([
      tool("Bash", "npm test"),
      failed("3 tests failed"),
    ]);
    expect(denials).toEqual([]);
  });

  it("ignores a refusal-shaped success, since only errors are refusals", () => {
    const denials = collectPermissionDenials([
      tool("Bash", "cat notes.md"),
      { kind: "tool-result", text: "the docs mention this requires approval", isError: false },
    ]);
    expect(denials).toEqual([]);
  });

  it("still reports a refusal with no preceding call", () => {
    const denials = collectPermissionDenials([failed(REAL.bare)]);
    expect(denials).toHaveLength(1);
    expect(denials[0].tool).toBe("tool");
  });

  it("finds nothing in an empty transcript", () => {
    expect(collectPermissionDenials([])).toEqual([]);
  });
});

describe("suggestAllowRules", () => {
  it("suggests a prefix rule, because arguments change every run", () => {
    // An exact rule would be denied again with the next ticket id.
    const rules = suggestAllowRules(
      collectPermissionDenials([
        tool("PowerShell", "C:\\Dev\\app\\tools\\jira\\Get-JiraAttachment.ps1 -IssueKey NMGB-2792"),
        failed(REAL.bare),
      ]),
    );
    expect(rules).toEqual(["PowerShell(C:\\Dev\\app\\tools\\jira\\Get-JiraAttachment.ps1:*)"]);
  });

  it("strips the call operator, which is itself what fails validation", () => {
    const rules = suggestAllowRules(
      collectPermissionDenials([
        tool("PowerShell", "& ./tools/jira/Get-JiraAttachment.ps1 -IssueKey X"),
        failed(REAL.multipleOps),
      ]),
    );
    expect(rules).toEqual(["PowerShell(./tools/jira/Get-JiraAttachment.ps1:*)"]);
  });

  it("strips surrounding quotes from a quoted path", () => {
    const rules = suggestAllowRules(
      collectPermissionDenials([
        tool("PowerShell", '"C:\\Dev\\app\\tools\\x.ps1" -Key 1'),
        failed(REAL.bare),
      ]),
    );
    expect(rules).toEqual(["PowerShell(C:\\Dev\\app\\tools\\x.ps1:*)"]);
  });

  it("de-duplicates rules across differently-worded attempts", () => {
    const rules = suggestAllowRules([
      { tool: "PowerShell", command: "x.ps1 -A", reason: "r", attempts: 1 },
      { tool: "PowerShell", command: "x.ps1 -B", reason: "r", attempts: 1 },
    ]);
    expect(rules).toEqual(["PowerShell(x.ps1:*)"]);
  });

  it("suggests nothing when there was no command to key on", () => {
    expect(suggestAllowRules([{ tool: "Bash", reason: "r", attempts: 1 }])).toEqual([]);
  });

  describe("file tools", () => {
    const denial = (tool: string, path: string): PermissionDenial => ({
      tool,
      command: path,
      reason: "requires approval",
      attempts: 1,
    });

    /** Windows paths as the stream reports them, with real backslashes. */
    const win = (...segments: string[]) => segments.join("\\");

    it("uses a directory glob, not the command-prefix form", () => {
      // ":*" is for shell commands. A path rule needs a path pattern, and naming
      // a single file would never match again.
      const path = win("C:", "Dev", "app", "src", "x.cs");
      expect(suggestAllowRules([denial("Write", path)])).toEqual([
        "Write(C:/Dev/app/src/**)",
      ]);
    });

    it("generalises a scratch path to its root, not the ticket folder", () => {
      // The reported case. A rule naming one file under a ticket-specific temp
      // folder is replaced by a new one every ticket, so the allow list fills
      // with dead entries.
      const path = win("C:", "temp", "nmgb2792", "q.ps1");
      expect(suggestAllowRules([denial("Write", path)])).toEqual([
        "Write(C:/temp/**)",
      ]);
    });

    it("collapses many scratch files into one rule", () => {
      const rules = suggestAllowRules([
        denial("Write", win("C:", "temp", "nmgb2792", "q.ps1")),
        denial("Write", win("C:", "temp", "nmgb2792", "r.ps1")),
        denial("Write", win("C:", "temp", "nmgb3001", "s.ps1")),
      ]);
      expect(rules).toEqual(["Write(C:/temp/**)"]);
    });

    it("recognises the usual temporary locations", () => {
      expect(suggestAllowRules([denial("Write", "/tmp/build/x.sh")])).toEqual([
        "Write(/tmp/**)",
      ]);
      const appData = win(
        "C:", "Users", "Someone", "AppData", "Local", "Temp", "a", "b.txt",
      );
      expect(suggestAllowRules([denial("Read", appData)])).toEqual([
        "Read(C:/Users/Someone/AppData/Local/Temp/**)",
      ]);
    });

    it("keeps different real directories apart", () => {
      const rules = suggestAllowRules([
        denial("Edit", "C:/Dev/app/src/a.cs"),
        denial("Edit", "C:/Dev/app/tools/b.ps1"),
      ]);
      expect(rules).toEqual(["Edit(C:/Dev/app/src/**)", "Edit(C:/Dev/app/tools/**)"]);
    });

    it("suggests nothing for a bare filename with no directory", () => {
      expect(suggestAllowRules([denial("Write", "notes.md")])).toEqual([]);
    });
  });
});

describe("formatDenialReport", () => {
  it("names the calls, the retries, and what to add", () => {
    const report = formatDenialReport(
      collectPermissionDenials([
        tool("PowerShell", "tools/jira/Get-JiraAttachment.ps1 -IssueKey X"),
        failed(REAL.multipleOps),
        tool("PowerShell", "tools/jira/Get-JiraAttachment.ps1 -IssueKey X"),
        failed(REAL.nested),
      ]),
    );
    expect(report).toContain("1 tool call(s) were denied");
    expect(report).toContain("2 attempts");
    expect(report).toContain("permissions.allow");
    expect(report).toContain('"PowerShell(tools/jira/Get-JiraAttachment.ps1:*)"');
  });

  it("is empty when nothing was denied, so nothing is logged", () => {
    expect(formatDenialReport([])).toBe("");
  });
});

describe("DenialWatcher", () => {
  it("reports a refusal the moment it arrives", () => {
    // Scanning the finished transcript is too late: the refusal happens seconds
    // in and the agent then spends turns working around it.
    const watcher = new DenialWatcher();
    expect(watcher.observe(tool("PowerShell", "x.ps1 -Key 1"))).toBeUndefined();
    const denial = watcher.observe(failed(REAL.bare));
    expect(denial?.tool).toBe("PowerShell");
    expect(denial?.command).toBe("x.ps1 -Key 1");
  });

  it("announces a call once but keeps counting its retries", () => {
    const watcher = new DenialWatcher();
    watcher.observe(tool("PowerShell", "x.ps1"));
    expect(watcher.observe(failed(REAL.bare))).toBeDefined();

    watcher.observe(tool("PowerShell", "x.ps1"));
    expect(watcher.observe(failed(REAL.nested))).toBeUndefined();
    watcher.observe(tool("PowerShell", "x.ps1"));
    expect(watcher.observe(failed(REAL.cwd))).toBeUndefined();

    expect(watcher.all()).toHaveLength(1);
    expect(watcher.all()[0].attempts).toBe(3);
  });

  it("announces a genuinely different call separately", () => {
    const watcher = new DenialWatcher();
    watcher.observe(tool("PowerShell", "x.ps1"));
    watcher.observe(failed(REAL.bare));
    watcher.observe(tool("Bash", "sqlcmd -Q 'select 1'"));
    expect(watcher.observe(failed(REAL.bare))?.tool).toBe("Bash");
    expect(watcher.all()).toHaveLength(2);
  });

  it("stays quiet for ordinary failures and successes", () => {
    const watcher = new DenialWatcher();
    watcher.observe(tool("Bash", "npm test"));
    expect(watcher.observe(failed("2 tests failed"))).toBeUndefined();
    watcher.observe(tool("Bash", "cat x"));
    expect(
      watcher.observe({ kind: "tool-result", text: "requires approval", isError: false }),
    ).toBeUndefined();
    expect(watcher.all()).toEqual([]);
  });

  it("agrees with the whole-transcript scan", () => {
    const items: ChatItem[] = [
      tool("PowerShell", "x.ps1"),
      failed(REAL.bare),
      tool("PowerShell", "x.ps1"),
      failed(REAL.nested),
      tool("Bash", "npm test"),
      failed("nope"),
    ];
    const watcher = new DenialWatcher();
    for (const item of items) watcher.observe(item);
    expect(watcher.all()).toEqual(collectPermissionDenials(items));
  });
});

describe("rules that must never be suggested", () => {
  const denial = (tool: string, command: string, reason = "This command requires approval"): PermissionDenial => ({
    tool,
    command,
    reason,
    attempts: 1,
  });

  it("never grants a shell or interpreter", () => {
    // Bash(bash:*) and PowerShell(powershell:*) grant everything the interpreter
    // can be told to run — the same objection as whitelisting powershell.exe in
    // a virus scanner.
    expect(suggestAllowRules([denial("Bash", "bash -c 'echo hi'")])).toEqual([]);
    expect(suggestAllowRules([denial("PowerShell", "powershell -NoProfile")])).toEqual([]);
    expect(suggestAllowRules([denial("Bash", "sudo sh")])).toEqual([]);
  });

  it("never grants a bare builtin", () => {
    expect(suggestAllowRules([denial("Bash", "cd C:/Dev/app")])).toEqual([]);
    expect(suggestAllowRules([denial("Bash", "export FOO=bar")])).toEqual([]);
  });

  it("skips past the wrapper to the command that matters", () => {
    // "cd X && real-command" used to yield Bash(cd:*).
    expect(
      suggestAllowRules([denial("Bash", "cd C:/Dev/app && ./tools/run.sh --all")]),
    ).toEqual(["Bash(./tools/run.sh:*)"]);
  });

  it("skips an interpreter and its flags to reach the script", () => {
    expect(
      suggestAllowRules([
        denial("PowerShell", 'powershell -NoProfile -File "C:/Dev/app/x.ps1" -Key 1'),
      ]),
    ).toEqual(["PowerShell(C:/Dev/app/x.ps1:*)"]);
  });

  it("prefers the fragment the validator named as offending", () => {
    // The message says exactly which part needed approval; the rest is setup.
    const rules = suggestAllowRules([
      denial(
        "PowerShell",
        'Set-Location C:/Dev/app; & ./tools/jira/Get-JiraAttachment.ps1 -IssueKey X',
        "This PowerShell command contains multiple operations. The following part requires approval: & ./tools/jira/Get-JiraAttachment.ps1 -IssueKey X",
      ),
    ]);
    expect(rules).toEqual(["PowerShell(./tools/jira/Get-JiraAttachment.ps1:*)"]);
  });

  it("skips a leading environment assignment", () => {
    expect(suggestAllowRules([denial("Bash", "FOO=bar ./run.sh")])).toEqual([
      "Bash(./run.sh:*)",
    ]);
  });

  it("still grants an ordinary command", () => {
    expect(suggestAllowRules([denial("Bash", "sqlcmd -Q 'select 1'")])).toEqual([
      "Bash(sqlcmd:*)",
    ]);
  });
});

describe("DenialWatcher with parallel tool calls", () => {
  const denialText = "Claude requested permissions to use Bash, but you haven't granted it yet.";

  it("pairs a refusal with the call it answers, not the most recent one", () => {
    // The real failure: "Read denied — This Bash command contains multiple
    // operations". Bash was refused, but a later Read entry owned the pairing, so
    // the refusal was recorded against a capability that was never refused.
    const watcher = new DenialWatcher();
    watcher.observe({ kind: "tool", name: "Bash", detail: "cd x && cat y", id: "call_1" });
    watcher.observe({ kind: "tool", name: "Read", detail: "README.md", id: "call_2" });

    const denial = watcher.observe({
      kind: "tool-result",
      text: denialText,
      isError: true,
      callId: "call_1",
    });

    expect(denial?.tool).toBe("Bash");
    expect(denial?.command).toBe("cd x && cat y");
  });

  it("still attributes correctly when results arrive out of order", () => {
    const watcher = new DenialWatcher();
    watcher.observe({ kind: "tool", name: "Bash", detail: "one", id: "a" });
    watcher.observe({ kind: "tool", name: "PowerShell", detail: "two", id: "b" });

    const second = watcher.observe({
      kind: "tool-result",
      text: denialText,
      isError: true,
      callId: "b",
    });
    const first = watcher.observe({
      kind: "tool-result",
      text: denialText,
      isError: true,
      callId: "a",
    });

    expect(second?.tool).toBe("PowerShell");
    expect(first?.tool).toBe("Bash");
    expect(watcher.all()).toHaveLength(2);
  });

  it("falls back to the most recent call when the stream carries no ids", () => {
    const watcher = new DenialWatcher();
    watcher.observe({ kind: "tool", name: "Bash", detail: "cd x && cat y" });
    const denial = watcher.observe({
      kind: "tool-result",
      text: denialText,
      isError: true,
    });
    expect(denial?.tool).toBe("Bash");
  });

  it("falls back when a result names a call it never saw", () => {
    const watcher = new DenialWatcher();
    watcher.observe({ kind: "tool", name: "Bash", detail: "cd x", id: "a" });
    const denial = watcher.observe({
      kind: "tool-result",
      text: denialText,
      isError: true,
      callId: "missing",
    });
    expect(denial?.tool).toBe("Bash");
  });

  it("counts a genuine retry of the same call once", () => {
    const watcher = new DenialWatcher();
    watcher.observe({ kind: "tool", name: "Bash", detail: "cd x", id: "a" });
    watcher.observe({ kind: "tool-result", text: denialText, isError: true, callId: "a" });
    watcher.observe({ kind: "tool", name: "Bash", detail: "cd x", id: "b" });
    const repeat = watcher.observe({
      kind: "tool-result",
      text: denialText,
      isError: true,
      callId: "b",
    });

    expect(repeat).toBeUndefined();
    expect(watcher.all()).toHaveLength(1);
    expect(watcher.all()[0].attempts).toBe(2);
  });
});

describe("durableAllowRule", () => {
  const ctx = {
    worktreePath: "C:/Dev/worktrees/qubeautoapp-scorecard-ev-share-national",
    repositoryRoot: "C:/Dev/qubeautoapp",
  };

  const fileDenial = {
    tool: "Read",
    command:
      "C:/Dev/worktrees/qubeautoapp-scorecard-ev-share-national/tools/sql/manufacturers/nissangb/data/StoredProcedures/usp_Thing.sql",
    reason: "Claude requires approval to read this file.",
    attempts: 1,
  };

  it("offers a worktree-relative twin for a file rule", () => {
    expect(durableAllowRule(fileDenial, ctx)).toBe(
      "Read(tools/sql/manufacturers/nissangb/data/StoredProcedures/**)",
    );
  });

  it("keeps the absolute rule as the primary, since that one is known to match", () => {
    expect(suggestAllowRule(fileDenial)).toBe(
      "Read(C:/Dev/worktrees/qubeautoapp-scorecard-ev-share-national/tools/sql/manufacturers/nissangb/data/StoredProcedures/**)",
    );
  });

  it("returns both from suggestAllowRules, so the grant outlives the task", () => {
    const rules = suggestAllowRules([fileDenial], ctx);
    expect(rules).toHaveLength(2);
    expect(rules.some((r) => r.includes("C:/Dev/worktrees"))).toBe(true);
    expect(rules).toContain(
      "Read(tools/sql/manufacturers/nissangb/data/StoredProcedures/**)",
    );
  });

  it("offers no relative twin for a command rule", () => {
    // A command rule is matched against the literal command text, and the agent
    // writes absolute paths because its cwd is the worktree — which is why a
    // hand-written PowerShell(tools\jira\x.ps1:*) never fired.
    const command = {
      tool: "PowerShell",
      command:
        "C:/Dev/worktrees/qubeautoapp-scorecard-ev-share-national/tools/jira/Get-JiraAttachment.ps1 -Id 9",
      reason: "requires approval",
      attempts: 1,
    };
    expect(durableAllowRule(command, ctx)).toBeUndefined();
  });

  it("offers nothing when the path is outside the worktree and repository", () => {
    const outside = { ...fileDenial, command: "D:/elsewhere/thing/file.sql" };
    expect(durableAllowRule(outside, ctx)).toBeUndefined();
  });

  it("matches the worktree case-insensitively, as Windows paths vary", () => {
    const mixed = {
      ...fileDenial,
      command:
        "c:/dev/WORKTREES/qubeautoapp-scorecard-ev-share-national/tools/sql/x/file.sql",
    };
    expect(durableAllowRule(mixed, ctx)).toBe("Read(tools/sql/x/**)");
  });

  it("needs no context to keep working", () => {
    expect(durableAllowRule(fileDenial)).toBeUndefined();
    expect(suggestAllowRules([fileDenial])).toHaveLength(1);
  });
});
