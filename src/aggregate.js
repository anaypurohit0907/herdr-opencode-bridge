// Pure state model for opencode sessions inside one Herdr pane.
// No I/O, no opencode imports: everything here is testable in isolation.

const CHILD_EVENT_STATES = {
  "permission.asked": "blocked",
  "question.asked": "blocked",
  "permission.replied": "working",
  "question.replied": "working",
  "question.rejected": "working",
};

const ROOT_EVENT_STATES = {
  "permission.replied": "working",
  "question.replied": "working",
  "question.rejected": "working",
  "session.compacted": "working",
  "tool.execute.before": "working",
  "tool.execute.after": "working",
  "permission.asked": "blocked",
  "question.asked": "blocked",
  "session.error": "blocked",
  "session.idle": "idle",
};

const SESSION_STATE_BY_STATUS = {
  idle: "idle",
  active: "working",
  busy: "working",
  pending: "working",
  retry: "working",
  running: "working",
  streaming: "working",
  working: "working",
};

export const STATE_PRIORITY = { blocked: 3, working: 2, idle: 1, unknown: 0 };

export function createModel() {
  return { sessions: {}, roots: {} };
}

function statusToState(status) {
  const kind = typeof status === "string" ? status : status?.type;
  return typeof kind === "string"
    ? SESSION_STATE_BY_STATUS[kind.toLowerCase()]
    : undefined;
}

