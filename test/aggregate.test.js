import { describe, expect, test } from "bun:test";
import {
  aggregate,
  applyChatMessage,
  applyEvent,
  blockedBody,
  createModel,
  describeAggregate,
  displayAgent,
  hasSessions,
  metadataTokens,
  notificationFor,
  registerSession,
  removeSession,
  rootOf,
  stateLabels,
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

  test("message info never registers as a session", () => {
    const model = createModel();
    applyEvent(model, {
      type: "message.updated",
      properties: { info: { id: "msg_abc", sessionID: "ses_a" }, sessionID: "ses_a" },
    });
    expect(hasSessions(model)).toBe(false);
  });

  test("session.updated registers a root and keeps its title", () => {
    const model = createModel();
    applyEvent(model, {
      type: "session.updated",
      properties: { info: { id: "ses_a", title: "auth refactor" }, sessionID: "ses_a" },
    });
    expect(hasSessions(model)).toBe(true);
    expect(model.sessions.ses_a.title).toBe("auth refactor");
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

describe("metadata tokens", () => {
  test("summarizes sessions and surfaces waiting attention", () => {
    expect(
      metadataTokens({ counts: { working: 1, idle: 1 } }),
    ).toEqual({ oc_sessions: "1 working · 1 idle", oc_attention: null });
    expect(
      metadataTokens({ counts: { blocked: 1, working: 2 } }),
    ).toEqual({ oc_sessions: "1 blocked · 2 working", oc_attention: "waiting" });
  });
});

describe("display agent label", () => {
  test("stays plain for a single idle session", () => {
    expect(displayAgent({ counts: { idle: 1 } })).toBe("opencode");
  });
  test("counts sessions when several are open", () => {
    expect(displayAgent({ counts: { working: 1, idle: 1 } })).toBe("opencode ×2");
  });
  test("flags waiting regardless of session count", () => {
    expect(displayAgent({ counts: { blocked: 1, idle: 1 } })).toBe(
      "opencode ×2 · waiting",
    );
  });
});

describe("state labels", () => {
  test("uses the blocked session title when known", () => {
    const model = createModel();
    root(model, "A");
    registerSession(model, { id: "A", title: "auth refactor" });
    applyChatMessage(model, "A", 1);
    event(model, "permission.asked", "A", {});
    const labels = stateLabels(model, aggregate(model));
    expect(labels.blocked).toBe("waiting: auth refactor");
  });
  test("falls back to a generic label without a title", () => {
    const model = createModel();
    root(model, "A");
    event(model, "permission.asked", "A", {});
    expect(stateLabels(model, aggregate(model)).blocked).toBe("waiting: session");
  });
});

describe("notifications", () => {
  const config = { notify: "blocked", sound: "none" };
  test("fires when a session becomes blocked", () => {
    const model = createModel();
    root(model, "A");
    registerSession(model, { id: "A", title: "auth refactor" });
    event(model, "permission.asked", "A", {});
    const summary = aggregate(model);
    expect(
      notificationFor({ config, previousState: "working", state: "blocked", model, summary }),
    ).toEqual({
      title: "opencode needs input",
      body: "1 session waiting · auth refactor",
    });
  });
  test("stays quiet when already blocked or disabled", () => {
    const model = createModel();
    root(model, "A");
    const summary = aggregate(model);
    expect(
      notificationFor({ config, previousState: "blocked", state: "blocked", model, summary }),
    ).toBeNull();
    expect(
      notificationFor({
        config: { notify: "off" },
        previousState: "working",
        state: "blocked",
        model,
        summary,
      }),
    ).toBeNull();
  });
  test("optional finished notification only with notify=all", () => {
    const model = createModel();
    root(model, "A");
    status(model, "A", "idle");
    const summary = aggregate(model);
    expect(
      notificationFor({ config, previousState: "working", state: "idle", model, summary }),
    ).toBeNull();
    expect(
      notificationFor({
        config: { notify: "all" },
        previousState: "working",
        state: "idle",
        model,
        summary,
      }),
    ).toEqual({ title: "opencode finished", body: "1 idle" });
  });
  test("blocked body counts sessions", () => {
    const model = createModel();
    root(model, "A");
    root(model, "B");
    event(model, "permission.asked", "A", {});
    event(model, "question.asked", "B", {});
    expect(blockedBody(model, aggregate(model))).toBe("2 sessions waiting");
  });
});
