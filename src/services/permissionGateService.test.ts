import { describe, expect, it, beforeEach } from "vitest";
import {
  GateFileSystem,
  PermissionGateService,
} from "./permissionGateService";
import { Logger } from "../logging/logger";

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** An in-memory filesystem, so the gate is exercised without touching disk. */
function memoryFs(): GateFileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return {
    files,
    join: (...segments) => segments.join("/"),
    // Stands in for path.resolve: anything not already rooted gets a root.
    resolve: (target) => (target.startsWith("/") ? target : `/abs/${target}`),
    mkdirp: (directory) => {
      directories.add(directory);
    },
    writeFile: (filePath, contents) => {
      files.set(filePath, contents);
    },
    readFile: (filePath) => files.get(filePath),
    removeFile: (filePath) => {
      files.delete(filePath);
    },
    removeDirectory: (directory) => {
      directories.delete(directory);
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${directory}/`)) files.delete(key);
      }
    },
    listFiles: (directory) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${directory}/`))
        .map((key) => key.slice(directory.length + 1))
        .filter((name) => !name.includes("/")),
  };
}

const INBOX = "/gates/t1/inbox";

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "s1",
    cwd: "C:/wt",
    tool_name: "Bash",
    tool_input: { command: "pwsh -File Get-JiraAttachment.ps1 -Id 1" },
    ...overrides,
  });
}

function make(options: { holdEverything?: boolean; allow?: string[] } = {}) {
  const fs = memoryFs();
  const service = new PermissionGateService(
    "/gates",
    fs,
    logger,
    () => "node",
    () => ["Bash", "Write"],
    () => 900,
    () => options.holdEverything ?? false,
    () => options.allow ?? [],
    () => "2026-08-04T10:00:00.000Z",
  );
  return { fs, service };
}

/** Reads the decision the service wrote for a request, if any. */
function decisionFor(fs: GateFileSystem, id: string) {
  const raw = fs.readFile(`${INBOX}/${id}.decision.json`);
  return raw ? JSON.parse(raw) : undefined;
}

describe("prepare", () => {
  it("writes the gate script and a settings file naming it", () => {
    const { fs, service } = make();
    const session = service.prepare("t1")!;

    expect(session.settingsPath).toBe("/gates/t1/settings.json");
    expect(fs.readFile("/gates/t1/gate.js")).toContain("hookSpecificOutput");

    const settings = JSON.parse(fs.readFile(session.settingsPath)!);
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Bash|Write");
    expect(hook.hooks[0].command).toContain("/gates/t1/gate.js");
    expect(hook.hooks[0].timeout).toBe(900);
    service.dispose();
  });

  it("adds no permissions of its own", () => {
    // Layered over the user's settings; it must add machinery, never capability.
    const { fs, service } = make();
    const session = service.prepare("t1")!;
    expect(JSON.parse(fs.readFile(session.settingsPath)!).permissions).toBeUndefined();
    service.dispose();
  });

  it("names absolute paths in the settings file", () => {
    // The CLI reads this file with the *worktree* as its working directory, so a
    // relative script or inbox path resolves somewhere else entirely and the hook
    // silently never fires — indistinguishable from the feature being off.
    const fs = memoryFs();
    const service = new PermissionGateService(
      "gates",
      fs,
      logger,
      () => "node",
      () => ["Bash"],
      () => 900,
    );
    const session = service.prepare("t1")!;
    expect(session.settingsPath.startsWith("/")).toBe(true);
    expect(session.inboxPath.startsWith("/")).toBe(true);

    const command = JSON.parse(fs.readFile(session.settingsPath)!).hooks
      .PreToolUse[0].hooks[0].command as string;
    expect(command).toContain("/abs/gates/t1/gate.js");
    expect(command).toContain("/abs/gates/t1/inbox");
    service.dispose();
  });

  it("writes decisions to the same inbox it told the hook to watch", () => {
    // These were two independent path computations once. A decision written
    // anywhere else leaves the agent blocked until the CLI's timeout.
    const fs = memoryFs();
    const service = new PermissionGateService(
      "gates",
      fs,
      logger,
      () => "node",
      () => ["Bash"],
      () => 900,
    );
    const session = service.prepare("t1")!;
    service.noteDenial("t1", "Bash", "pwsh x");
    fs.writeFile(`${session.inboxPath}/r1.request.json`, payload());
    service.sweep("t1", session.inboxPath);
    service.decide("r1", "allow");

    expect(fs.readFile(`${session.inboxPath}/r1.decision.json`)).toContain("allow");
    service.dispose();
  });

  it("discards calls left in the inbox by a host that died mid-stage", () => {
    // The reload case: the CLI holding these is gone with its host, so nothing
    // will ever read a decision. Left in place, the next sweep raises them for
    // approval against whichever subtask is running by then.
    //
    // Held-everything, because that is the setting under which it actually bites:
    // a restart empties the refusal memory, so an ordinary stale call would be
    // passed and cleared. This one would be held, and waited on by nobody.
    const { fs, service } = make({ holdEverything: true });
    const first = service.prepare("t1")!;
    fs.writeFile(`${first.inboxPath}/stale.request.json`, payload());

    const second = service.prepare("t1")!;
    service.sweep("t1", second.inboxPath);

    expect(fs.readFile(`${second.inboxPath}/stale.request.json`)).toBeUndefined();
    expect(service.waiting()).toHaveLength(0);
    service.dispose();
  });

  it("sanitises a task id before putting it in a path", () => {
    const { fs, service } = make();
    const session = service.prepare("../evil/t1")!;
    expect(session.settingsPath).not.toContain("..");
    expect(fs.readFile(session.settingsPath)).toBeDefined();
    service.dispose();
  });
});

