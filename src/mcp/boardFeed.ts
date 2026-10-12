import { RunSnapshot, RunSummary } from "../ui/harnessSnapshot";
import { SuggestionBoard } from "../services/suggestionControlService";

/**
 * One line of the board feed: `node harnessMcpServer.js --repo <path> --watch`.
 *
 * The feed exists for a host that can read a child's output but cannot hold a
 * conversation with it — a Claude Code mod's `$.process.spawn` writes stdin once
 * and closes it. So the server pushes instead of answering: the whole board on
 * every change, and a run's snapshot only when that run moved, which keeps the
 * steady state to a 15KB line while still letting the pane open any run without
 * asking for it.
 */
export type FeedMessage =
  | { type: "board"; repositoryRoot: string; runs: RunSummary[] }
  | { type: "run"; run: RunSnapshot }
  | { type: "gone"; taskId: string }
  | { type: "suggestions"; board: SuggestionBoard };

export interface BoardSource {
  readBoard(): Promise<{ runs: RunSummary[]; snapshots: RunSnapshot[] }>;
}

/** Suggested work, when the project has a way to read it. */
export interface SuggestionSourceOfBoard {
  board(): Promise<SuggestionBoard>;
}

/**
 * Remembers what it last sent, and turns each read of the store into the
 * messages that bring a reader up to date.
 *
 * Every message is derived; the feed holds nothing a reader could not get by
 * reading the state file itself, so a pane that restarts loses nothing but
 * time — it starts a new feed and is sent everything again.
 */
export class BoardFeed {
  private board: string | undefined;
  private suggestionBoard: string | undefined;
  // The whole snapshot, not its `revision`: that hashes the pipeline alone, and a
  // run's row also reads task fields — its name, its ticket, a reply on it.
  private readonly sent = new Map<string, string>();

  constructor(
    private readonly source: BoardSource,
    private readonly repositoryRoot: string,
    private readonly suggestions?: SuggestionSourceOfBoard,
  ) {}

  async poll(): Promise<FeedMessage[]> {
    const { runs, snapshots } = await this.source.readBoard();
    const messages: FeedMessage[] = [];

    for (const run of snapshots) {
      const body = JSON.stringify(run);
      if (this.sent.get(run.taskId) === body) continue;
      this.sent.set(run.taskId, body);
      messages.push({ type: "run", run });
    }
    const present = new Set(snapshots.map((run) => run.taskId));
    for (const taskId of [...this.sent.keys()]) {
      if (present.has(taskId)) continue;
      this.sent.delete(taskId);
      messages.push({ type: "gone", taskId });
    }

    // The board goes last, so a reader that redraws on it already holds every
    // run the board can send them to.
    const board = JSON.stringify(runs);
    if (board !== this.board) {
      this.board = board;
      messages.push({ type: "board", repositoryRoot: this.repositoryRoot, runs });
    }

    // Read on every poll because a scan changes its own file, not the state file, and
    // a started task changes which items are still offered.
    if (this.suggestions) {
      const board = await this.suggestions.board();
      const body = JSON.stringify(board);
      if (body !== this.suggestionBoard) {
        this.suggestionBoard = body;
        messages.push({ type: "suggestions", board });
      }
    }
    return messages;
  }
}
