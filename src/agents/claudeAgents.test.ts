import { describe, it, expect } from "vitest";
import {
  parseAgentsJson,
  normalizeWorktreePath,
  sessionsForWorktree,
  LiveAgentSession,
} from "./claudeAgents";

/** Shape taken verbatim from real `claude agents --json` output. */
const REAL_OUTPUT = `[
  {
    "pid": 37016,
    "cwd": "c:\\\\Dev\\\\vscode-workgrid",
    "kind": "interactive",
    "startedAt": 1785133841127,
    "sessionId": "fa672133-6219-4347-9cb6-ad031543e456",
    "name": "vscode-workgrid-d1"
  },
  {
    "pid": 67104,
    "cwd": "C:\\\\Dev\\\\qubeautoapp",
    "kind": "interactive",
    "startedAt": 1785143185179,
    "sessionId": "2b63f045-c30f-4cc4-b5a4-9cad44011f45",
    "name": "qubeautoapp-22"
  }
]`;

const session = (cwd: string, sessionId = "s1"): LiveAgentSession => ({
  pid: 1,
  cwd,
  kind: "interactive",
  startedAt: 0,
  sessionId,
  name: "n",
});

describe("parseAgentsJson", () => {
  it("parses real CLI output", () => {
    const s = parseAgentsJson(REAL_OUTPUT);
    expect(s).toHaveLength(2);
    expect(s[0].sessionId).toBe("fa672133-6219-4347-9cb6-ad031543e456");
    expect(s[0].cwd).toBe("c:\\Dev\\vscode-workgrid");
    expect(s[0].pid).toBe(37016);
    expect(s[1].name).toBe("qubeautoapp-22");
  });

  it("tolerates leading noise before the JSON array", () => {
    const noisy = `(node:123) DeprecationWarning: url.parse()\n${REAL_OUTPUT}`;
    expect(parseAgentsJson(noisy)).toHaveLength(2);
  });

  it("returns empty for malformed, empty or non-array output", () => {
    expect(parseAgentsJson("")).toEqual([]);
    expect(parseAgentsJson("not json")).toEqual([]);
    expect(parseAgentsJson("[oops")).toEqual([]);
    expect(parseAgentsJson('{"cwd":"x"}')).toEqual([]);
  });

  it("returns empty for an empty session list", () => {
    expect(parseAgentsJson("[]")).toEqual([]);
  });

  it("drops entries missing the reuse key", () => {
    const partial = '[{"pid":1,"cwd":"c:\\\\a"},{"sessionId":"ok","cwd":"c:\\\\b"}]';
    const s = parseAgentsJson(partial);
    expect(s).toHaveLength(1);
    expect(s[0].sessionId).toBe("ok");
  });

  it("defaults absent optional fields rather than dropping the entry", () => {
    const s = parseAgentsJson('[{"sessionId":"x","cwd":"c:\\\\a"}]');
    expect(s[0]).toMatchObject({ pid: -1, kind: "unknown", startedAt: 0, name: "x" });
  });
});

describe("normalizeWorktreePath", () => {
  it("is case-insensitive and separator-agnostic", () => {
    expect(normalizeWorktreePath("C:\\Dev\\Repo")).toBe(normalizeWorktreePath("c:/dev/repo"));
  });
  it("ignores trailing and duplicated separators", () => {
    expect(normalizeWorktreePath("C:\\Dev\\Repo\\")).toBe(normalizeWorktreePath("C:\\Dev\\Repo"));
    expect(normalizeWorktreePath("C:\\\\Dev//Repo")).toBe(normalizeWorktreePath("C:\\Dev\\Repo"));
  });
});

describe("sessionsForWorktree", () => {
  it("matches regardless of drive-letter case (the CLI mixes them)", () => {
    const found = sessionsForWorktree(parseAgentsJson(REAL_OUTPUT), "C:\\Dev\\vscode-workgrid");
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("vscode-workgrid-d1");
  });

  it("does not match a sibling sharing a name prefix", () => {
    // The CLI's own --cwd filter is segment-aware; ours must be too.
    const all = [session("C:\\Dev\\repo"), session("C:\\Dev\\repo-worktree", "s2")];
    const found = sessionsForWorktree(all, "C:\\Dev\\repo");
    expect(found).toHaveLength(1);
    expect(found[0].cwd).toBe("C:\\Dev\\repo");
  });

  it("does not match descendants, unlike the CLI's recursive --cwd filter", () => {
    const all = [session("C:\\Dev\\repo\\nested-worktree")];
    expect(sessionsForWorktree(all, "C:\\Dev\\repo")).toEqual([]);
  });

  it("returns every session sharing the exact worktree", () => {
    const all = [session("C:\\Dev\\repo", "a"), session("c:/dev/repo", "b"), session("C:\\Other", "c")];
    expect(sessionsForWorktree(all, "C:\\Dev\\repo").map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("returns empty when nothing matches", () => {
    expect(sessionsForWorktree(parseAgentsJson(REAL_OUTPUT), "C:\\Nope")).toEqual([]);
  });
});
