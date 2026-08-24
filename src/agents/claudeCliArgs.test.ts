import { describe, it, expect } from "vitest";
import { buildCliArgs, commandForShell, resolveMcpConfigPath } from "./claudeCliArgs";

const BASE = { sessionId: "sess-1", permissionMode: "acceptEdits" };

/** The value following `flag` in the argument list. */
function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildCliArgs", () => {
  it("creates a session with a known id when not resuming", () => {
    const args = buildCliArgs(BASE);
    expect(valueOf(args, "--session-id")).toBe("sess-1");
    expect(args).not.toContain("--resume");
  });

  it("resumes instead of creating when a resume id is given", () => {
    const args = buildCliArgs({ ...BASE, resumeSessionId: "old" });
    expect(valueOf(args, "--resume")).toBe("old");
    expect(args).not.toContain("--session-id");
  });

  it("streams json both ways, which the whole protocol layer assumes", () => {
    const args = buildCliArgs(BASE);
    expect(valueOf(args, "--input-format")).toBe("stream-json");
    expect(valueOf(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("-p");
  });

  it("omits the model flag when no model is configured", () => {
    expect(buildCliArgs(BASE)).not.toContain("--model");
    expect(buildCliArgs({ ...BASE, model: "   " })).not.toContain("--model");
    expect(valueOf(buildCliArgs({ ...BASE, model: " opus " }), "--model")).toBe("opus");
  });

  it("skips blank add-dirs rather than passing an empty argument", () => {
    const args = buildCliArgs({ ...BASE, addDirs: ["C:/repo", "  "] });
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(1);
  });

  describe("MCP config", () => {
    it("is passed so a worktree's unapproved .mcp.json still loads", () => {
      const args = buildCliArgs({ ...BASE, mcpConfigPath: "C:/repo/.mcp.json" });
      expect(valueOf(args, "--mcp-config")).toBe("C:/repo/.mcp.json");
    });

    it("is omitted when there is nothing to load", () => {
      expect(buildCliArgs(BASE)).not.toContain("--mcp-config");
      expect(buildCliArgs({ ...BASE, mcpConfigPath: "  " })).not.toContain("--mcp-config");
    });

    it("does not add --strict-mcp-config by default, which would drop user-scope servers", () => {
      const args = buildCliArgs({ ...BASE, mcpConfigPath: "C:/repo/.mcp.json" });
      expect(args).not.toContain("--strict-mcp-config");
    });

    it("adds --strict-mcp-config when the caller narrowed the server set", () => {
      // Without it `--mcp-config` only *adds*: the worktree's own approved
      // `.mcp.json` starts every server, so a reduced config changes nothing.
      // Observed exactly that — a stage asked for one server and started nine.
      const args = buildCliArgs({
        ...BASE,
        mcpConfigPath: "C:/gates/stage-mcp/mcp.json",
        strictMcpConfig: true,
      });
      expect(args).toContain("--strict-mcp-config");
    });

    it("keeps --strict-mcp-config ahead of the variadic --mcp-config", () => {
      const args = buildCliArgs({
        ...BASE,
        mcpConfigPath: "C:/gates/stage-mcp/mcp.json",
        strictMcpConfig: true,
      });
      expect(args.indexOf("--strict-mcp-config")).toBeLessThan(
        args.indexOf("--mcp-config"),
      );
      expect(args[args.length - 2]).toBe("--mcp-config");
    });

    it("ignores strict mode when there is no config to be strict about", () => {
      // Strict with no config would leave the session with no servers at all.
      const args = buildCliArgs({ ...BASE, strictMcpConfig: true });
      expect(args).not.toContain("--strict-mcp-config");
      const blank = buildCliArgs({ ...BASE, mcpConfigPath: "   ", strictMcpConfig: true });
      expect(blank).not.toContain("--strict-mcp-config");
    });

    it("stays last, because the flag is variadic and swallows what follows", () => {
      // `--mcp-config` takes several space-separated configs, so any following
      // non-flag argument is read as another config path and the CLI exits with
      // "MCP config file not found". Verified against the real CLI.
      const args = buildCliArgs({
        ...BASE,
        model: "opus",
        addDirs: ["C:/repo"],
        mcpConfigPath: "C:/repo/.mcp.json",
        settingsPath: "C:/gates/t1/settings.json",
      });
      expect(args[args.length - 2]).toBe("--mcp-config");
      expect(args[args.length - 1]).toBe("C:/repo/.mcp.json");
    });
  });

  describe("several mcp configs", () => {
    it("passes them all under one variadic flag", () => {
      const args = buildCliArgs({
        ...BASE,
        mcpConfigPath: "C:/repo/.mcp.json",
        extraMcpConfigPaths: ["C:/gates/t1/ask-mcp.json"],
      });
      expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
      expect(args.slice(-2)).toEqual([
        "C:/repo/.mcp.json",
        "C:/gates/t1/ask-mcp.json",
      ]);
    });

    it("works when only the extension's own config exists", () => {
      // A project with no .mcp.json must still get the ask_user server.
      const args = buildCliArgs({
        ...BASE,
        extraMcpConfigPaths: ["C:/gates/t1/ask-mcp.json"],
      });
      expect(valueOf(args, "--mcp-config")).toBe("C:/gates/t1/ask-mcp.json");
    });

    it("omits the flag when every path is blank", () => {
      expect(
        buildCliArgs({ ...BASE, extraMcpConfigPaths: ["", "  "] }),
      ).not.toContain("--mcp-config");
    });

    it("keeps the flag last, since it swallows what follows", () => {
      const args = buildCliArgs({
        ...BASE,
        model: "opus",
        settingsPath: "C:/gates/t1/settings.json",
        mcpConfigPath: "C:/repo/.mcp.json",
        extraMcpConfigPaths: ["C:/gates/t1/ask-mcp.json"],
      });
      expect(args.indexOf("--mcp-config")).toBe(args.length - 3);
    });
  });

  describe("--settings", () => {
    it("passes the gate settings file when one is given", () => {
      const args = buildCliArgs({
        ...BASE,
        settingsPath: "C:/gates/t1/settings.json",
      });
      expect(valueOf(args, "--settings")).toBe("C:/gates/t1/settings.json");
    });

    it("is omitted when absent or blank", () => {
      expect(buildCliArgs(BASE)).not.toContain("--settings");
      expect(buildCliArgs({ ...BASE, settingsPath: "   " })).not.toContain(
        "--settings",
      );
    });

    it("quotes a path with spaces when a shell will re-parse it", () => {
      const args = buildCliArgs({
        ...BASE,
        settingsPath: "C:/Users/Conor Watson/gates/settings.json",
        useShell: true,
      });
      expect(valueOf(args, "--settings")).toBe(
        '"C:/Users/Conor Watson/gates/settings.json"',
      );
    });

    it("comes before --mcp-config, which swallows what follows it", () => {
      const args = buildCliArgs({
        ...BASE,
        settingsPath: "C:/gates/t1/settings.json",
        mcpConfigPath: "C:/repo/.mcp.json",
      });
      expect(args.indexOf("--settings")).toBeLessThan(args.indexOf("--mcp-config"));
    });
  });

  describe("quoting", () => {
    it("quotes paths containing spaces when a shell will re-parse them", () => {
      const args = buildCliArgs({
        ...BASE,
        addDirs: ["C:/Program Files/repo"],
        mcpConfigPath: "C:/my repo/.mcp.json",
        useShell: true,
      });
      expect(valueOf(args, "--add-dir")).toBe('"C:/Program Files/repo"');
      expect(valueOf(args, "--mcp-config")).toBe('"C:/my repo/.mcp.json"');
    });

    it("does not quote when argv is passed directly, or the quotes become path", () => {
      const args = buildCliArgs({
        ...BASE,
        addDirs: ["C:/Program Files/repo"],
        useShell: false,
      });
      expect(valueOf(args, "--add-dir")).toBe("C:/Program Files/repo");
    });

    it("leaves paths without spaces alone even under a shell", () => {
      const args = buildCliArgs({ ...BASE, addDirs: ["C:/repo"], useShell: true });
      expect(valueOf(args, "--add-dir")).toBe("C:/repo");
    });
  });
});

