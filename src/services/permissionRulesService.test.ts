import { describe, it, expect } from "vitest";
import {
  PermissionRulesService,
  SettingsFileSystem,
  LOCAL_SETTINGS_RELATIVE_PATH,
} from "./permissionRulesService";
import { Logger } from "../logging/logger";

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const RULE = "PowerShell(tools/jira/Get-JiraAttachment.ps1:*)";

/** An in-memory settings file, so nothing touches disk. */
function fakeFs(initial?: string) {
  const written: { file: string; contents: string }[] = [];
  const made: string[] = [];
  let current = initial;
  const fileSystem: SettingsFileSystem = {
    read: () => current,
    write: (file, contents) => {
      written.push({ file, contents });
      current = contents;
    },
    mkdirp: (directory) => made.push(directory),
  };
  return { fileSystem, written, made, contents: () => current };
}

describe("PermissionRulesService", () => {
  it("writes a new settings file when none exists", () => {
    const fs = fakeFs(undefined);
    const service = new PermissionRulesService(logger, fs.fileSystem);
    const result = service.addAllowRules("C:/repos/app", [RULE]);

    expect(result.added).toEqual([RULE]);
    expect(result.file.replace(/\\/g, "/")).toBe(
      `C:/repos/app/${LOCAL_SETTINGS_RELATIVE_PATH}`,
    );
    expect(JSON.parse(fs.contents()!)).toEqual({ permissions: { allow: [RULE] } });
    // The .claude directory may not exist yet in a fresh checkout.
    expect(fs.made).toHaveLength(1);
  });

  it("adds to an existing file, keeping the rest of it", () => {
    const fs = fakeFs(
      JSON.stringify({
        enabledPlugins: { "x@y": false },
        permissions: { allow: ["Bash(sqlcmd:*)"] },
      }),
    );
    const service = new PermissionRulesService(logger, fs.fileSystem);
    service.addAllowRules("C:/repos/app", [RULE]);

    expect(JSON.parse(fs.contents()!)).toEqual({
      enabledPlugins: { "x@y": false },
      permissions: { allow: ["Bash(sqlcmd:*)", RULE] },
    });
  });

  it("writes nothing when the rule is already present", () => {
    const fs = fakeFs(JSON.stringify({ permissions: { allow: [RULE] } }));
    const service = new PermissionRulesService(logger, fs.fileSystem);
    const result = service.addAllowRules("C:/repos/app", [RULE]);

    expect(result.added).toEqual([]);
    expect(result.alreadyPresent).toEqual([RULE]);
    expect(fs.written).toHaveLength(0);
  });

  it("refuses to touch a file that is not valid JSON", () => {
    // Overwriting a hand-edited file could revoke grants the user relies on.
    const fs = fakeFs("{ this is not json");
    const service = new PermissionRulesService(logger, fs.fileSystem);
    const result = service.addAllowRules("C:/repos/app", [RULE]);

    expect(result.problem).toContain("not valid JSON");
    expect(result.added).toEqual([]);
    expect(fs.written).toHaveLength(0);
  });

  it("treats an empty file as no settings rather than as broken", () => {
    const fs = fakeFs("   \n");
    const service = new PermissionRulesService(logger, fs.fileSystem);
    const result = service.addAllowRules("C:/repos/app", [RULE]);

    expect(result.problem).toBeUndefined();
    expect(result.added).toEqual([RULE]);
  });

  it("reports a write failure instead of claiming success", () => {
    const fs = fakeFs(undefined);
    const failing: SettingsFileSystem = {
      ...fs.fileSystem,
      write: () => {
        throw new Error("EACCES");
      },
    };
    const service = new PermissionRulesService(logger, failing);
    const result = service.addAllowRules("C:/repos/app", [RULE]);

    expect(result.added).toEqual([]);
    expect(result.problem).toContain("EACCES");
  });

  it("passes a malformed permissions block through as a problem", () => {
    const fs = fakeFs(JSON.stringify({ permissions: "all" }));
    const service = new PermissionRulesService(logger, fs.fileSystem);
    const result = service.addAllowRules("C:/repos/app", [RULE]);

    expect(result.problem).toContain("permissions");
    expect(fs.written).toHaveLength(0);
  });

  it("ends the file with a newline, as a hand-edited file would", () => {
    const fs = fakeFs(undefined);
    new PermissionRulesService(logger, fs.fileSystem).addAllowRules("C:/r", [RULE]);
    expect(fs.contents()!.endsWith("\n")).toBe(true);
  });
});
