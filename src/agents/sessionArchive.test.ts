import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionArchive } from "./sessionArchive";

describe("SessionArchive", () => {
  let home: string;
  let base: string;
  let projectDir: string;
  const worktree = "C:/Temp/myrepo-task";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-arch-home-"));
    base = fs.mkdtempSync(path.join(os.tmpdir(), "tw-arch-base-"));
    projectDir = path.join(home, ".claude", "projects", "c--Temp-myrepo-task");
    fs.mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("copies transcripts and extracts titles", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "ai-title", aiTitle: "Greeting session" }),
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "sess-1.jsonl"), lines + "\n");

    const archive = new SessionArchive(base);
    const result = archive.archiveWorktree(home, worktree, "task-1");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("sess-1");
    expect(result[0].title).toBe("Greeting session");
    // File was copied into the durable base dir.
    expect(fs.existsSync(result[0].file)).toBe(true);
    expect(result[0].file.startsWith(base)).toBe(true);
  });

  it("loads archived items back", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "archived reply" }] } }),
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "s.jsonl"), lines + "\n");

    const archive = new SessionArchive(base);
    const [session] = archive.archiveWorktree(home, worktree, "t");
    const items = archive.loadItems(session.file);
    expect(items).toEqual([{ kind: "assistant", text: "archived reply" }]);
  });

  it("returns nothing when the worktree has no transcripts", () => {
    const archive = new SessionArchive(base);
    expect(archive.archiveWorktree(home, "C:/Temp/other", "x")).toEqual([]);
  });
});
