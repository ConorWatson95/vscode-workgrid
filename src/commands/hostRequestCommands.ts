import * as vscode from "vscode";
import { claimAnswers, hostWork } from "../domain/hostRequests";
import { PendingQuestion } from "../domain/taskPipeline";
import { QuestionPanel } from "../ui/questionPanel";
import { CommandContext } from "./commandContext";

/**
 * Serves what a client outside VS Code asked for and could not finish itself:
 * delivering answers to a question this window's stage is waiting on
 * (`domain/hostRequests.ts`).
 *
 * Run whenever the state file changes, which is how a request arrives. Every act is
 * claimed inside `repository.update` first, so when several windows watch one
 * repository exactly one of them acts.
 */
export async function serveHostRequests(ctx: CommandContext): Promise<void> {
  if (serving) {
    again = true;
    return;
  }
  serving = true;
  try {
    do {
      again = false;
      await serveOnce(ctx);
    } while (again);
  } catch (error) {
    ctx.logger.error("Harness: could not serve a request from another client.", error);
  } finally {
    serving = false;
  }
}

let serving = false;
let again = false;
let retry: ReturnType<typeof setTimeout> | undefined;

async function serveOnce(ctx: CommandContext): Promise<void> {
  const root = ctx.resolveRepositoryRoot();
  if (!root) return;
  const tasks = await ctx.repository.getByRepository(root);
  const work = hostWork(tasks, Date.now(), (callId) => !!ctx.askUser?.get(callId));

  // A live question owned by no window becomes deliverable only after a grace
  // period, and nothing writes the file at that moment to wake this up.
  if (retry) clearTimeout(retry);
  retry =
    work.retryAt === undefined
      ? undefined
      : setTimeout(() => void serveHostRequests(ctx), Math.max(work.retryAt - Date.now(), 0) + 250);

  for (const action of work.actions) {
    const at = new Date().toISOString();

    const callId = action.kind === "answerLive" ? action.callId : undefined;
    let question: PendingQuestion | undefined;
    const claimed = await ctx.repository.update(action.taskId, (task) => {
      const delivered = claimAnswers(task, at, callId);
      question = delivered?.question;
      return delivered?.task;
    });
    if (!claimed || !question) continue;
    QuestionPanel.update(claimed.id, undefined);
    ctx.tree.refresh();

    // A live question goes back to the session blocked on it, which carries on
    // mid-turn; nothing advances, because nothing stopped.
    if (callId) {
      const answers = question.items.map((item) => item.answer?.trim() ?? "");
      if (ctx.askUser?.answer(callId, answers)) {
        ctx.logger.info(
          `Harness [${claimed.name}] delivered ${answers.length} answer(s) from outside VS Code; the agent is continuing.`,
        );
        continue;
      }
      ctx.logger.warn(
        `Harness [${claimed.name}] the stage stopped waiting, so the answers went into the brief instead.`,
      );
    }
    ctx.logger.info(
      `Harness [${claimed.name}] added ${question.items.length} answer(s) from outside VS Code to the brief.`,
    );
    if (ctx.configuration.advanceAfterAnswering(ctx.repositoryUri())) {
      void vscode.commands.executeCommand("taskWorkspaces.advanceRoute", claimed.id);
    }
  }
}
