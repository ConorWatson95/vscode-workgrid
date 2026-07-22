import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanSlashCommands, BUILTIN_SLASH_COMMANDS } from "./slashCommands";

describe("scanSlashCommands", () => {
  let root: string;
  let projectDir: string;
  let userDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tw-slash-"));
    projectDir = path.join(root, "project", ".claude", "commands");
    userDir = path.join(root, "user", ".claude", "commands");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("discovers top-level and namespaced project commands", () => {
    fs.writeFileSync(path.join(projectDir, "plan.md"), "");
    fs.mkdirSync(path.join(projectDir, "git"));
    fs.writeFileSync(path.join(projectDir, "git", "commit.md"), "");

    const names = scanSlashCommands(projectDir, userDir).map((c) => c.name);
    expect(names).toContain("/plan");
    expect(names).toContain("/git:commit");
  });

  it("includes built-ins and user commands", () => {
    fs.writeFileSync(path.join(userDir, "notes.md"), "");
    const cmds = scanSlashCommands(projectDir, userDir);
    expect(cmds.find((c) => c.name === "/notes")?.source).toBe("user");
    for (const b of BUILTIN_SLASH_COMMANDS) {
      expect(cmds.some((c) => c.name === b)).toBe(true);
    }
  });

  it("lets project commands win over user commands on name clashes", () => {
    fs.writeFileSync(path.join(projectDir, "dup.md"), "");
    fs.writeFileSync(path.join(userDir, "dup.md"), "");
    const dup = scanSlashCommands(projectDir, userDir).filter((c) => c.name === "/dup");
    expect(dup).toHaveLength(1);
    expect(dup[0].source).toBe("project");
  });

  it("returns only built-ins when directories are absent", () => {
    const cmds = scanSlashCommands(path.join(root, "none1"), path.join(root, "none2"));
    expect(cmds.map((c) => c.name).sort()).toEqual([...BUILTIN_SLASH_COMMANDS].sort());
  });
});
