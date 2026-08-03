import { describe, it, expect } from "vitest";
import {
  DenialWatcher,
  collectPermissionDenials,
  formatDenialReport,
  isPermissionDenial,
  suggestAllowRules,
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