function sessionIDFromProperties(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

// Walk parentID links until a session without a parent is reached.
export function rootOf(model, id) {
  const seen = new Set();
  while (typeof id === "string" && !seen.has(id)) {
    seen.add(id);
    const session = model.sessions[id];
    if (!session) return undefined;
    if (!session.parentID) return id;
    id = session.parentID;
  }
  return undefined;
}

function setState(model, rootID, state, now, onTransition) {
  if (!rootID) return;
  const root = model.roots[rootID] ?? { state: "unknown", at: 0 };
  const previous = root.state;
  if (previous === state) {
    root.at = now;
    return;
  }
  model.roots[rootID] = { state, at: now };
  onTransition?.(rootID, previous, state);
}

function touch(model, rootID, now) {
  const root = model.roots[rootID];
  if (root) root.at = now;
}

export function registerSession(model, info) {
  if (!info?.id) return;
  const previous = model.sessions[info.id];
  model.sessions[info.id] = {
    id: info.id,
    parentID: info.parentID,
    title: typeof info.title === "string" && info.title ? info.title : previous?.title,
  };
  if (!info.parentID) {
    model.roots[info.id] ??= { state: "unknown", at: 0 };
  }
}

export function removeSession(model, id) {
  if (!id) return;
  delete model.sessions[id];
  delete model.roots[id];
}

// A prompt always means work started, for root and child sessions alike.
export function applyChatMessage(model, sessionID, now = Date.now()) {
  if (!sessionID) return;
  const rootID = rootOf(model, sessionID);
  setState(model, rootID, "working", now);
}

export function applyEvent(model, event, now = Date.now(), onTransition) {
  const type = event?.type;
  const properties = event?.properties ?? {};
  // Only session events carry session info. message.updated also exposes an
  // info object (the message), which must never register as a session.
  if (
    (type === "session.created" || type === "session.updated") &&
    properties.info?.id
  ) {
    registerSession(model, properties.info);
  }

  const sessionID = sessionIDFromProperties(properties);
  if (type === "session.deleted") {
    removeSession(model, sessionID);
    return;
  }
  if (!sessionID) return;

  const rootID = rootOf(model, sessionID);
  if (!rootID) return;
  const record = (state) => setState(model, rootID, state, now, onTransition);
  if (sessionID !== rootID) {
    const childState = CHILD_EVENT_STATES[type];
    if (childState) record(childState);
    return;
  }

  if (type === "session.status") {
    const state = statusToState(properties.status);
    if (state) record(state);
    return;
  }
  const state = ROOT_EVENT_STATES[type];
  if (state) record(state);
}

// Same as applyEvent, but reports each root state transition that happened.
export function applyEventTracked(model, event, now = Date.now()) {
  const transitions = [];
  applyEvent(model, event, now, (id, from, to) => {
    transitions.push({ id, from, to, title: model.sessions[id]?.title });
  });
  return transitions;
}

// Highest-urgency state across all known root sessions. "unknown" only wins
// when nothing better has ever been reported.
export function aggregate(model) {
  const roots = Object.entries(model.roots);
  if (roots.length === 0) return { state: "unknown", primary: undefined, counts: {} };
  const counts = {};
  let best = "unknown";
  let primary;
  let latest = -1;
  for (const [id, root] of roots) {
    counts[root.state] = (counts[root.state] ?? 0) + 1;
    if (STATE_PRIORITY[root.state] > STATE_PRIORITY[best]) best = root.state;
    if (root.at > latest) {
      latest = root.at;
      primary = id;
    }
  }
  return { state: best, primary, counts };
}

// Nothing worth reporting until at least one root session is known.
export function hasSessions(model) {
  return Object.keys(model.roots).length > 0;
}

export function describeAggregate({ counts }) {
  const parts = [];
  for (const state of ["blocked", "working", "idle"]) {
    if (counts[state]) parts.push(`${counts[state]} ${state}`);
  }
  return parts.join(" · ");
}

// Display-only tokens for the herdr sidebar. Null clears a token.
export function metadataTokens(summary) {
  const sessions = describeAggregate(summary);
  return {
    oc_sessions: sessions || null,
    oc_attention: summary.counts.blocked ? "waiting" : null,
  };
}

export function totalSessions({ counts }) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

// Zero-config label: herdr's default agent row shows this without any sidebar
// configuration, so multi-session panes read differently out of the box.
export function displayAgent(summary) {
  const total = totalSessions(summary);
  if (total <= 1 && !summary.counts.blocked) return "opencode";
  let label = total > 1 ? `opencode ×${total}` : "opencode";
  if (summary.counts.blocked) label += " · waiting";
  return label;
}

// Visible with the state_text token; human labels for each state.
export function stateLabels(model, summary) {
  const labels = {};
  if (summary.counts.working) labels.working = `${summary.counts.working} working`;
  if (summary.counts.idle) labels.idle = `${summary.counts.idle} idle`;
  if (summary.counts.blocked) {
    labels.blocked = `waiting: ${firstBlockedTitle(model) ?? "session"}`;
  }
  return labels;
}

export function firstBlockedTitle(model) {
  for (const [id, root] of Object.entries(model.roots)) {
    if (root.state === "blocked") {
      const title = model.sessions[id]?.title;
      if (title) return title.slice(0, 32);
    }
  }
  return undefined;
}

export function sessionLabel(transition) {
  const title = transition.title ? transition.title.slice(0, 40) : undefined;
  return title ?? `session …${String(transition.id).slice(-6)}`;
}

export function resolveSound(config, transition) {
  if (config.sound === "none") return undefined;
  if (config.sound === "auto") {
    if (transition.to === "blocked") return "request";
    if (transition.from === "working" && transition.to === "idle") return "done";
    return undefined;
  }
  return config.sound;
}

// Per-session notification decision: null means send nothing. Any session in
// the pane can trigger this, whether or not it is the one being viewed.
export function notificationForTransition({ config, transition }) {
  if (config.notify === "off") return null;
  const label = sessionLabel(transition);
  if (transition.to === "blocked" && transition.from !== "blocked") {
    return {
      title: "opencode needs input",
      body: `${label} waiting`,
      sound: resolveSound(config, transition),
    };
  }
  if (config.notify === "all" && transition.from === "working" && transition.to === "idle") {
    return {
      title: "opencode finished",
      body: `${label} finished`,
      sound: resolveSound(config, transition),
    };
  }
  return null;
}
