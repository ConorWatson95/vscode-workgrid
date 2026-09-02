import { describe, it, expect } from "vitest";
import { parseHarnessConfig } from "./harnessConfigFile";

const STAGE = {
  id: "build",
  label: "Build",
  kind: "implementation",
  intent: "Build it.",
};
const GATE = {
  id: "sign-off",
  label: "Sign off",
  kind: "humanVerification",
  intent: "Verify by hand.",
  gate: "approval",
};
const ROUTE = {
  id: "dotnet-fix",
  label: ".NET fix",
  description: "Our bug-fix flow.",
  stages: [STAGE, GATE],
};

const RULE = {
  id: "sql",
  reason: "SQL changed.",
  pathPattern: "\\.sql$",
  stage: { id: "sql-review", label: "SQL review", kind: "domainReview", intent: "Review." },
};

describe("parseHarnessConfig", () => {
  it("parses routes and rules from one file", () => {
    const parsed = parseHarnessConfig({ routes: [ROUTE], rules: [RULE] });
    expect(parsed.problems).toEqual([]);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.routes[0].stages.map((s) => s.id)).toEqual(["build", "sign-off"]);
  });

  it("defaults optional stage fields", () => {
    const [route] = parseHarnessConfig({ routes: [ROUTE] }).routes;
    expect(route.stages[0]).toMatchObject({ splittable: false, gate: "auto" });
    expect(route.stages[0].workflow).toBeUndefined();
  });

  it("carries splittable and workflow through", () => {
    const [route] = parseHarnessConfig({
      routes: [
        {
          ...ROUTE,
          stages: [
            { ...STAGE, splittable: true },
            { ...GATE, workflow: "/review" },
          ],
        },
      ],
    }).routes;
    expect(route.stages[0].splittable).toBe(true);
    expect(route.stages[1].workflow).toBe("/review");
  });

  it("carries a per-stage model through, and leaves others on the default", () => {
    // Stages differ in what they need: choosing where a file belongs is reading
    // and comparing; writing a migration that runs against a live database is not.
    const [route] = parseHarnessConfig({
      routes: [
        {
          ...ROUTE,
          stages: [{ ...STAGE, model: "sonnet" }, { ...GATE }],
        },
      ],
    }).routes;
    expect(route.stages[0].model).toBe("sonnet");
    expect(route.stages[1].model).toBeUndefined();
  });

  it("ignores a blank model rather than passing an empty --model", () => {
    const [route] = parseHarnessConfig({
      routes: [{ ...ROUTE, stages: [{ ...STAGE, model: "   " }, GATE] }],
    }).routes;
    expect(route.stages[0].model).toBeUndefined();
  });

  it("falls back to the label when a route has no description", () => {
    const { description, ...withoutDescription } = ROUTE;
    const [route] = parseHarnessConfig({ routes: [withoutDescription] }).routes;
    expect(route.description).toBe(".NET fix");
  });

  it("rejects a route with no human gate", () => {
    // A route that can pass itself defeats the point of the harness.
    const parsed = parseHarnessConfig({
      routes: [{ ...ROUTE, stages: [STAGE] }],
    });
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain('"gate": "approval"');
  });

  it("rejects a route with no stages", () => {
    const parsed = parseHarnessConfig({ routes: [{ ...ROUTE, stages: [] }] });
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("non-empty");
  });

  it("rejects a route missing id or label", () => {
    const parsed = parseHarnessConfig({
      routes: [{ label: "No id", stages: [STAGE, GATE] }],
    });
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain('"id" and "label" are required');
  });

  it("rejects an unrecognised stage kind", () => {
    const parsed = parseHarnessConfig({
      routes: [{ ...ROUTE, stages: [{ ...STAGE, kind: "vibes" }, GATE] }],
    });
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain('"kind" must be one of');
  });

  it("allows every lifecycle stage kind in a route", () => {
    // Unlike rules, a route owns the whole lifecycle, so it may declare
    // implementation and humanVerification stages too.
    for (const kind of [
      "implementation",
      "test",
      "codeReview",
      "domainReview",
      "behaviourReview",
      "humanVerification",
    ]) {
      const parsed = parseHarnessConfig({
        routes: [{ ...ROUTE, stages: [{ ...STAGE, kind }, GATE] }],
      });
      expect(parsed.routes, kind).toHaveLength(1);
    }
  });

  it("rejects duplicate stage ids within a route", () => {
    const parsed = parseHarnessConfig({
      routes: [{ ...ROUTE, stages: [STAGE, STAGE, GATE] }],
    });
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("duplicate stage id");
  });

  it("keeps the first of two routes sharing an id", () => {
    const parsed = parseHarnessConfig({
      routes: [ROUTE, { ...ROUTE, label: "Second" }],
    });
    expect(parsed.routes.map((r) => r.label)).toEqual([".NET fix"]);
    expect(parsed.problems.join(" ")).toContain("duplicate id");
  });

  it("rejects a bad route without discarding the good ones", () => {
    const parsed = parseHarnessConfig({
      routes: [ROUTE, { ...ROUTE, id: "broken", stages: [STAGE] }],
    });
    expect(parsed.routes.map((r) => r.id)).toEqual(["dotnet-fix"]);
    expect(parsed.problems).toHaveLength(1);
  });

  it("reports a non-array routes field", () => {
    const parsed = parseHarnessConfig({ routes: { id: "x" } });
    expect(parsed.problems.join(" ")).toContain('"routes" must be an array');
  });

  it("treats a rules-only file as defining no routes", () => {
    // A review-rules.json written before routes were configurable must keep
    // working, and must not be read as "this project has zero routes".
    const parsed = parseHarnessConfig({ rules: [RULE] });
    expect(parsed.routes).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.problems).toEqual([]);
  });

  it("accepts a bare rules array", () => {
    const parsed = parseHarnessConfig([RULE]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.routes).toEqual([]);
  });
});

