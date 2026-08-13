import * as vscode from "vscode";
import { PendingQuestion } from "../domain/taskPipeline";
import { splitQuestion } from "../domain/questionText";

/**
 * A panel for answering a stage's questions.
 *
 * Replaces a modal dialog plus a single-line input box, which failed in three
 * ways that matter once more than one task is in flight:
 *
 * - dismissing it lost the questions, and the session that asked them was gone,
 *   so the only way back was re-running the stage;
 * - several questions shared one answer field, so one reply had to address all
 *   of them and nothing recorded which answer belonged to which question;
 * - nothing on screen said which task was asking.
 *
 * One panel per task, keyed by task id, so two tasks asking at once are two
 * separate editors with the task name in the tab.
 */
export class QuestionPanel {
  private static readonly open = new Map<string, QuestionPanel>();

  static show(
    taskId: string,
    taskName: string,
    pending: PendingQuestion,
    handlers: QuestionHandlers,
  ): void {
    const existing = QuestionPanel.open.get(taskId);
    if (existing) {
      existing.pending = pending;
      existing.handlers = handlers;
      existing.render();
      existing.panel.reveal(undefined, true);
      return;
    }
    QuestionPanel.open.set(
      taskId,
      new QuestionPanel(taskId, taskName, pending, handlers),
    );
  }

