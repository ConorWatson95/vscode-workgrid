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
