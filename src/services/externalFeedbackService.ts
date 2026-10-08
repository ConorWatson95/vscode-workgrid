import {
  feedbackCommandFor,
  feedbackCutoff,
  hasUnreadFeedback,
  parseFeedbackOutput,
  summariseFeedback,
} from "../domain/externalFeedback";
import { SuggestionSource } from "../domain/suggestionSourceFile";
import { TaskWorkspace } from "../domain/taskWorkspace";
import { Logger } from "../logging/logger";
import { TaskRepository } from "../persistence/taskRepository";
import { VerificationCommandRunner } from "./verificationRunner";

/**
 * Polls the tickets of tasks waiting on others, and records replies.
 *
 * The decision of what counts as a reply is `domain/externalFeedback.ts`; this only
 * runs the source's declared command and persists the result. vscode-free, so the
 * timer and the notification live in `extension.ts` and nothing here needs a window.
 */
export interface ExternalFeedbackDeps {
  repository: TaskRepository;
  runner: VerificationCommandRunner;
  /** The project's sources, read fresh so a `harness.json` edit applies on the next poll. */
  sources: (repositoryRoot: string) => SuggestionSource[];
  /**
   * When the task's external wait began, or undefined when it is not waiting on others.
   * Injected because which gate is external is the grouping's rule, not this module's.
   */
  waitingSince: (task: TaskWorkspace) => string | undefined;
  clock: { now(): string };
  logger: Logger;
}

export interface FeedbackPollOutcome {
  polled: number;
  /** Tasks that went from nothing unread to a reply waiting. */
  arrived: TaskWorkspace[];
}

export class ExternalFeedbackService {
  private polling = false;

  constructor(private readonly deps: ExternalFeedbackDeps) {}

  async poll(repositoryRoot: string): Promise<FeedbackPollOutcome> {
    // A poll runs one process per waiting task; a slow ticket system must not stack them.
    if (this.polling) return { polled: 0, arrived: [] };
    this.polling = true;
    try {
      return await this.pollAll(repositoryRoot);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The operator has read the reply and the task is still with others.
   *
   * Recorded rather than clearing `latest`, so a later comment is still compared against
   * something and the row can go on saying who last replied.
   */
  async markRead(taskId: string): Promise<TaskWorkspace | undefined> {
    const task = await this.deps.repository.get(taskId);
    if (!task?.externalFeedback) return task;
    const updated: TaskWorkspace = {
      ...task,
      externalFeedback: { ...task.externalFeedback, readAt: this.deps.clock.now() },
    };
    await this.deps.repository.save(updated);
    return updated;
  }

  private async pollAll(repositoryRoot: string): Promise<FeedbackPollOutcome> {
    const sources = this.deps.sources(repositoryRoot);
    if (!sources.some((source) => source.feedbackCommand)) return { polled: 0, arrived: [] };

    const tasks = await this.deps.repository.getByRepository(repositoryRoot);
    const arrived: TaskWorkspace[] = [];
    let polled = 0;

    for (const task of tasks) {
      if (task.status === "archived" || !task.origin) continue;
      const waitSince = this.deps.waitingSince(task);
      if (!waitSince) continue;
      // Already unread: the task is in front of the operator, and another poll would
      // only tell them again.
      if (hasUnreadFeedback(task.externalFeedback, waitSince)) continue;

      const template = sources.find(
        (source) => source.id === task.origin?.sourceId,
      )?.feedbackCommand;
      if (!template) continue;

      const readAt = task.externalFeedback?.readAt;
      const cutoff = feedbackCutoff(waitSince, readAt);
      const command = feedbackCommandFor(template, task.origin.ref, cutoff);
      if (!command.ok) {
        this.deps.logger.warn(`Feedback poll skipped "${task.name}": ${command.reason}.`);
        continue;
      }

      polled += 1;
      const outcome = await this.deps.runner.run(command.command, repositoryRoot);
      if (outcome.spawnError || outcome.exitCode !== 0) {
        // Logged and left as it was. A failed poll recorded as "no comments" would
        // report a broken script as a quiet ticket.
        this.deps.logger.warn(
          `Feedback poll for ${task.origin.ref} failed ` +
            `(${outcome.spawnError ?? `exit ${outcome.exitCode}`}): ${outcome.output}`,
        );
        continue;
      }
      const parsed = parseFeedbackOutput(outcome.output);
      if (!parsed.ok) {
        this.deps.logger.warn(`Feedback poll for ${task.origin.ref} ${parsed.reason}.`);
        continue;
      }

      const summary = summariseFeedback(parsed.comments, cutoff, this.deps.clock.now(), readAt);
      if (!summary.latest) continue;

      // Re-read before writing: a stage may have saved this task while the command ran.
      const fresh = await this.deps.repository.get(task.id);
      if (!fresh) continue;
      const updated: TaskWorkspace = { ...fresh, externalFeedback: summary };
      await this.deps.repository.save(updated);
      this.deps.logger.info(
        `${task.origin.ref}: ${summary.count} new comment(s), latest from ${summary.latest.author}.`,
      );
      arrived.push(updated);
    }

    return { polled, arrived };
  }
}
