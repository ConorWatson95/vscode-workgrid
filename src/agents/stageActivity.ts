import { ChatItem } from "./streamJson";
import { redactSecrets } from "../domain/secretRedaction";

/**
 * Collects what a stage actually did, so it can be seen afterwards.
 *
 * A stage session is invisible: it runs headless, its transcript is discarded
 * once parsed, and the only thing kept was whether it claimed success. So a
 * deployment preview that produced pages of output left nothing behind, and the
 * only way to see what it would have done was to run the command again by hand.
 *
 * What is worth keeping is narrow: the reply, the tools used, the commands run and
 * the files touched. That answers "what did this stage do" without storing a whole
 * transcript per subtask in a JSON file that has to be read and rewritten whole.
 *
 * Pure and vscode-free.
 */

export interface StageActivity {
  /** Tool name to how many times it was called. */
  toolCounts: Record<string, number>;
  /**
   * Shell commands run, in order, deduplicated.
   *
   * Kept verbatim because the point is being able to re-run one by hand, or see
   * that the wrong flags were passed — which is exactly how a deployment ran
   * against every project instead of one.
   */
  commands: string[];
  /** Files the stage wrote or edited. */
  pathsWritten: string[];
  /** Files it read, which is how you tell what it based a decision on. */
  pathsRead: string[];
  /** Text the tools returned, capped. Empty when nothing notable came back. */
  output: string;
}

/** Tools whose argument is a command rather than a path. */
const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "Shell", "BashOutput"]);
/** Tools that change a file. */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);
/** Tools that only look. */
const READ_TOOLS = new Set(["Read", "NotebookRead"]);

/**
 * Total kept output, in characters.
 *
 * Bounded because this is persisted in the task state file, which is read and
 * rewritten whole on every update — an unbounded transcript there would make
 * every write more expensive for the life of the task. Generous enough to hold a
 * deployment preview, which is the case that prompted keeping any of it.
 */
export const MAX_OUTPUT_CHARS = 20000;

/**
 * Accumulates activity from a live stream.
 *
 * Fed the same items as `DenialWatcher`, from the same subscription — the stage
 * runner already listens, so this costs nothing extra.
 */
export class StageActivityWatcher {
  private readonly toolCounts: Record<string, number> = {};
  private readonly commands: string[] = [];
  private readonly written: string[] = [];
  private readonly read: string[] = [];
  private readonly chunks: string[] = [];
  private outputChars = 0;
  private truncated = false;
  /** The call a result belongs to: items carry no ids, so it is the last `tool`. */
  private pending?: { name: string; detail?: string };

  observe(item: ChatItem): void {
    if (item.kind === "tool") {
      this.pending = { name: item.name, detail: item.detail };
      this.toolCounts[item.name] = (this.toolCounts[item.name] ?? 0) + 1;
      this.record(item.name, item.detail);
      return;
    }
    if (item.kind !== "tool-result") return;

    // Only command output is kept. File reads are recoverable from the repository
    // and would swamp the useful part; an edit's result is a confirmation.
    const owner = this.pending?.name;
    if (!owner || !COMMAND_TOOLS.has(owner)) return;
    this.append(this.pending?.detail, item.text, item.isError);
  }

  private record(tool: string, detail: string | undefined): void {
    // Masked here, at the point of capture, not only where it is displayed: this
    // object is persisted in the task state file, and a route that builds a
    // connection string from a profile put a live password on disk in plaintext.
    const value = redactSecrets(detail?.trim() ?? "");
    if (!value) return;
    if (COMMAND_TOOLS.has(tool)) {
      if (!this.commands.includes(value)) this.commands.push(value);
      return;
    }
    if (WRITE_TOOLS.has(tool)) {
      if (!this.written.includes(value)) this.written.push(value);
      return;
    }
    if (READ_TOOLS.has(tool)) {
      if (!this.read.includes(value)) this.read.push(value);
    }
  }

  private append(
    command: string | undefined,
    text: string,
    isError: boolean | undefined,
  ): void {
    if (this.truncated) return;
    // Output as well as the command: a script that echoes its own connection
    // string, or an error quoting the failed one, leaks exactly the same value.
    const body = redactSecrets(text.trim());
    if (!body) return;
    const header = `$ ${redactSecrets(command ?? "(command)")}${isError ? "   [failed]" : ""}`;
    const block = `${header}\n${body}`;
    // Truncation is announced rather than silent: output that stops mid-stream
    // with no explanation reads as the command having stopped there.
    if (this.outputChars + block.length > MAX_OUTPUT_CHARS) {
      const room = Math.max(0, MAX_OUTPUT_CHARS - this.outputChars);
      if (room > header.length + 40) {
        this.chunks.push(`${block.slice(0, room)}\n…output truncated here.`);
      } else {
        this.chunks.push("…further output omitted.");
      }
      this.truncated = true;
      return;
    }
    this.chunks.push(block);
    this.outputChars += block.length;
  }

  /** Everything gathered so far. Safe to call while the stage is still running. */
  result(): StageActivity {
    return {
      toolCounts: { ...this.toolCounts },
      commands: [...this.commands],
      pathsWritten: [...this.written],
      pathsRead: [...this.read],
      output: this.chunks.join("\n\n"),
    };
  }

  /** True when nothing worth recording happened, so nothing need be persisted. */
  isEmpty(): boolean {
    return (
      Object.keys(this.toolCounts).length === 0 && this.chunks.length === 0
    );
  }
}