describe("resolveMcpConfigPath", () => {
  const always = () => true;
  const never = () => false;

  it("resolves a relative path against the repository root, not the worktree", () => {
    // MCP servers grant tool access; a branch must not be able to point this at
    // a file it controls and hand itself new capabilities.
    expect(resolveMcpConfigPath("C:/repos/app", ".mcp.json", always)).toBe(
      "C:/repos/app/.mcp.json",
    );
  });

  it("accepts an absolute path, so one config can be shared across repositories", () => {
    expect(resolveMcpConfigPath("C:/repos/app", "C:/shared/.mcp.json", always)).toBe(
      "C:/shared/.mcp.json",
    );
    expect(resolveMcpConfigPath("C:/repos/app", "/etc/mcp.json", always)).toBe(
      "/etc/mcp.json",
    );
  });

  it("normalises backslashes and a trailing separator on the root", () => {
    expect(resolveMcpConfigPath("C:\\repos\\app\\", ".mcp.json", always)).toBe(
      "C:/repos/app/.mcp.json",
    );
  });

  it("returns nothing when disabled, so sessions are unaffected", () => {
    expect(resolveMcpConfigPath("C:/repos/app", "", always)).toBeUndefined();
    expect(resolveMcpConfigPath("C:/repos/app", "   ", always)).toBeUndefined();
  });

  it("returns nothing when the file is absent", () => {
    // Pointing --mcp-config at a missing file makes the CLI fail, taking the
    // whole session with it — worse than having no MCP servers.
    expect(resolveMcpConfigPath("C:/repos/app", ".mcp.json", never)).toBeUndefined();
  });

  it("keeps the leading dot of a dotfile when stripping a './' prefix", () => {
    // A greedy strip of leading dots and slashes turns ".mcp.json" into
    // "mcp.json" — which silently broke the default value.
    expect(resolveMcpConfigPath("C:/repos/app", "./.mcp.json", always)).toBe(
      "C:/repos/app/.mcp.json",
    );
    expect(resolveMcpConfigPath("C:/repos/app", ".mcp.json", always)).toBe(
      "C:/repos/app/.mcp.json",
    );
  });

  it("refuses a path that walks above the repository root", () => {
    // Otherwise a branch could point at a config outside the reviewed tree.
    expect(
      resolveMcpConfigPath("C:/repos/app", "../evil/.mcp.json", always),
    ).toBeUndefined();
    expect(
      resolveMcpConfigPath("C:/repos/app", "config/../../.mcp.json", always),
    ).toBeUndefined();
  });
});