describe("checklistAudience", () => {
  const routeWith = (over: Record<string, unknown>) => ({
    ...ROUTE,
    stages: [STAGE, { ...GATE, ...over }],
  });

  it("carries an audience through on a verification gate", () => {
    const parsed = parseHarnessConfig({ routes: [routeWith({ checklistAudience: "others" })] });
    expect(parsed.problems).toEqual([]);
    expect(parsed.routes[0].stages[1].checklistAudience).toBe("others");
  });

  it("leaves it absent when the gate does not declare one", () => {
    const parsed = parseHarnessConfig({ routes: [ROUTE] });
    expect(parsed.routes[0].stages[1].checklistAudience).toBeUndefined();
  });

  it("rejects an audience on a stage that is not a gate", () => {
    const parsed = parseHarnessConfig({
      routes: [{ ...ROUTE, stages: [{ ...STAGE, checklistAudience: "others" }, GATE] }],
    });
    expect(parsed.routes).toHaveLength(0);
    expect(parsed.problems.join(" ")).toContain("checklistAudience");
  });

  it("rejects an unrecognised audience rather than defaulting it", () => {
    // Defaulting means "self", which puts a task waiting on external testers back
    // into the operator's own list — the thing the field exists to stop.
    const parsed = parseHarnessConfig({ routes: [routeWith({ checklistAudience: "testers" })] });
    expect(parsed.routes).toHaveLength(0);
    expect(parsed.problems.join(" ")).toContain("testers");
  });
});

describe("onFailure", () => {
  const routeWith = (onFailure: unknown, verify: unknown = "pwsh check.ps1") => ({
    routes: [
      {
        id: "r1",
        label: "R1",
        stages: [
          { id: "promote", label: "Promote", kind: "deployment", intent: "Promote it." },
          {
            id: "accept",
            label: "Accept",
            kind: "humanVerification",
            intent: "Accept it.",
            gate: "approval",
            ...(verify === null ? {} : { verify }),
            onFailure,
          },
        ],
      },
    ],
  });

  it("accepts an earlier stage id", () => {
    const parsed = parseHarnessConfig(routeWith({ repair: "promote" }));
    expect(parsed.problems).toEqual([]);
    expect(parsed.routes[0].stages[1].onFailure).toEqual({ repair: "promote" });
  });

  it("is absent by default, so nothing that has not opted in changes", () => {
    const parsed = parseHarnessConfig(routeWith(undefined));
    expect(parsed.problems).toEqual([]);
    expect(parsed.routes[0].stages[1].onFailure).toBeUndefined();
  });

  // Rejected rather than coerced: read as absent, a typo leaves the route looking as
  // though it declared a repair owner while a failed check goes on stopping dead.
  it("rejects a malformed declaration rather than reading it as absent", () => {
    for (const bad of ["promote", { repair: "" }, {}, ["promote"], 3]) {
      const parsed = parseHarnessConfig(routeWith(bad));
      expect(parsed.routes).toEqual([]);
      expect(parsed.problems.join(" ")).toContain("onFailure");
    }
  });

  // Config that silently does nothing is indistinguishable from the feature being
  // absent — the lesson the unquoted hook command taught this codebase.
  it("rejects a repair owner on a stage with no check to fail", () => {
    const parsed = parseHarnessConfig(routeWith({ repair: "promote" }, null));
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("needs a \"verify\" command");
  });

  it("rejects a stage that is not in the route", () => {
    const parsed = parseHarnessConfig(routeWith({ repair: "nope" }));
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("not a stage of this route");
  });

  // Repairing forward, or itself, would let the route loop.
  it("rejects itself and a later stage", () => {
    for (const target of ["accept", "later"]) {
      const config = routeWith({ repair: target });
      config.routes[0].stages.push({
        id: "later",
        label: "Later",
        kind: "deployment",
        intent: "Later.",
      } as never);
      const parsed = parseHarnessConfig(config);
      expect(parsed.routes).toEqual([]);
      expect(parsed.problems.join(" ")).toContain("not an earlier stage");
    }
  });
});

