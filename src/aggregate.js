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

function setState(model, rootID, state, now) {
  if (!rootID) return;
  const root = model.roots[rootID] ?? { state: "unknown", at: 0 };
  if (root.state === state) {
    root.at = now;
    return;
  }
  model.roots[rootID] = { state, at: now };
}

function touch(model, rootID, now) {
  const root = model.roots[rootID];
  if (root) root.at = now;
}

export function registerSession(model, info) {
  if (!info?.id) return;
  model.sessions[info.id] = { id: info.id, parentID: info.parentID };
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

export function applyEvent(model, event, now = Date.now()) {
  const type = event?.type;
  const properties = event?.properties ?? {};
  if (properties.info?.id) registerSession(model, properties.info);

  const sessionID = sessionIDFromProperties(properties);
  if (type === "session.deleted") {
    removeSession(model, sessionID);
    return;
  }
  if (!sessionID) return;

  const rootID = rootOf(model, sessionID);
  if (!rootID) return;
  if (sessionID !== rootID) {
    const childState = CHILD_EVENT_STATES[type];
    if (childState) setState(model, rootID, childState, now);
    return;
  }

  if (type === "session.status") {
    const state = statusToState(properties.status);
    if (state) setState(model, rootID, state, now);
    return;
  }
  const state = ROOT_EVENT_STATES[type];
  if (state) setState(model, rootID, state, now);
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
