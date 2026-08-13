import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { createTaskWorkspaceCommand } from "./createTaskWorkspaceCommand";
import { loadHarness } from "../services/reviewRulesService";
import { scanFailures, scannedSuggestions } from "../services/suggestionScanService";
import { SuggestionTreeItem } from "../ui/taskWorkspaceTreeItem";
import { withStatus } from "../ui/statusProgress";

/**
 * Commands for suggested work: scanning for it, and turning one into a task.
 *
 * Scanning is a command rather than something that happens on activation. A scan is a
 * paid session, and one on every window reload spends money and a rate limit on a list
 * nobody asked for — which is also what lets the result live in memory, since it is
 * exactly as old as the last time you asked.
 */

export async function scanForWorkCommand(ctx: CommandContext): Promise<void> {
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) {
    void vscode.window.showErrorMessage(
      "No Git repository is open. Open a repository folder first.",
    );
    return;
  }
  if (!ctx.suggestionScans) {
    void vscode.window.showWarningMessage(
      "Scanning for work is unavailable: no agent session could be prepared.",
    );
    return;
  }

  const harness = loadHarness(repositoryRoot, {
    configuredPath: ctx.configuration.harnessConfigPath(ctx.repositoryUri()),
  });
  for (const problem of harness.problems) ctx.logger.warn(`Harness config: ${problem}`);

  if (harness.suggestionSources.length === 0) {
    // Said as a thing to configure rather than a failure. There is no default source and
    // there should not be: guessing at where a team's work lives is the one thing this
    // feature must not do.
    void vscode.window.showInformationMessage(
      "No suggestion sources are configured for this project.",
      { modal: false },
      "How?",
    ).then((choice) => {
      if (choice === "How?") {
        void vscode.window.showInformationMessage(
          'Add a "suggestions" array to .taskworkspaces/harness.json: each entry needs ' +
            'an "id", a "scanPrompt" saying which work counts, the ' +
            '"requiredMcpServers" that prompt needs, and the "ranks" its source uses.',
          { modal: true },
        );
      }
    });
    return;
  }

  const result = await withStatus("Scanning for work", async (step) => {
    step(`${harness.suggestionSources.length} source(s)`);
    return ctx.suggestionScans!.scan(repositoryRoot, harness.suggestionSources);
  });

  ctx.tree.refresh();

  const failures = scanFailures(result);
  const found = scannedSuggestions(result).length;
  if (failures.length > 0) {
    // Surfaced, never swallowed: a source that failed produces an empty list, and an
    // empty list presented as an answer reads as a quiet morning.
    for (const failure of failures) ctx.logger.warn(`Suggestion scan: ${failure}`);
    void vscode.window.showWarningMessage(
      `Scan finished with ${failures.length} source(s) failing: ${failures.join("; ")}`,
    );
    return;
  }
  void vscode.window.showInformationMessage(
    found === 0
      ? "Nothing outstanding in your sources."
      : `${found} suggestion(s) found.`,
  );
}

/**
 * Starts a task from a suggestion.
 *
 * Goes through the ordinary create flow with the suggestion's details filled in, rather
 * than a shortcut of its own. The route choice, the "has any of this been done?"
 * question and the brief all still apply — a task started from a ticket is not a
 * different kind of task, and a second creation path would be a second place for those
 * questions to drift out of step.
 */
export async function startTaskFromSuggestionCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const item = arg instanceof SuggestionTreeItem ? arg : undefined;
  if (!item) return;
  const { suggestion } = item;

  await createTaskWorkspaceCommand(ctx, {
    name: suggestion.title,
    // The brief leads with the reference and the link, because every stage of this
    // project's routes is required to lead its commit subject with the ticket URL — and
    // a cold session cannot find either anywhere else.
    description: [
      suggestion.ref,
      suggestion.url,
      suggestion.detail,
    ]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join(" — "),
    origin: {
      sourceId: suggestion.sourceId,
      ref: suggestion.ref,
      ...(suggestion.url ? { url: suggestion.url } : {}),
      at: new Date().toISOString(),
    },
  });
}

/** Opens the suggestion in its own system, when it came with a link. */
export async function openSuggestionCommand(arg: unknown): Promise<void> {
  const item = arg instanceof SuggestionTreeItem ? arg : undefined;
  const url = item?.suggestion.url;
  if (!url) return;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
