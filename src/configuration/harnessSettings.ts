import { CopyEntry } from "../domain/worktreeCopyPlan";
import { SiblingLinkEntry } from "../domain/siblingLinkPlan";

/**
 * Every setting the harness reads, with its default and its normalisation.
 *
 * Split from `ExtensionConfiguration` so the rules — what an empty string falls
 * back to, which values are clamped, which key defers to an older one — are
 * testable and reachable without an editor. The *source* of values is the only
 * part that differs between a VS Code window and a headless run, and it is a
 * one-method interface.
 */

/**
 * A bound source of setting values: scope, if the caller has one, is already
 * applied. `vscode.WorkspaceConfiguration` satisfies this shape as-is.
 */
export interface SettingsReader {
  get<T>(key: string, fallback: T): T;
}

const DEFAULT_BRANCH_PREFIXES = [
  "feature",
  "bug",
  "fix",
  "perf",
  "refactor",
  "chore",
];

/**
 * Tools the gate hook is installed for. Others never reach it, so they cost
 * nothing — which is why this is a list rather than "everything".
 */
const DEFAULT_GATED_TOOLS = ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit"];

export type AgentMode = "native" | "chat" | "terminal";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type ContextStrategy = "compact" | "checkpoint";

export class HarnessSettings {
  constructor(private readonly reader: SettingsReader) {}

  private text(key: string, fallback = ""): string {
    const value = this.reader.get<string>(key, fallback);
    return typeof value === "string" ? value.trim() : fallback;
  }

  /** Trimmed value, or `fallback` when it is empty. */
  private textOr(key: string, fallback: string): string {
    return this.text(key, fallback) || fallback;
  }

  /** Positive number, or `fallback` when absent, zero, negative or not finite. */
  private positive(key: string, fallback: number): number {
    const value = this.reader.get<number>(key, fallback);
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  }

  private list(key: string, fallback: string[]): string[] {
    const configured = this.reader.get<string[]>(key, []);
    const cleaned = (Array.isArray(configured) ? configured : [])
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return cleaned.length > 0 ? cleaned : fallback;
  }

  private flag(key: string, fallback: boolean): boolean {
    const value = this.reader.get<boolean>(key, fallback);
    return typeof value === "boolean" ? value : fallback;
  }

  worktreeParentDir(): string {
    return this.text("worktreeParentDir");
  }

  branchPrefixes(): string[] {
    return this.list("branchPrefixes", DEFAULT_BRANCH_PREFIXES);
  }

  defaultBaseBranch(): string {
    return this.text("defaultBaseBranch");
  }

  /**
   * Files and directories copied into every new worktree. A fresh worktree lacks
   * everything git does not track, so untracked local config has to be brought
   * across or an agent behaves differently there than in the main checkout.
   */
  copyIntoWorktree(): CopyEntry[] {
    const entries = this.reader.get<CopyEntry[]>("copyIntoWorktree", []);
    return Array.isArray(entries) ? entries : [];
  }

  /**
   * Sibling repositories to link beside the worktrees.
   *
   * A project referencing a sibling by relative path — `..\..\QubeData\Qube.csproj`
   * — resolves correctly from a checkout next to that sibling and incorrectly from a
   * worktree one level deeper. A `Directory.Build.props` can probe and fix *project*
   * references; a `.sln` cannot, because solution files take no MSBuild properties.
   * A link in the worktree parent restores the layout those checked-in paths assume.
   */
  linkSiblings(): SiblingLinkEntry[] {
    const entries = this.reader.get<SiblingLinkEntry[]>("linkSiblings", []);
    return Array.isArray(entries) ? entries : [];
  }

  /**
   * Location of the project's review-rules file. Empty means the conventional
   * path inside the repository.
   */
  reviewRulesPath(): string {
    return this.text("reviewRulesPath");
  }