describe("--plugin-dir", () => {
  it("emits one flag per directory", () => {
    const args = buildCliArgs({
      permissionMode: "acceptEdits",
      pluginDirs: ["C:/repo/.git/task-workspaces/runtime-plugin", "C:/other"],
    } as Parameters<typeof buildCliArgs>[0]);

    expect(args.filter((a) => a === "--plugin-dir")).toHaveLength(2);
    expect(args).toContain("C:/repo/.git/task-workspaces/runtime-plugin");
  });

  // Unlike --mcp-config, which is variadic and must stay last, this is repeatable —
  // so it is safe ahead of it. Getting that wrong makes the CLI read the next flag
  // as a config path and die.
  it("does not disturb the trailing --mcp-config", () => {
    const args = buildCliArgs({
      permissionMode: "acceptEdits",
      pluginDirs: ["C:/plugins"],
      mcpConfigPath: "C:/repo/.mcp.json",
    } as Parameters<typeof buildCliArgs>[0]);

    expect(args[args.length - 2]).toBe("--mcp-config");
  });

  it("emits nothing when no plugin directory is given", () => {
    const args = buildCliArgs({ permissionMode: "acceptEdits" } as Parameters<
      typeof buildCliArgs
    >[0]);
    expect(args).not.toContain("--plugin-dir");
  });
});

