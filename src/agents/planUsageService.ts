import { EventEmitter } from "node:events";
import { Logger } from "../logging/logger";
import { PlanUsage, fetchPlanUsage } from "./planUsage";

/**
 * How long a usage snapshot is considered current before a re-probe. The view
 * checks every minute while visible, so this is what actually paces the CLI
 * spawns. Kept short enough that the panel tracks a working session.
 */
const STALE_AFTER_MS = 2 * 60_000;

/**
 * Caches plan usage so the details view can show it without spawning a CLI
 * probe on every render. Probing is on-demand (when stale, or forced by the
 * user) rather than on a background timer — usage moves slowly and each probe
 * costs a process spawn.
 */
export class PlanUsageService {
  private usage: PlanUsage | undefined;
  private inFlight: Promise<PlanUsage | undefined> | undefined;
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly logger: Logger,
    private readonly commandResolver: () => string,
    private readonly cwdResolver: () => string | undefined,
  ) {}

  /** Fires when a probe completes and the cached value changed. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.emitter.on("change", listener);
    return { dispose: () => this.emitter.off("change", listener) };
  }

  /** Last known usage, without triggering a probe. */
  current(): PlanUsage | undefined {
    return this.usage;
  }

  isStale(): boolean {
    return !this.usage || Date.now() - this.usage.fetchedAt > STALE_AFTER_MS;
  }

  /** True while a probe is running, so the UI can show progress. */
  isRefreshing(): boolean {
    return this.inFlight !== undefined;
  }

  /** Probes only if the cached value is missing or stale. */
  async refreshIfStale(): Promise<void> {
    if (this.isStale()) await this.refresh();
  }

  /** Forces a probe. Concurrent callers share the one in-flight request. */
  async refresh(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    const cwd = this.cwdResolver();
    if (!cwd) return;

    this.inFlight = fetchPlanUsage(this.commandResolver(), cwd, this.logger);
    try {
      const next = await this.inFlight;
      // Keep the previous snapshot on failure rather than blanking the panel.
      if (next) {
        this.usage = next;
        this.emitter.emit("change");
      }
    } finally {
      this.inFlight = undefined;
    }
  }
}
