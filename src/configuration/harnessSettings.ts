import { CopyEntry } from "../domain/worktreeCopyPlan";

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