  /** Refreshes an open panel, or does nothing when none is open. */
  static update(taskId: string, pending: PendingQuestion | undefined): void {
    const panel = QuestionPanel.open.get(taskId);
    if (!panel) return;
    if (!pending) {
      panel.panel.dispose();
      return;
    }
    panel.pending = pending;
    panel.render();
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly taskId: string,
    private readonly taskName: string,
    private pending: PendingQuestion,
    private handlers: QuestionHandlers,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "taskWorkspaces.question",
      `Questions — ${taskName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => QuestionPanel.open.delete(taskId));
    this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => {
      void this.onMessage(message);
    });
    this.render();
  }

  private async onMessage(message: IncomingMessage): Promise<void> {
    if (message.kind === "answer") {
      try {
        await this.handlers.answer(this.taskId, message.id, message.text);
      } catch {
        // Typing must never raise: the submit path saves every answer again, and
        // that is where a failure the user needs to see is reported.
      }
      return;
    }
    if (message.kind === "submit") {
      // Save every answer first, then hand over — the panel closes on success,
      // so anything unsaved at that point would be lost.
      //
      // Every exit that is not success has to reach the webview. The button
      // disables itself and shows "Saving…" the moment it is clicked, so a
      // silent return — or a throw, which this handler is invoked with `void`
      // and would otherwise swallow — leaves the panel stuck on a save that is
      // never coming back, with the answers unsent and no way to retry.
      try {
        for (const answer of message.answers) {
          await this.handlers.answer(this.taskId, answer.id, answer.text);
        }
        const outcome = await this.handlers.submit(this.taskId);
        if (outcome && !outcome.ok) this.fail(outcome.reason);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Re-enables the button and says why the answers did not go through. */
  private fail(reason: string): void {
    void this.panel.webview.postMessage({ kind: "failed", reason });
  }

  private render(): void {
    this.panel.title = `Questions — ${this.taskName}`;
    this.panel.webview.html = this.html();
  }

  private html(): string {
    const items = this.pending.items
      .map((item, index) => {
        const answer = escapeHtml(item.answer ?? "");
        // The ask is the prompt; the reasoning that led to it is reading, and stays
        // collapsed. Never dropped — some questions genuinely cannot be answered
        // without the background, and this panel is the only place it is shown.
        const { headline, detail } = splitQuestion(item.text);
        const background = detail
          ? `<details class="detail"><summary>Why this is being asked</summary>
             <p>${escapeHtml(detail)}</p></details>`
          : "";
        return `
        <li class="question">
          <div class="number">${index + 1}</div>
          <div class="body">
            <p class="text">${escapeHtml(headline)}</p>
            ${background}
            <textarea rows="3" data-id="${escapeHtml(item.id)}"
              placeholder="Your answer">${answer}</textarea>
          </div>
        </li>`;
      })
      .join("");

    const count = this.pending.items.length;
    // Collapsed, and below the questions: it is the stage's working, and a panel
    // that opens on a paragraph is the thing this whole arrangement is avoiding.
    const context = this.pending.context
      ? `<details class="context"><summary>What the stage found</summary>
         <p>${escapeHtml(this.pending.context)}</p></details>`
      : "";
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 1.25rem 1.5rem; max-width: 46rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  .meta { color: var(--vscode-descriptionForeground); font-size: .85rem;
          margin: 0 0 1.25rem; }
  ol { list-style: none; padding: 0; margin: 0; }
  .question { display: flex; gap: .75rem; margin-bottom: 1.25rem; }
  .number { flex: 0 0 1.5rem; height: 1.5rem; border-radius: 50%;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            display: flex; align-items: center; justify-content: center;
            font-size: .8rem; }
  .body { flex: 1 1 auto; }
  .text { margin: .15rem 0 .5rem; white-space: pre-wrap; }
  .detail { margin: 0 0 .5rem; font-size: .85rem;
            color: var(--vscode-descriptionForeground); }
  .detail summary, .context summary { cursor: pointer; }
  .context { margin: .25rem 0 1rem; font-size: .85rem;
             color: var(--vscode-descriptionForeground); }
  .context p { margin: .35rem 0 0; white-space: pre-wrap; }
  .detail p { margin: .35rem 0 0; white-space: pre-wrap; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical;
             font-family: var(--vscode-font-family); font-size: .9rem;
             color: var(--vscode-input-foreground);
             background: var(--vscode-input-background);
             border: 1px solid var(--vscode-input-border, transparent);
             border-radius: 3px; padding: .4rem .5rem; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .actions { display: flex; gap: .5rem; align-items: center; margin-top: .5rem; }
  button { font-family: inherit; font-size: .9rem; border: none; border-radius: 3px;
           padding: .4rem .9rem; cursor: pointer;
           background: var(--vscode-button-background);
           color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .hint { color: var(--vscode-descriptionForeground); font-size: .8rem; }
  .note { margin-top: 1.5rem; padding-top: .75rem; font-size: .8rem;
          color: var(--vscode-descriptionForeground);
          border-top: 1px solid var(--vscode-panel-border); }
</style></head>
<body>
  <h1>${escapeHtml(this.taskName)}</h1>
  <p class="meta">“${escapeHtml(this.pending.stageName)}” needs ${count === 1 ? "an answer" : `${count} answers`} before it can run.</p>
  <ol>${items}</ol>
  ${context}
  <div class="actions">
    <button id="submit">Answer and continue</button>
    <span class="hint" id="hint"></span>
  </div>
  <p class="note">
    Answers are appended to the task brief, which every stage of the route sees —
    not sent back into the session that asked, since that session has ended. The
    stage then runs again from the start with the fuller brief.
  </p>
<script>
  const vscode = acquireVsCodeApi();
  const areas = Array.from(document.querySelectorAll("textarea"));
  const submit = document.getElementById("submit");
  const hint = document.getElementById("hint");

  // Persist as you type: closing the panel must not lose an answer, which is the
  // failure the old dialog had.
  for (const area of areas) {
    let timer;
    area.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        vscode.postMessage({ kind: "answer", id: area.dataset.id, text: area.value });
      }, 400);
      update();
    });
  }

  function update() {
    const blank = areas.filter((a) => a.value.trim().length === 0).length;
    submit.disabled = blank > 0;
    hint.textContent = blank === 0
      ? ""
      : blank + " of " + areas.length + " still to answer";
  }

  window.addEventListener("message", (event) => {
    if (event.data && event.data.kind === "failed") {
      submit.disabled = false;
      hint.textContent = "Not saved — " + event.data.reason;
      hint.style.color = "var(--vscode-errorForeground)";
    }
  });

  submit.addEventListener("click", () => {
    submit.disabled = true;
    hint.style.color = "";
    hint.textContent = "Saving…";
    vscode.postMessage({
      kind: "submit",
      answers: areas.map((a) => ({ id: a.dataset.id, text: a.value })),
    });
  });

  update();
  if (areas.length > 0) areas[0].focus();
</script>
</body></html>`;
  }
}

export interface QuestionHandlers {
  /** Stores one answer. Called as the user types, so it must be cheap. */
  answer(taskId: string, itemId: string, text: string): Promise<void>;
  /**
   * All answers are in: fold them into the brief and offer to continue.
   *
   * Returns why it did not go through, so the panel can re-enable its button.
   * On success the panel is closed by the handler, so nothing is returned.
   */
  submit(taskId: string): Promise<SubmitOutcome | void>;
}

export type SubmitOutcome = { ok: true } | { ok: false; reason: string };

type IncomingMessage =
  | { kind: "answer"; id: string; text: string }
  | { kind: "submit"; answers: { id: string; text: string }[] };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
