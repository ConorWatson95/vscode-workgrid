import { describe, expect, it } from "vitest";
import { RunSnapshot, RunSummary } from "../ui/harnessSnapshot";
import { BoardFeed, BoardSource } from "./boardFeed";

function run(taskId: string, name = taskId, revision = "r1"): RunSnapshot {
  return { taskId, name, revision } as unknown as RunSnapshot;
}

class FakeSource implements BoardSource {
  snapshots: RunSnapshot[] = [];
  async readBoard(): Promise<{ runs: RunSummary[]; snapshots: RunSnapshot[] }> {
    const runs = this.snapshots.map((s) => ({ taskId: s.taskId, name: s.name }) as RunSummary);
    return { runs, snapshots: this.snapshots };
  }
}

describe("BoardFeed", () => {
  it("sends every run and then the board on the first poll", async () => {
    const source = new FakeSource();
    source.snapshots = [run("a"), run("b")];
    const messages = await new BoardFeed(source, "/repo").poll();
    expect(messages.map((m) => m.type)).toEqual(["run", "run", "board"]);
    expect(messages[2]).toMatchObject({ repositoryRoot: "/repo" });
  });

  it("sends nothing when nothing changed", async () => {
    const source = new FakeSource();
    source.snapshots = [run("a")];
    const feed = new BoardFeed(source, "/repo");
    await feed.poll();
    expect(await feed.poll()).toEqual([]);
  });

  it("sends only the run that moved, and the board only if its rows did", async () => {
    const source = new FakeSource();
    source.snapshots = [run("a"), run("b")];
    const feed = new BoardFeed(source, "/repo");
    await feed.poll();

    source.snapshots = [run("a"), run("b", "b", "r2")];
    const messages = await feed.poll();
    expect(messages).toEqual([{ type: "run", run: source.snapshots[1] }]);
  });

  // The revision hashes the pipeline alone, so diffing on it would miss a rename.
  it("treats a change outside the pipeline as a change", async () => {
    const source = new FakeSource();
    source.snapshots = [run("a")];
    const feed = new BoardFeed(source, "/repo");
    await feed.poll();

    source.snapshots = [run("a", "renamed")];
    expect((await feed.poll()).map((m) => m.type)).toEqual(["run", "board"]);
  });

  it("says a run has gone, before the board that no longer lists it", async () => {
    const source = new FakeSource();
    source.snapshots = [run("a"), run("b")];
    const feed = new BoardFeed(source, "/repo");
    await feed.poll();

    source.snapshots = [run("a")];
    const messages = await feed.poll();
    expect(messages.map((m) => m.type)).toEqual(["gone", "board"]);
    expect(messages[0]).toEqual({ type: "gone", taskId: "b" });
  });
});
