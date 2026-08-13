import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { createTaskWorkspaceCommand } from "./createTaskWorkspaceCommand";
import { loadHarness } from "../services/reviewRulesService";
import { scanFailures, scannedSuggestions } from "../services/suggestionScanService";
import { SuggestionTreeItem } from "../ui/taskWorkspaceTreeItem";
import { withStatus } from "../ui/statusProgress";
import { TaskWorkspace } from "../domain/taskWorkspace";

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

/**
 * Links a suggestion to a task that already exists.
 *
 * The case creating a task cannot serve, and the commoner one on a repository with work
 * already in it: a task adopted from a branch, or started before a source was
 * configured, has no origin — so the ticket it is plainly for goes on being offered as
 * work nobody has picked up, and a suggestion list that offers you what you are already
 * doing is one you stop reading.
 *
 * Only tasks with no origin are offered. Repointing an existing link is refused by the
 * service rather than handled here, because it is a change nobody could see afterwards;
 * unlinking is its own deliberate act.
 */
export async function linkSuggestionToTaskCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const item = arg instanceof SuggestionTreeItem ? arg : undefined;
  if (!item) return;
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) return;

  const tasks = (await ctx.repository.getByRepository(repositoryRoot)).filter(
    (task) => !task.origin && task.status !== "archived",
  );
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(
      "Every task here is already linked to something, or archived. " +
        "Start a task from this suggestion instead.",
    );
    return;
  }

  type Pick = vscode.QuickPickItem & { taskId: string };
  const choice = await vscode.window.showQuickPick<Pick>(
    tasks.map((task) => ({
      label: task.name,
      description: task.branchName,
      // The brief, because on a repository with a dozen similar report tasks the name
      // alone frequently is not enough to tell which ticket a task is for.
      detail: task.description,
      taskId: task.id,
    })),
    {
      title: `Link ${item.suggestion.ref} to a task`,
      placeHolder: `Which task is ${item.suggestion.ref} being done as?`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!choice) return;

  const result = await ctx.service.setTaskOrigin(choice.taskId, {
    sourceId: item.suggestion.sourceId,
    ref: item.suggestion.ref,
    ...(item.suggestion.url ? { url: item.suggestion.url } : {}),
    at: new Date().toISOString(),
  });
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      "message" in result.error ? result.error.message : "Could not link the task.",
    );
    return;
  }

  ctx.tree.refresh();
  void vscode.window.showInformationMessage(
    `"${result.value.name}" is now ${item.suggestion.ref}. It has left the suggestions list.`,
  );
}

/**
 * Clears a task's link to a suggestion.
 *
 * Needed for the same reason linking is: a wrong link is worse than none, because it
 * hides real work from the list. Its own command rather than a silent overwrite in the
 * link flow, so the moment a link is broken is a thing somebody chose.
 */
export async function unlinkTaskOriginCommand(
  ctx: CommandContext,
  arg: unknown,
): Promise<void> {
  const task = resolveTaskArg(arg);
  if (!task?.origin) return;

  const confirm = await vscode.window.showWarningMessage(
    `Unlink "${task.name}" from ${task.origin.ref}?`,
    { modal: true, detail: "It will be offered as a suggestion again on the next scan." },
    "Unlink",
  );
  if (confirm !== "Unlink") return;

  const result = await ctx.service.setTaskOrigin(task.id, undefined);
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      "message" in result.error ? result.error.message : "Could not unlink the task.",
    );
    return;
  }
  ctx.tree.refresh();
}

/** The task a tree item stands for, whichever kind of row the menu was opened on. */
function resolveTaskArg(arg: unknown): TaskWorkspace | undefined {
  const candidate = arg as { task?: TaskWorkspace } | undefined;
  return candidate?.task;
}

/** Opens the suggestion in its own system, when it came with a link. */
export async function openSuggestionCommand(arg: unknown): Promise<void> {
  const item = arg instanceof SuggestionTreeItem ? arg : undefined;
  const url = item?.suggestion.url;
  if (!url) return;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
