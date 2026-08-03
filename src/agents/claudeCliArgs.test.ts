import { describe, it, expect } from "vitest";
import { buildCliArgs, resolveMcpConfigPath } from "./claudeCliArgs";

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

    it("never adds --strict-mcp-config, which would drop user-scope servers", () => {
      const args = buildCliArgs({ ...BASE, mcpConfigPath: "C:/repo/.mcp.json" });
      expect(args).not.toContain("--strict-mcp-config");
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
      });
      expect(args[args.length - 2]).toBe("--mcp-config");
      expect(args[args.length - 1]).toBe("C:/repo/.mcp.json");
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
