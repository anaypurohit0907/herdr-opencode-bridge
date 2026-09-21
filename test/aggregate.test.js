import { describe, expect, test } from "bun:test";
import {
  aggregate,
  applyChatMessage,
  applyEvent,
  createModel,
  describeAggregate,
  hasSessions,
  registerSession,
  removeSession,
  rootOf,
} from "../src/aggregate.js";

const root = (model, id, extra = {}) =>
  applyEvent(model, {
    type: "session.created",
    properties: { info: { id, ...extra } },
  });

const child = (model, id, parentID) =>
  applyEvent(model, {
    type: "session.created",
    properties: { info: { id, parentID } },
  });

const status = (model, sessionID, value) =>
  applyEvent(model, { type: "session.status", properties: { sessionID, status: value } });

const event = (model, type, sessionID, properties = {}) =>
  applyEvent(model, { type, properties: { sessionID, ...properties } });

describe("session registry", () => {
  test("tracks roots and children", () => {
    const model = createModel();
    root(model, "A");
    child(model, "B", "A");
    expect(rootOf(model, "B")).toBe("A");
    expect(rootOf(model, "A")).toBe("A");
    expect(rootOf(model, "missing")).toBeUndefined();
  });

  test("removing a root drops its state", () => {
    const model = createModel();
    root(model, "A");
    removeSession(model, "A");
    expect(aggregate(model).state).toBe("unknown");
  });
});

describe("aggregate precedence", () => {
  test("a busy root keeps the pane working while another root idles", () => {
    const model = createModel();
    root(model, "A");
    root(model, "B");
    applyChatMessage(model, "A", 1);
    applyChatMessage(model, "B", 2);
    event(model, "session.idle", "B", {});
    expect(aggregate(model).state).toBe("working");
  });

  test("blocked from any root wins over working", () => {
    const model = createModel();
    root(model, "A");
    root(model, "B");
    applyChatMessage(model, "A", 1);
    event(model, "permission.asked", "B", {});
    expect(aggregate(model).state).toBe("blocked");
  });

  test("child asks surface as root blocked", () => {
    const model = createModel();
    root(model, "A");
    child(model, "C", "A");
    applyChatMessage(model, "A", 1);
    event(model, "question.asked", "C", {});
    expect(aggregate(model).state).toBe("blocked");
    event(model, "question.replied", "C", {});
    expect(aggregate(model).state).toBe("working");
  });

  test("session.status maps busy/idle/retry", () => {
    const model = createModel();
    root(model, "A");
    status(model, "A", "retry");
    expect(aggregate(model).state).toBe("working");
    status(model, "A", "idle");
    expect(aggregate(model).state).toBe("idle");
  });

  test("all idle reports idle, empty model reports unknown", () => {
    const model = createModel();
    expect(aggregate(model).state).toBe("unknown");
    expect(hasSessions(model)).toBe(false);
    root(model, "A");
    expect(hasSessions(model)).toBe(true);
    status(model, "A", "idle");
    expect(aggregate(model).state).toBe("idle");
  });

  test("primary tracks the most recently active root", () => {
    const model = createModel();
    root(model, "A");
    root(model, "B");
    applyChatMessage(model, "A", 5);
    applyChatMessage(model, "B", 10);
    expect(aggregate(model).primary).toBe("B");
  });
});

describe("report message", () => {
  test("describes counts in urgency order", () => {
    expect(describeAggregate({ counts: { working: 2, blocked: 1, idle: 3 } })).toBe(
      "1 blocked · 2 working · 3 idle",
    );
    expect(describeAggregate({ counts: { idle: 1 } })).toBe("1 idle");
  });
});