  /**
   * Location of the project's harness config (routes + review rules). Falls back
   * to the older `reviewRulesPath` when only that is set, so an existing
   * configuration keeps working.
   */
  harnessConfigPath(): string {
    return this.text("harnessConfigPath") || this.reviewRulesPath();
  }

  claudeCommand(): string {
    return this.textOr("claudeCommand", "claude");
  }

  agentMode(): AgentMode {
    return this.reader.get<AgentMode>("agentMode", "native");
  }

  permissionMode(): PermissionMode {
    return this.reader.get<PermissionMode>("permissionMode", "acceptEdits");
  }

  /** Model alias/id for chat sessions ("" = CLI default). */
  model(): string {
    return this.text("model");
  }

  trackNativeActivity(): boolean {
    return this.flag("trackNativeActivity", true);
  }

  compactPromptThreshold(): number {
    return this.reader.get<number>("compactPromptThreshold", 120000);
  }

  /**
   * What to do when a session crosses `autoCompactThreshold`: summarise in place
   * ("compact") or write a handoff and continue in a fresh session
   * ("checkpoint"). Checkpointing keeps carried-forward context bounded.
   */
  contextStrategy(): ContextStrategy {
    return this.reader.get<ContextStrategy>("contextStrategy", "compact");
  }

  autoCompactThreshold(): number {
    return this.reader.get<number>("autoCompactThreshold", 0);
  }

  /**
   * Whether a refused tool call stops the route so the permission can be granted.
   *
   * On by default: a stage that could not run a command it judged necessary has
   * not done its job, and carrying on buries that behind whatever it did instead.
   */
  pauseOnPermissionDenial(): boolean {
    return this.flag("pauseOnPermissionDenial", true);
  }

  /**
   * Whether answering a stage's questions advances the route by itself.
   *
   * On by default: answering is already deliberate, and unblocking the route is
   * the only reason to do it. Leaving it stopped behind one more button press is
   * how a task sits idle overnight.
   */
  advanceAfterAnswering(): boolean {
    return this.flag("advanceAfterAnswering", true);
  }

  /**
   * What runs the gate's hook script.
   *
   * Node rather than a shell, because the script has to poll a directory and
   * answer on stdout, and a portable shell script that does that does not exist
   * across cmd, PowerShell and bash. Configurable for the case where node is
   * installed somewhere off PATH.
   */
  gateInterpreter(): string {
    return this.textOr("gateInterpreter", "node");
  }

  /**
   * Whether a stage may ask the user a question without ending its session.
   *
   * On by default. Off falls back to the NEEDS-INFO reply, which still works but
   * re-runs the subtask once answered.
   */
  interactiveQuestions(): boolean {
    return this.flag("interactiveQuestions", true);
  }

  /** Whether a refused tool call is held open for approval instead of failing. */
  interactivePermissions(): boolean {
    return this.flag("interactivePermissions", true);
  }

  gatedTools(): string[] {
    return this.list("gatedTools", DEFAULT_GATED_TOOLS);
  }

  /**
   * How long a held call may wait, in minutes.
   *
   * Enforced by the CLI's own hook timeout. Verified honoured to well past four
   * minutes; the default leaves room for a person who has stepped away briefly.
   */
  permissionWaitMinutes(): number {
    return this.positive("permissionWaitMinutes", 15);
  }

  /**
   * Hold every gated call rather than only capabilities already refused.
   *
   * Off by default: the pass-by-default gate exists so safe reads are not stopped
   * and so this extension does not have to guess at the CLI's own idea of a safe
   * command.
   */
  holdEveryToolCall(): boolean {
    return this.flag("holdEveryToolCall", false);
  }

  /**
   * Where the project keeps its own documentation, named to every stage.
   *
   * Empty disables the guidance entirely — a project with no documentation
   * convention should not be told to invent one mid-task.
   */
  projectDocsPath(): string {
    return this.text("projectDocsPath", "docs/");
  }

