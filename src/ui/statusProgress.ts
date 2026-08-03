import * as vscode from "vscode";

/**
 * Runs work with progress in the **status bar** rather than a notification.
 *
 * Notifications stack: several tasks being created, removed or advanced at once
 * produce a pile of toasts, which buries the ones that actually need an answer.
 * The status bar shows one line and needs no dismissing.
 *
 * The reporter is passed in so each step can name itself — "removing worktree"
 * is the difference between waiting and wondering whether anything is happening.
 *
 * Note that `cancellable` is only honoured for notification progress, so work
 * that a user must be able to interrupt needs its own affordance.
 */
export function withStatus<T>(
  title: string,
  run: (step: (message: string) => void) => Thenable<T>,
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title },
    (progress) => run((message) => progress.report({ message })),
  );
}
