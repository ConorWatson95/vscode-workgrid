import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  PLUGIN_DIR_NAME,
  ProtocolSkillInstaller,
  SkillFileSystem,
} from "./protocolSkillInstaller";
import { PROTOCOL_SKILL, PROTOCOL_SKILL_NAME } from "../agents/protocolSkill";
import { Logger } from "../logging/logger";

const warnings: string[] = [];
const logger: Logger = {
  info: () => {},
  warn: (m) => warnings.push(m),
  error: () => {},
  debug: () => {},
};

const STATE_DIR = path.resolve("C:/repo/.git/task-workspaces");

function fakeFs(existing: Record<string, string> = {}) {
  const files = new Map(Object.entries(existing));
  const writes: string[] = [];
  const fs: SkillFileSystem & { files: Map<string, string>; writes: string[] } = {
    files,
    writes,
    mkdirp: () => {},
    writeFile: (target, contents) => {
      writes.push(target);
      files.set(target, contents);
    },
    readFile: (target) => files.get(target),
  };
  return fs;
}

const skillPath = path.join(
  STATE_DIR,
  PLUGIN_DIR_NAME,
  "skills",
  PROTOCOL_SKILL_NAME,
  "SKILL.md",
);
const manifestPath = path.join(STATE_DIR, PLUGIN_DIR_NAME, ".claude-plugin", "plugin.json");

describe("ProtocolSkillInstaller", () => {
  it("writes the plugin under the state dir and returns the path for --plugin-dir", () => {
    const fs = fakeFs();
    const result = new ProtocolSkillInstaller(logger, fs).install(STATE_DIR);

    expect(result?.pluginDir).toBe(path.join(STATE_DIR, PLUGIN_DIR_NAME));
    expect(fs.files.get(skillPath)).toBe(PROTOCOL_SKILL);
    expect(fs.files.has(manifestPath)).toBe(true);
  });

  // The state directory is watched, and rewriting an identical file on every stage
  // of every task is a stream of change events for something that never changes.
  it("writes nothing when the content already matches", () => {
    const fs = fakeFs();
    const installer = new ProtocolSkillInstaller(logger, fs);
    installer.install(STATE_DIR);
    fs.writes.length = 0;

    installer.install(STATE_DIR);
    expect(fs.writes).toEqual([]);
  });

  // One-directional by design: the moment a local edit survives, protocol drifts per
  // machine — and being invariant is the whole reason it is a skill.
  it("overwrites a locally edited skill rather than merging it", () => {
    const fs = fakeFs({ [skillPath]: "# my own version\n" });
    new ProtocolSkillInstaller(logger, fs).install(STATE_DIR);

    expect(fs.files.get(skillPath)).toBe(PROTOCOL_SKILL);
  });

  // A stage without the skill behaves as it did before the skill existed; the
  // contract it is actually held to is in the prompt. Failing the stage would trade
  // a degraded run for no run.
  it("reports undefined rather than throwing when the write fails", () => {
    const fs = fakeFs();
    fs.writeFile = () => {
      throw new Error("EACCES");
    };
    warnings.length = 0;

    expect(new ProtocolSkillInstaller(logger, fs).install(STATE_DIR)).toBeUndefined();
    expect(warnings[0]).toContain("without it");
  });
});

describe("the protocol skill's content", () => {
  // The split that makes this safe: a skill the model declines to load must not take
  // a parsed marker with it, or the reply parses as silence — which for deferrals and
  // plan steps is the exact failure those markers exist to catch.
  it("states no marker the parsers depend on", () => {
    for (const marker of ["VERDICT:", "DEFERRED:", "HANDOFF:", "STEP 1:"]) {
      expect(PROTOCOL_SKILL).not.toContain(marker);
    }
  });

  // A skill that learned the project would be the giant prompt in a new location, and
  // would stop being shareable between projects.
  it("carries no project knowledge", () => {
    for (const leak of ["QubeData", "qubeautoapp", ".taskworkspaces", "promote/"]) {
      expect(PROTOCOL_SKILL).not.toContain(leak);
    }
  });

  it("declares front matter the model can match on", () => {
    expect(PROTOCOL_SKILL.startsWith("---\n")).toBe(true);
    expect(PROTOCOL_SKILL).toContain(`name: ${PROTOCOL_SKILL_NAME}`);
    expect(PROTOCOL_SKILL).toContain("description:");
  });
});