describe("--tools", () => {
  it("passes the set as separate variadic arguments, not comma-separated", () => {
    // Unlike --disallowed-tools, which takes one comma-joined value.
    const args = buildCliArgs({
      permissionMode: "acceptEdits",
      tools: ["Bash", "Read", "Skill"],
    } as Parameters<typeof buildCliArgs>[0]);

    const at = args.indexOf("--tools");
    expect(at).toBeGreaterThan(-1);
    expect(args.slice(at + 1, at + 4)).toEqual(["Bash", "Read", "Skill"]);
  });

  it("says nothing when none are declared, leaving the CLI's own set", () => {
    // The hand-driven chat case: narrowing a person's tools to the set stages
    // happen to use would be the runtime deciding what a human may do.
    const args = buildCliArgs({ permissionMode: "acceptEdits" } as Parameters<
      typeof buildCliArgs
    >[0]);
    expect(args).not.toContain("--tools");
  });

  it("is not the last flag, since a variadic list needs something to end it", () => {
    const args = buildCliArgs({
      permissionMode: "acceptEdits",
      tools: ["Bash"],
      pluginDirs: ["/abs/plugin"],
    } as Parameters<typeof buildCliArgs>[0]);

    expect(args.indexOf("--tools")).toBeLessThan(args.indexOf("--plugin-dir"));
  });
});

describe("--disallowed-tools", () => {
  it("passes the tools as one comma-separated argument", () => {
    const args = buildCliArgs({
      permissionMode: "acceptEdits",
      disallowedTools: ["Bash", "Write", "Edit"],
    } as Parameters<typeof buildCliArgs>[0]);

    const at = args.indexOf("--disallowed-tools");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("Bash,Write,Edit");
  });

  it("emits nothing when none are given, or all are blank", () => {
    const none = buildCliArgs({ permissionMode: "acceptEdits" } as Parameters<
      typeof buildCliArgs
    >[0]);
    expect(none).not.toContain("--disallowed-tools");

    const blank = buildCliArgs({
      permissionMode: "acceptEdits",
      disallowedTools: ["", "  "],
    } as Parameters<typeof buildCliArgs>[0]);
    expect(blank).not.toContain("--disallowed-tools");
  });

  it("does not disturb the trailing --mcp-config", () => {
    // Same hazard as every other flag here: --mcp-config is variadic, so anything
    // emitted after it is read as another config path.
    const args = buildCliArgs({
      permissionMode: "acceptEdits",
      disallowedTools: ["Bash"],
      mcpConfigPath: "C:/repo/.mcp.json",
    } as Parameters<typeof buildCliArgs>[0]);

    expect(args[args.length - 2]).toBe("--mcp-config");
  });
});

describe("commandForShell", () => {
  const WITH_SPACE = "C:\Users\Conor Watson\.local\bin\claude.exe";

  it("quotes a path containing a space, which is what cmd cuts in half", () => {
    // Measured: unquoted, cmd stops at the space and reports "'C:\Users\Conor' is not
    // recognized" — which reads as the CLI being missing rather than as the path
    // having been truncated.
    expect(commandForShell(WITH_SPACE, true)).toBe(`"${WITH_SPACE}"`);
  });

  it("leaves a bare command alone, because a quoted one does not resolve", () => {
    // The opposite of the permission-gate hook's rule, and the reason this is not
    // quoted unconditionally: `"claude"` is looked for literally and fails, while
    // `claude` resolves against PATH and PATHEXT.
    expect(commandForShell("claude", true)).toBe("claude");
  });

  it("never quotes when no shell will re-parse it", () => {
    // Passed straight as argv, the quotes would become part of the path.
    expect(commandForShell(WITH_SPACE, false)).toBe(WITH_SPACE);
    expect(commandForShell(WITH_SPACE, undefined)).toBe(WITH_SPACE);
  });

  it("tolerates a setting typed with surrounding whitespace", () => {
    expect(commandForShell("  claude  ", true)).toBe("claude");
  });
});
