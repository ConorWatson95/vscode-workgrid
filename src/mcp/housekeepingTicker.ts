import { Logger } from "../logging/logger";

/**
 * Starts `harnessRunner tick` while the Claude pane is open.
 *
 * The pane's `--watch` feed is the one long-lived harness process Claude keeps, so it is
 * where the background repairs get their clock when VS Code is not open
 * (`services/housekeeping.ts`). Once at start — the moment somebody is looking is when a
 * reclaimed subtask or a ticket reply matters — and then every interval.
 *
 * The tick runs **detached**, so closing the pane mid-tick, which kills this process's
 * tree, does not cut a job off half way. A launch that is still starting is not
 * started again; a tick that outlives an interval may overlap the next, which is safe
 * because every job is idempotent.
 */
export const HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;

export class HousekeepingTicker {
  private launching = false;

  constructor(
    private readonly launch: () => Promise<void>,
    private readonly logger: Logger,
  ) {}

  /** One tick, unless a launch is still starting. Never throws. */
  async tickNow(): Promise<boolean> {
    if (this.launching) return false;
    this.launching = true;
    try {
      await this.launch();
      return true;
    } catch (error) {
      this.logger.warn(`could not start a housekeeping tick: ${String(error)}`);
      return false;
    } finally {
      this.launching = false;
    }
  }

  start(intervalMs = HOUSEKEEPING_INTERVAL_MS): NodeJS.Timeout {
    void this.tickNow();
    return setInterval(() => void this.tickNow(), intervalMs);
  }
}