describe("sweeping the inbox", () => {
  let fs: ReturnType<typeof memoryFs>;
  let service: PermissionGateService;

  beforeEach(() => {
    const made = make();
    fs = made.fs;
    service = made.service;
    service.prepare("t1");
  });

  it("passes an unknown call, leaving the CLI's classifier in charge", () => {
    fs.writeFile(`${INBOX}/r1${".request.json"}`, payload());
    service.sweep("t1", INBOX);

    expect(decisionFor(fs, "r1")).toEqual({ decision: "pass" });
    expect(service.waiting()).toHaveLength(0);
  });

  it("holds a call whose capability the CLI already refused", () => {
    service.noteDenial("t1", "Bash", "pwsh -File Get-JiraAttachment.ps1 -Id 9");
    fs.writeFile(`${INBOX}/r1.request.json`, payload());
    service.sweep("t1", INBOX);

    // No decision yet: the agent is deliberately held.
    expect(decisionFor(fs, "r1")).toBeUndefined();
    const waiting = service.waiting("t1");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].detail).toContain("Get-JiraAttachment.ps1");
  });

  it("recognises a reworded retry as the same capability", () => {
    // The observed loop: five variants of one invocation. One denial must be
    // enough to gate all of them.
    service.noteDenial("t1", "Bash", "pwsh -File Get-JiraAttachment.ps1");
    fs.writeFile(
      `${INBOX}/r1.request.json`,
      payload({ tool_input: { command: "pwsh -NoProfile -File Get-JiraAttachment.ps1 -Id 4" } }),
    );
    service.sweep("t1", INBOX);
    expect(service.waiting("t1")).toHaveLength(1);
  });

  it("does not raise the same request twice across sweeps", () => {
    service.noteDenial("t1", "Bash", "pwsh x");
    fs.writeFile(`${INBOX}/r1.request.json`, payload());
    service.sweep("t1", INBOX);
    service.sweep("t1", INBOX);
    expect(service.waiting("t1")).toHaveLength(1);
  });

  it("allows an unreadable request rather than hanging the stage", () => {
    // A payload shape we do not understand is our problem, not the stage's.
    fs.writeFile(`${INBOX}/r1.request.json`, "not json at all");
    service.sweep("t1", INBOX);
    expect(decisionFor(fs, "r1").decision).toBe("allow");
    expect(service.waiting()).toHaveLength(0);
  });

  it("ignores files that are not requests", () => {
    fs.writeFile(`${INBOX}/r1.request.json.partial`, payload());
    service.sweep("t1", INBOX);
    expect(service.waiting()).toHaveLength(0);
  });

  it("notifies listeners when a call starts waiting", () => {
    let changes = 0;
    service.onChanged(() => (changes += 1));
    service.noteDenial("t1", "Bash", "pwsh x");
    fs.writeFile(`${INBOX}/r1.request.json`, payload());
    service.sweep("t1", INBOX);
    expect(changes).toBe(1);
  });
});