  /**
   * MCP config to load explicitly into every session, relative to the
   * repository root (or absolute). Empty disables it.
   *
   * Read from the **repository root**, never the worktree, for the same reason
   * review rules are: MCP servers grant tool access, and a branch must not be
   * able to hand itself new capabilities by editing a file.
   */
  mcpConfigPath(): string {
    return this.text("mcpConfigPath", ".mcp.json");
  }

  /**
   * Servers from the project's MCP config that **stage** sessions load. Empty
   * means all of them.
   *
   * Every subtask is a fresh CLI, and the CLI starts every server in the config
   * before its first event. A stage pays that twice over — the startup wait, and
   * the tool definitions each server injects into the context of a session that
   * will never call them. A build stage does not need a set of database servers
   * to compile something.
   *
   * Worse when a server cannot connect, since the CLI waits out a timeout each:
   * one project measured nine servers, eight unreachable, at 182 seconds before
   * any work began. But the cost is real even when every server is healthy.
   *
   * Only ever removes servers, so it cannot be used to widen what a branch can
   * reach — which is why it is safe alongside reading the config from the
   * repository root.
   */
  stageMcpServers(): string[] {
    // No default set: an empty list means "no opinion", and must not be confused
    // with "no servers", which would strip every stage's tools.
    return this.list("stageMcpServers", []);
  }

  /**
   * Hard stop for one subtask, so a hung CLI cannot stall a route forever.
   *
   * Generous by default: a planning stage on a large repository legitimately
   * takes tens of minutes, and per-process overhead on the host machine (virus
   * scanning on spawn, most often) can multiply that several times over. A cap
   * that fires during normal work is worse than no cap, because the stage is
   * recorded as failed.
   */
  stageTimeoutMinutes(): number {
    return this.positive("stageTimeoutMinutes", 45);
  }

  /**
   * How long a stage may block on an `ask_user` question before the CLI gives up on it.
   *
   * Deliberately longer than `stageTimeoutMinutes`, which is the wrong bound for this:
   * that cap is about a *hung CLI*, and a stage waiting on a person is not hung. The
   * point of the harness is one engineer supervising several tasks, so a question
   * waiting while they work on another one is the designed case. Left at the CLI's own
   * default the call times out, the agent proceeds on assumptions, and the stage that
   * asked because it did not know is recorded as done.
   */
  askTimeoutMinutes(): number {
    return this.positive("askTimeoutMinutes", 120);
  }

  /**
   * How many subagents one stage session may run at once.
   *
   * The harness owns concurrency, and it owns it at the *task* level: the point
   * of the thing is one person supervising several tasks at once. Left at the
   * CLI's own default a single stage may run twenty subagents, which does not
   * make that stage twenty times faster — it makes the other tasks wait, on a
   * machine and a rate limit they all share. Capping here converts an invisible
   * loss of throughput into a slightly slower stage.
   *
   * Not zero-able: zero would read as "no subagents" but reaches the CLI as a
   * limit it may treat as unset, which is the opposite of what was asked for.
   */
  stageSubagentConcurrency(): number {
    return this.positive("stageSubagentConcurrency", 3);
  }

  /**
   * How deep subagent spawning may nest within a stage.
   *
   * One level by default: a stage delegating to subagents is normal, a subagent
   * delegating further is a tree whose cost and duration nothing in the harness
   * predicted. Deep nesting is also the case where the CLI's own default (three)
   * multiplies against the concurrency cap rather than adding to it.
   */
  stageSubagentDepth(): number {
    return this.positive("stageSubagentDepth", 1);
  }
}

/**
 * Reads settings from a plain object, for headless callers and tests. Absent
 * keys fall through to each setting's default rather than to `undefined`.
 */
export function recordSettingsReader(
  values: Record<string, unknown> = {},
): SettingsReader {
  return {
    get<T>(key: string, fallback: T): T {
      const value = values[key];
      return value === undefined || value === null ? fallback : (value as T);
    },
  };
}
