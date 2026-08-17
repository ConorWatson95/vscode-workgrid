import * as vscode from "vscode";
import { CommandContext } from "./commandContext";
import { resolveTaskArg } from "./suggestionCommands";
import { addReference, removeReference, TaskReference } from "../domain/taskReferences";

/**
 * The two ways an operator supplies context a stage cannot derive: before it runs,
 * and while it is running.
 *
 * Both come from the same measurement (14 Aug 2026, eight live pipelines). The
 * largest cause of corrected work was a stage that had a governing document and
 * never opened it; the next was an operator conducting a conversation by re-running
 * a stage once per question. One is answered by telling stages what governs the
 * work up front, the other by being able to speak to a session already running.
 */

/**
 * Names the documents that govern a task.
 *
 * A menu rather than a single input box because the list is cumulative and mostly
 * gets *added* to as the operator learns what actually decides the work — which was
 * the real sequence on the task that produced this: the wireframe was known from the
 * start, the tab that mattered was discovered three corrections in.
 */
export async function setReferencesCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = resolveTaskArg(arg);
  if (!task) return;

  const existing = task.references ?? [];
  const picked = await vscode.window.showQuickPick(
    [
      { label: "$(add) Add a document…", action: "add" as const },
      ...existing.map((reference) => ({
        label: `$(trash) ${reference.path}`,
        description: reference.note,
        detail: "Remove this one",
        action: "remove" as const,
        reference,
      })),
    ],
    {
      title: `Documents governing "${task.name}"`,
      placeHolder:
        existing.length > 0
          ? `${existing.length} document(s). Every stage is told to read these before copying an existing feature.`
          : "None yet. Stages with no governing document copy the closest existing feature.",
    },
  );
  if (!picked) return;

  let updated: TaskReference[];
  if (picked.action === "remove") {
    updated = removeReference(existing, picked.reference.path);
  } else {
    const path = await vscode.window.showInputBox({
      title: `Document governing "${task.name}"`,
      prompt:
        "A repository path or a URL. Not checked for existence — a governing document " +
        "is often a spreadsheet or a wiki page rather than a file in the repo.",
      placeHolder: "e.g. docs/Purchases vs Sales Mock-up 20.03.26.xlsx",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? "Name a document, or press Escape." : undefined,
    });
    if (!path?.trim()) return;

    // Asked separately, and this is the field that earned its place: the real case
    // was "tab 3 of the wireframe". A stage handed the workbook and not the tab has
    // the same ambiguity in a smaller box.
    const note = await vscode.window.showInputBox({
      title: `Which part of ${path.trim()} applies?`,
      prompt: "Optional. A tab, a section, a page — whatever narrows it.",
      placeHolder: "e.g. tab 3, 'By Description Code'",
      ignoreFocusOut: true,
    });
    if (note === undefined) return;

    updated = addReference(existing, { path, note }, new Date().toISOString());
  }

  const saved = await ctx.service.setTaskReferences(task.id, updated);
  if (!saved.ok) {
    void vscode.window.showErrorMessage(
      "message" in saved.error ? saved.error.message : "Could not save the documents.",
    );
    return;
  }
  ctx.tree.refresh();

  // Said plainly, because the change is invisible until the next stage runs — and
  // deliberately *only* the next: a stage that has already run is not retrospectively
  // told it had a document it never saw.
  void vscode.window.showInformationMessage(
    updated.length > 0
      ? `"${task.name}" is governed by ${updated.length} document(s). Stages that have not run yet will be told to read them.`
      : `"${task.name}" now has no governing documents.`,
  );
}

/**
 * Says something to the stage that is running right now.
 *
 * Delivered by holding the session's next tool call and refusing it with the
 * operator's words as the reason — the only channel into a live session, and one
 * whose mechanics are probed rather than assumed. See `domain/stageInterjection.ts`.
 *
 * The alternative it replaces is re-running the stage, which on a measured route
 * cost six discarded runs and 37 minutes to ask three questions.
 */
export async function interjectCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const task = resolveTaskArg(arg);
  if (!task) return;

  const gate = ctx.permissionGate;
  // Without the gate there is no hook to hold a call, so a message would wait
  // forever while the UI showed it as pending. Said here rather than swallowed,
  // because "nothing happened" is indistinguishable from the feature being broken.
  if (!gate?.isArmed(task.id)) {
    void vscode.window.showWarningMessage(
      `Nothing is listening on "${task.name}". A stage can only be interrupted while ` +
        "it is running under the permission gate.",
    );
    return;
  }

  const waiting = gate.pendingInterjection(task.id);
  const text = await vscode.window.showInputBox({
    title: `Say something to "${task.name}"`,
    prompt:
      "Delivered when the stage next uses a tool, and it carries on from there — no " +
      "re-run, and it keeps everything it has worked out." +
      (waiting ? " This replaces your undelivered message." : ""),
    placeHolder: "e.g. the layout comes from tab 3 of the wireframe, not Phase 2",
    value: waiting?.text,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "Say something, or press Escape." : undefined,
  });
  if (!text?.trim()) return;

  if (!gate.interject(task.id, text)) {
    void vscode.window.showWarningMessage(
      `Could not reach the stage running for "${task.name}" — it may have just finished.`,
    );
    return;
  }
  ctx.tree.refresh();

  // The honest caveat, and it is the one constraint of the mechanism: a stage
  // composing its final reply makes no more tool calls, so it cannot be interrupted.
  void vscode.window.showInformationMessage(
    `Queued for "${task.name}". It reaches the stage at its next tool call — a stage ` +
      "already writing its final reply will not see it.",
  );
}