describe("sendBackTo", () => {
  const routeWith = (sendBackTo: unknown) => ({
    routes: [
      {
        id: "r1",
        label: "R1",
        stages: [
          { id: "build", label: "Build", kind: "implementation", intent: "Build it." },
          { id: "review", label: "Review", kind: "codeReview", intent: "Review it.", sendBackTo },
          { id: "signoff", label: "Sign-off", kind: "humanVerification", intent: "Sign.", gate: "approval" },
        ],
      },
    ],
  });

  it("accepts an earlier stage id", () => {
    const parsed = parseHarnessConfig(routeWith(["build"]));
    expect(parsed.problems).toEqual([]);
    expect(parsed.routes[0].stages[1].sendBackTo).toEqual(["build"]);
  });

  it("accepts a kind entry", () => {
    const parsed = parseHarnessConfig(routeWith(["kind:implementation"]));
    expect(parsed.problems).toEqual([]);
    expect(parsed.routes[0].stages[1].sendBackTo).toEqual(["kind:implementation"]);
  });

  it("rejects a route whose target comes later", () => {
    // A forward target is either a typo or a cycle, and a route that can loop
    // indefinitely must not reach a task.
    const parsed = parseHarnessConfig(routeWith(["signoff"]));
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("not an earlier stage");
  });

  it("rejects a route whose target does not exist", () => {
    const parsed = parseHarnessConfig(routeWith(["nope"]));
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("not a stage of this route");
  });

  it("rejects a misspelled kind, which would silently match nothing", () => {
    const parsed = parseHarnessConfig(routeWith(["kind:implementaton"]));
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("not a stage kind");
  });

  it("rejects a value that is not an array of ids", () => {
    const parsed = parseHarnessConfig(routeWith("build"));
    expect(parsed.routes).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("array of stage ids");
  });
});

describe("worktree.discardPaths", () => {
  it("reads the declared paths", () => {
    const parsed = parseHarnessConfig({
      worktree: { discardPaths: ["QubeAutoApp/Web.config", "bin/Debug/"] },
    });
    expect(parsed.discardPaths).toEqual(["QubeAutoApp/Web.config", "bin/Debug/"]);
    expect(parsed.problems).toEqual([]);
  });

  it("declares none when the section is absent", () => {
    // No config means nothing is ever discarded. There is no fallback here, and the
    // reason is stronger than for rules: a default would delete files.
    expect(parseHarnessConfig({ routes: [] }).discardPaths).toEqual([]);
  });

  it("rejects an absolute path", () => {
    const parsed = parseHarnessConfig({
      worktree: { discardPaths: ["C:/Dev/other/Web.config", "bin/Debug/"] },
    });
    expect(parsed.discardPaths).toEqual(["bin/Debug/"]);
    expect(parsed.problems.join(" ")).toContain("is absolute");
  });

  it("rejects a path climbing out of the repository", () => {
    const parsed = parseHarnessConfig({
      worktree: { discardPaths: ["../sibling/Web.config"] },
    });
    expect(parsed.discardPaths).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("climbs outside");
  });

  it("rejects the whole list when it is not an array of strings", () => {
    // Partial acceptance is right for a route and wrong here: where this has to guess,
    // the cost of guessing is a deleted file.
    const parsed = parseHarnessConfig({ worktree: { discardPaths: "Web.config" } });
    expect(parsed.discardPaths).toEqual([]);
    expect(parsed.problems.join(" ")).toContain("must be an array");
  });
});
