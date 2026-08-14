import { describe, expect, it } from "vitest";
import { createRenderThrottle } from "./renderThrottle";

/** A hand-driven clock and scheduler, so nothing here waits on real time. */
function harness(minIntervalMs = 400) {
  let clock = 1000;
  let renders = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;

  const throttle = createRenderThrottle(() => void renders++, {
    minIntervalMs,
    now: () => clock,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    cancel: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  return {
    throttle,
    renders: () => renders,
    pending: () => timers.length,
    advance(ms: number) {
      clock += ms;
      for (const timer of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    },
  };
}

describe("createRenderThrottle", () => {
  it("renders the first request immediately", () => {
    // A tree that has been idle must not be made to wait out an interval — that is the
    // lag this exists to remove, not to introduce.
    const h = harness();
    h.throttle.request();
    expect(h.renders()).toBe(1);
  });

  it("collapses a burst into one further render", () => {
    // The real pattern: a running route fires a session status change several times a
    // second, and each one used to cost 18 concurrent git spawns.
    const h = harness(400);
    h.throttle.request();
    for (let i = 0; i < 20; i++) {
      h.advance(10);
      h.throttle.request();
    }
    expect(h.renders()).toBe(1);
    h.advance(400);
    expect(h.renders()).toBe(2);
  });

  it("never renders more often than the interval", () => {
    const h = harness(400);
    for (let i = 0; i < 100; i++) {
      h.advance(20);
      h.throttle.request();
    }
    // 100 requests over 2s of clock: at most one render per 400ms.
    expect(h.renders()).toBeLessThanOrEqual(6);
  });

  it("keeps the last request rather than the first", () => {
    // Leading-edge would drop everything after the first, losing the final state of a
    // burst — which is the state worth showing.
    const h = harness(400);
    h.throttle.request();
    h.advance(50);
    h.throttle.request();
    expect(h.pending()).toBe(1);
    h.advance(350);
    expect(h.renders()).toBe(2);
  });

  it("renders again after a quiet period without delay", () => {
    const h = harness(400);
    h.throttle.request();
    h.advance(5000);
    h.throttle.request();
    expect(h.renders()).toBe(2);
    expect(h.pending()).toBe(0);
  });

  it("flushes a pending render immediately", () => {
    const h = harness(400);
    h.throttle.request();
    h.advance(10);
    h.throttle.request();
    h.throttle.flush();
    expect(h.renders()).toBe(2);
    expect(h.pending()).toBe(0);
  });

  it("drops a pending render on dispose", () => {
    const h = harness(400);
    h.throttle.request();
    h.advance(10);
    h.throttle.request();
    h.throttle.dispose();
    h.advance(1000);
    expect(h.renders()).toBe(1);
  });
});