describe("deciding", () => {
  let fs: ReturnType<typeof memoryFs>;
  let service: PermissionGateService;

  beforeEach(() => {
    const made = make();
    fs = made.fs;
    service = made.service;
    service.prepare("t1");
    service.noteDenial("t1", "Bash", "pwsh -File Get-JiraAttachment.ps1");
  });

  function hold(id: string, overrides: Record<string, unknown> = {}) {
    fs.writeFile(`${INBOX}/${id}.request.json`, payload(overrides));
    service.sweep("t1", INBOX);
  }

  it("writes an allow decision the waiting hook will read", () => {
    hold("r1");
    expect(service.decide("r1", "allow")).toBe(true);
    expect(decisionFor(fs, "r1")).toMatchObject({ decision: "allow" });
    expect(service.waiting()).toHaveLength(0);
  });

  it("writes a deny decision", () => {
    hold("r1");
    service.decide("r1", "deny");
    expect(decisionFor(fs, "r1").decision).toBe("deny");
  });

  it("answers a later call from a session approval without asking again", () => {
    hold("r1");
    service.decide("r1", "allow", "session");

    hold("r2", { tool_input: { command: "pwsh -File Get-JiraAttachment.ps1 -Id 7" } });
    expect(decisionFor(fs, "r2")).toMatchObject({ decision: "allow" });
    expect(service.waiting()).toHaveLength(0);
  });

  it("asks again after a once approval is spent", () => {
    hold("r1");
    service.decide("r1", "allow", "once");
    hold("r2");
    expect(decisionFor(fs, "r2")).toBeUndefined();
    expect(service.waiting("t1")).toHaveLength(1);
  });

  it("remembers a denial so the agent's retries are not re-asked in a loop", () => {
    hold("r1");
    service.decide("r1", "deny", "session");
    hold("r2");
    expect(decisionFor(fs, "r2").decision).toBe("deny");
    expect(service.waiting()).toHaveLength(0);
  });

  it("reports false for a request it is not holding", () => {
    expect(service.decide("nope", "allow")).toBe(false);
  });

  it("answers every waiting call for a task at once", () => {
    hold("r1");
    hold("r2", { tool_input: { command: "pwsh -File Other.ps1" } });
    service.noteDenial("t1", "Bash", "pwsh -File Other.ps1");
    hold("r2", { tool_input: { command: "pwsh -File Other.ps1" } });

    const answered = service.decideAll("t1", "allow", "session");
    expect(answered).toBeGreaterThanOrEqual(1);
    expect(service.waiting("t1")).toHaveLength(0);
  });

  it("keeps approvals separate between tasks", () => {
    // A capability approved for one task must not silently apply to another.
    service.prepare("t2");
    service.noteDenial("t2", "Bash", "pwsh -File Get-JiraAttachment.ps1");
    hold("r1");
    service.decide("r1", "allow", "session");

    fs.writeFile("/gates/t2/inbox/r9.request.json", payload());
    service.sweep("t2", "/gates/t2/inbox");
    expect(service.waiting("t2")).toHaveLength(1);
  });
});

describe("release", () => {
  it("removes the inbox, which tells any live hook to stop waiting", () => {
    const { fs, service } = make();
    service.prepare("t1");
    service.noteDenial("t1", "Bash", "pwsh x");
    fs.writeFile(`${INBOX}/r1.request.json`, payload());
    service.sweep("t1", INBOX);
    expect(service.waiting("t1")).toHaveLength(1);

    service.release("t1");
    expect(service.waiting("t1")).toHaveLength(0);
    expect(fs.readFile(`${INBOX}/r1.request.json`)).toBeUndefined();
  });

  it("keeps standing approvals across a release, but forget drops them", () => {
    const { fs, service } = make();
    service.prepare("t1");
    service.noteDenial("t1", "Bash", "pwsh x");
    fs.writeFile(`${INBOX}/r1.request.json`, payload());
    service.sweep("t1", INBOX);
    service.decide("r1", "allow", "session");

    // A new stage in the same task reuses the approval rather than re-asking.
    service.release("t1");
    service.prepare("t1");
    fs.writeFile(`${INBOX}/r2.request.json`, payload());
    service.sweep("t1", INBOX);
    expect(decisionFor(fs, "r2")).toMatchObject({ decision: "allow" });

    service.forget("t1");
    service.prepare("t1");
    service.noteDenial("t1", "Bash", "pwsh x");
    fs.writeFile(`${INBOX}/r3.request.json`, payload());
    service.sweep("t1", INBOX);
    expect(service.waiting("t1")).toHaveLength(1);
  });
});

describe("holding everything", () => {
  it("holds even a call that was never refused", () => {
    const { fs, service } = make({ holdEverything: true });
    service.prepare("t1");
    fs.writeFile(`${INBOX}/r1.request.json`, payload());
    service.sweep("t1", INBOX);
    expect(service.waiting("t1")).toHaveLength(1);
    service.dispose();
  });
});

describe("isArmed", () => {
  it("is false before prepare, so a soft failure is not mistaken for a gate", () => {
    const { service } = make();
    expect(service.isArmed("t1")).toBe(false);
  });

  it("is true once the hook is installed", () => {
    const { service } = make();
    service.prepare("t1");
    expect(service.isArmed("t1")).toBe(true);
  });

  it("is false again after release, when nothing is watching the inbox", () => {
    const { service } = make();
    service.prepare("t1");
    service.release("t1");
    expect(service.isArmed("t1")).toBe(false);
  });
});
