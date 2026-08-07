import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { ServiceError } from "../services/taskWorkspaceService";
import { RouteDefinition, assessmentStageDefinition } from "../domain/taskRoute";
import { createPipeline } from "../domain/pipelineEngine";
import { loadHarness } from "../services/reviewRulesService";
import { withStatus } from "../ui/statusProgress";

/**
 * Multi-step create flow: name → branch type → base branch → description,
 * then a confirmation showing the generated branch and path before creation.
 */
export async function createTaskWorkspaceCommand(
  ctx: CommandContext,
): Promise<void> {
  const repositoryRoot = ctx.resolveRepositoryRoot();
  if (!repositoryRoot) {
    void vscode.window.showErrorMessage(
      "No Git repository is open. Open a repository folder first.",
    );
    return;
  }
  const scope = ctx.repositoryUri();

  const name = await vscode.window.showInputBox({
    title: "Create Task Workspace",
    prompt: "Task name",
    placeHolder: "e.g. Campaign performance report",
    validateInput: (value) =>
      value.trim().length === 0 ? "Task name is required." : undefined,
  });
  if (!name) return;

  const prefixes = ctx.configuration.branchPrefixes(scope);
  const branchPrefix = await vscode.window.showQuickPick(prefixes, {
    title: "Create Task Workspace",
    placeHolder: "Branch type",
  });
  if (!branchPrefix) return;

  // Resolve default base branch (config, else current HEAD branch).
  let defaultBase = ctx.configuration.defaultBaseBranch(scope);
  if (!defaultBase) {
    const current = await ctx.worktrees.getCurrentBranch(repositoryRoot);
    defaultBase = current.ok && current.value ? current.value : "HEAD";
  }
  const baseBranch = await vscode.window.showInputBox({
    title: "Create Task Workspace",
    prompt: "Base branch",
    value: defaultBase,
    validateInput: (value) =>
      value.trim().length === 0 ? "Base branch is required." : undefined,
  });
  if (!baseBranch) return;

  // Choosing a route is what harnesses the task: it fixes the stages the work
  // will travel through before any agent runs. Declining is a first-class
  // choice — an unharnessed task behaves exactly as it did before routes existed.
  // Routes come from the project's harness config when it defines any; the
  // built-ins are only a fallback so the picker is usable before one exists.
  const harness = loadHarness(repositoryRoot, {
    configuredPath: ctx.configuration.harnessConfigPath(scope),
  });
  for (const problem of harness.problems) {
    ctx.logger.warn(`Harness config: ${problem}`);
  }

  // Two kinds of task, said as two kinds rather than as a route and the absence of
  // one. "No route" read as "use the default route" — an understandable reading,
  // and it is not what it does: it gives a worktree and a chat, which is a
  // deliberate way to work, not a fallback. Named for what it produces instead.
  type RouteItem = vscode.QuickPickItem & { route?: RouteDefinition };
  const items: RouteItem[] = [
    {
      label: harness.usingBuiltInRoutes ? "Built-in routes" : "Routes from this project",
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...harness.routes.map((route) => ({
      label: route.label,
      detail:
        `${route.description} (${route.stages.length} stages)` +
        (harness.usingBuiltInRoutes ? " · built-in" : ""),
      route: route as RouteDefinition | undefined,
    })),
    { label: "Or work by hand", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "Chat task",
      description: "no route",
      detail:
        "A worktree and a chat session, and nothing else: no stages, no gates, " +
        "no brief handed to prompts. Attach a Route… adds one later, with the " +
        "option to assess what is already done.",
      route: undefined,
    },
  ];

  const routeChoice = await vscode.window.showQuickPick(items, {
    title: "Create Task Workspace",
    placeHolder: "How should this work be run?",
  });
  if (!routeChoice) return;

  // Asked at creation, not only when attaching a route to an existing task. The case
  // that forced it: work that exists **only in an environment** — SQL deployed to DEV
  // before it was ever in source control, or a task closed to be migrated onto the
  // harness. There is no branch to adopt and no worktree to take over, so the way in is
  // an ordinary new task; without this the route would start from nothing and the
  // stages would rebuild what is already running.
  let assessFirst = false;
  if (routeChoice.route) {
    const started = await vscode.window.showQuickPick(
      [
        {
          label: "No — this is new work",
          detail: "Every stage runs from the beginning.",
          assess: false,
        },
        {
          label: "Yes — some of it already exists",
          detail:
            "Adds an assessment stage that looks in the worktree and, where it has " +
            "the tooling, in the environments this work targets. You approve its " +
            "findings before any stage is skipped.",
          assess: true,
        },
      ],
      {
        title: "Has any of this work already been done?",
        placeHolder: "Including work done by hand, or deployed but never committed.",
      },
    );
    if (!started) return;
    assessFirst = started.assess;
  }

  // With a route, this text is handed to every stage prompt. A thin brief — a bare
  // ticket reference, say — is allowed: a stage that needs more asks for it and the
  // route pauses, rather than the extension second-guessing what is enough.
  const description = await vscode.window.showInputBox({
    title: "Create Task Workspace",
    prompt: routeChoice.route
      ? "Brief — given to every stage of the route"
      : "Description (optional) — for the task's details, not sent to the chat",
    placeHolder: routeChoice.route
      ? "A ticket reference is fine; stages will ask if they need more."
      : "What is this task about?",
  });
  // A cancelled (Escape) description returns undefined; treat as no description.

  const configuredParentDir = ctx.configuration.worktreeParentDir(scope);
  const proposal = ctx.service.proposeTask({
    repositoryRoot,
    name,
    branchPrefix,
    configuredParentDir,
  });
  if (!proposal.ok) {
    void vscode.window.showErrorMessage(describeCreateError(proposal.error));
    return;
  }

  const confirm = await vscode.window.showInformationMessage(
    `Create task "${name.trim()}"?`,
    {
      modal: true,
      detail:
        `Branch: ${proposal.value.branchName}\nBase: ${baseBranch.trim()}\n` +
        `Worktree: ${proposal.value.worktreePath}\n` +
        `Route: ${routeChoice.route?.label ?? "chat task — no stages or gates"}`,
    },
    "Create",
  );
  if (confirm !== "Create") return;

  // One status-bar item covers the whole creation, not just the git call:
  // checking out a large worktree, copying config into it and attaching the
  // route all take time, and the last two used to happen with no indication at
  // all once the git progress had closed.
  const outcome = await withStatus(`Creating "${name.trim()}"`, async (step) => {
    step(`checking out ${proposal.value.branchName}`);
    const created = await ctx.service.createTask({
      repositoryRoot,
      name,
      branchPrefix,
      baseBranch: baseBranch.trim(),
      description,
      configuredParentDir,
    });
    if (!created.ok) return { created };

    // Bring across untracked local config before anything runs in the worktree,
    // so the first agent session sees the same settings as the main checkout.
    step("copying local config into the worktree");
    const provisioned = ctx.provisioner.provision(
      ctx.configuration.copyIntoWorktree(scope),
      repositoryRoot,
      created.value.worktreePath,
    );

    // Sibling links go beside the worktree, not in it, and are shared by every task
    // in this parent directory — so this is idempotent and usually does nothing. Run
    // per task anyway: the first task in a fresh worktree directory is the one that
    // needs them, and there is no other moment that reliably happens.
    step("linking sibling repositories");
    ctx.provisioner.linkSiblings(
      ctx.configuration.linkSiblings(scope),
      repositoryRoot,
      created.value.worktreePath,
    );

    // Attach the pipeline after the worktree exists, so a failed creation never
    // leaves a harnessed task with no worktree behind it.
    let routeFailed = false;
    if (routeChoice.route) {
      step(`attaching the ${routeChoice.route.label} route`);
      const harnessed = {
        ...created.value,
        pipeline: createPipeline(
          assessFirst
            ? {
                ...routeChoice.route,
                stages: [assessmentStageDefinition(), ...routeChoice.route.stages],
              }
            : routeChoice.route,
        ),
        updatedAt: new Date().toISOString(),
      };
      try {
        await ctx.repository.save(harnessed);
        created.value.pipeline = harnessed.pipeline;
      } catch (error) {
        // The worktree is real and usable; only the route failed to stick.
        ctx.logger.error(
          `Created "${created.value.name}" but could not attach the ${routeChoice.route.id} route`,
          error,
        );
        routeFailed = true;
      }
    }

    return { created, provisioned, routeFailed };
  });

  const created = outcome.created;
  if (!created.ok) {
    void vscode.window.showErrorMessage(describeCreateError(created.error));
    return;
  }

  if (outcome.provisioned && outcome.provisioned.problems.length > 0) {
    void vscode.window.showWarningMessage(
      `Task created, but ${outcome.provisioned.problems.length} file(s) could not be copied into the worktree. See the output channel.`,
    );
  }
  if (outcome.routeFailed) {
    void vscode.window.showWarningMessage(
      `Task created, but its route could not be saved. It will behave as an unharnessed task.`,
    );
  }

  ctx.tree.refresh();

  const action = await vscode.window.showInformationMessage(
    `Task "${created.value.name}" created.`,
    "Open Workspace",
    "Start Claude",
    "Copy Path",
  );
  if (action === "Open Workspace") {
    await vscode.commands.executeCommand("taskWorkspaces.open", created.value.id);
  } else if (action === "Start Claude") {
    await vscode.commands.executeCommand("taskWorkspaces.startAgent", created.value.id);
  } else if (action === "Copy Path") {
    await vscode.env.clipboard.writeText(created.value.worktreePath);
  }
}

function describeCreateError(error: ServiceError): string {
  if (error.kind === "validation") {
    return error.message;
  }
  if (error.kind === "notFound") {
    return error.message;
  }
  const inner = error.error;
  if (inner.kind === "validation" || inner.kind === "dirty" || inner.kind === "unmerged") {
    return inner.message;
  }
  return `Git error: ${inner.error.message}`;
}
