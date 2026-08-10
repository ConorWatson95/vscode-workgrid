import { TaskWorkspace } from "../domain/taskWorkspace";

/**
 * The task a tree row is about, whatever kind of row it is.
 *
 * Every row in the tree carries its task — the task rows, the stage rows, the
 * checklist items, the questions, the refusals, the held calls. Command handlers
 * recognised two of the six by class, so a command invoked from any of the others
 * reported "No task selected" while pointing directly at one.
 *
 * Read structurally rather than by `instanceof`, for two reasons. A row type added
 * later works without anyone remembering to extend a list of classes; and the check
 * cannot be defeated by the argument arriving as a plain object, which is what a
 * command re-invoked from a notification or a webview message can pass.
 *
 * Pure and vscode-free so it is tested — the failure it exists to prevent is silent
 * and looks exactly like the feature being broken.
 */
export function rowTask(row: unknown): TaskWorkspace | undefined {
  const candidate = (row as { task?: unknown } | undefined)?.task;
  return isTask(candidate) ? candidate : undefined;
}

/**
 * Whether a value is a task, judged on the two fields nothing else in the tree has.
 *
 * `id` alone is not enough: every `TreeItem` this extension builds sets one, so a
 * row whose `task` property held something else entirely would pass. `worktreePath`
 * is what makes it a task rather than any other identified thing.
 */
export function isTask(value: unknown): value is TaskWorkspace {
  const task = value as TaskWorkspace | undefined;
  return typeof task?.id === "string" && typeof task?.worktreePath === "string";
}
