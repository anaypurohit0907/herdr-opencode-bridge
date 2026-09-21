import { appendFileSync } from "node:fs";
import {
  aggregate,
  applyChatMessage,
  applyEvent,
  createModel,
  describeAggregate,
  hasSessions,
} from "./aggregate.js";
import { readPane, reportAgent } from "./socket.js";

export const SOURCE = "opencode:herdr-bridge";
export const AGENT = "opencode";
const DEBUG = process.env.HERDR_BRIDGE_DEBUG === "1";
const VERIFY_DELAY_MS = 150;

function debug(line) {
  if (!DEBUG) return;
  try {
    appendFileSync(
      "/tmp/opencode/herdr-opencode-bridge.log",
      `${new Date().toISOString()} ${line}\n`,
    );
  } catch {
    // Debug logging must never affect the plugin.
  }
}

// High-frequency streaming events are not state-relevant; logging them would
// both drown the trace and add file I/O to every delta.
function isStateEvent(type) {
  if (typeof type !== "string" || !type) return false;
  return !type.startsWith("message.") && !type.startsWith("plugin.");
}

// Herdr renders an unseen idle as "done"; both mean ready for input.
function normalize(state) {
  return state === "done" ? "idle" : state;
}

// opencode V1 plugin entry. Returns no hooks when not running inside a
// Herdr-managed pane, so the plugin is inert everywhere else.
export const HerdrOpencodeBridge = async () => {
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath) {
    debug("inert: not inside a herdr pane");
    return {};
  }
  debug(`loaded pane=${paneId}`);

  const model = createModel();
  let seq = Date.now() * 1000;
  let lastReport;
  let chain = Promise.resolve();
  let verifyTimer;
  let activeTimer;

  const send = async (state, message) => {
    const ok = await reportAgent({
      paneId,
      socketPath,
      source: SOURCE,
      agent: AGENT,
      state,
      seq: (seq += 1),
      message,
    });
    debug(`report state=${state} seq=${seq} ok=${ok} ${message}`);
    return ok;
  };

  // The official integration can overwrite the pane after us, including when
  // our own aggregate did not change. Read back and correct until the pane
  // matches the aggregate; a periodic pass covers bursts with no new events.
  const verifyNow = async () => {
    if (!hasSessions(model)) return;
    const summary = aggregate(model);
    if (summary.state === "unknown") return;
    const response = await readPane(socketPath, paneId);
    const current = response?.result?.pane?.agent_status;
    if (current === undefined || normalize(current) === normalize(summary.state)) return;
    debug(`verify mismatch expected=${summary.state} actual=${current} -> correcting`);
    await send(summary.state, describeAggregate(summary));
    scheduleVerify();
  };

  const scheduleVerify = () => {
    if (verifyTimer) return;
    verifyTimer = setTimeout(async () => {
      verifyTimer = undefined;
      await verifyNow();
    }, VERIFY_DELAY_MS);
    verifyTimer.unref?.();
  };

  // While any session is working or blocked, keep a slow reconcile running so
  // a late write from another reporter cannot stick.
  const syncReconcile = (state) => {
    const active = state === "working" || state === "blocked";
    if (active && !activeTimer) {
      activeTimer = setInterval(() => void verifyNow(), 500);
      activeTimer.unref?.();
    } else if (!active && activeTimer) {
      clearInterval(activeTimer);
      activeTimer = undefined;
    }
  };

  const flush = () => {
    if (!hasSessions(model)) return chain;
    const summary = aggregate(model);
    syncReconcile(summary.state);
    if (summary.state !== "unknown") {
      const key = `${summary.state}|${summary.primary ?? ""}`;
      if (key !== lastReport) {
        lastReport = key;
        const message = describeAggregate(summary);
        chain = chain.then(() => send(summary.state, message)).catch(() => {});
      }
    }
    scheduleVerify();
    return chain;
  };

  return {
    "chat.message": async ({ sessionID }) => {
      debug(`chat.message session=${sessionID}`);
      applyChatMessage(model, sessionID);
      await flush();
    },
    event: async ({ event }) => {
      const type = event?.type;
      if (isStateEvent(type)) {
        debug(`event type=${type} session=${event?.properties?.sessionID ?? ""}`);
      }
      applyEvent(model, event);
      await flush();
    },
  };
};

// V2 keeps the same shared-server semantics as the official integration:
// lifecycle reporting belongs to the pane-local TUI, so setup() stays empty.
export default {
  id: "opencode.herdr-bridge",
  server: HerdrOpencodeBridge,
  setup() {},
};
