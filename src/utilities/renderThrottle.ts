/**
 * Rate-limits a render, keeping the last request rather than the first.
 *
 * The task tree costs real work to draw: `getLiveState` is two git processes per task, so
 * one render of a repository with nine tasks is **18 concurrent spawns and ~400ms** — an
 * individual `git status --porcelain` on a large solution measures 250–280ms. That was
 * always true and always affordable, because it happened when somebody asked for it.
 *
 * What made it a problem is that nothing coalesced. `refresh()` fired the tree's emitter
 * immediately, from around forty call sites plus every session status change, so a burst
 * of events during a running route became a burst of 400ms git storms, overlapping. The
 * cost is paid by the extension host, which is why the symptom was never confined to the
 * tree: the base-branch picker's two git calls — 110ms of work — took "ages" because they
 * queued behind renders nobody had asked for.
 *
 * Trailing edge, deliberately. A leading-edge throttle renders first and drops what
 * arrives during the window, which loses the *final* state of a burst — and the final
 * state is the one worth showing. Requests within the window collapse into one render
 * scheduled at the end of it, so the tree can never lag more than `minIntervalMs` behind
 * reality and can never render more often than that.
 *
 * Clock and scheduler are injected so this is testable without waiting on real time.
 */
export interface RenderThrottle {
  /** Requests a render. Returns immediately; the render happens on the trailing edge. */
  request(): void;
  /** Renders now, cancelling any pending request. For a deliberate user action. */
  flush(): void;
  /** Drops any pending render. */
  dispose(): void;
}

export interface RenderThrottleOptions {
  minIntervalMs: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createRenderThrottle(
  render: () => void,
  options: RenderThrottleOptions,
): RenderThrottle {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as never));

  let pending: unknown;
  let lastRenderedAt: number | undefined;

  const run = () => {
    pending = undefined;
    lastRenderedAt = now();
    render();
  };

  return {
    request() {
      if (pending !== undefined) return;
      const since = lastRenderedAt === undefined ? Infinity : now() - lastRenderedAt;
      // The first render after a quiet period is not delayed: making somebody wait out
      // an interval for a tree that was idle is the lag this exists to remove.
      if (since >= options.minIntervalMs) {
        run();
        return;
      }
      pending = schedule(run, options.minIntervalMs - since);
    },
    flush() {
      if (pending !== undefined) {
        cancel(pending);
        pending = undefined;
      }
      run();
    },
    dispose() {
      if (pending !== undefined) {
        cancel(pending);
        pending = undefined;
      }
    },
  };
}
