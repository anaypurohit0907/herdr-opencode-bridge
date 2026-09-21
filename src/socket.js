import net from "node:net";

function endpoint(socketPath) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

// Fire-and-forget request. Resolves true when the server answered.
export function request(socketPath, method, params, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(ok);
    };
    const client = net.createConnection(endpoint(socketPath), () => {
      client.write(`${JSON.stringify({ id: `${method}:${Date.now()}`, method, params })}\n`);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    client.on("data", () => finish(true));
    client.on("error", () => finish(false));
    client.on("end", () => finish(false));
    client.on("close", () => finish(false));
  });
}

// Request that returns the parsed JSON response, or null on any failure.
export function call(socketPath, method, params, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(value);
    };
    const client = net.createConnection(endpoint(socketPath), () => {
      client.write(`${JSON.stringify({ id: `${method}:${Date.now()}`, method, params })}\n`);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    client.on("data", (chunk) => {
      buffer += chunk;
    });
    client.on("close", () => {
      try {
        finish(JSON.parse(buffer.trim()));
      } catch {
        finish(null);
      }
    });
    client.on("error", () => finish(null));
  });
}

export function reportAgent({ paneId, socketPath, source, agent, state, seq, message }) {
  const params = { pane_id: paneId, source, agent, seq, state };
  if (message) params.message = message;
  return request(socketPath, "pane.report_agent", params);
}

export function readPane(socketPath, paneId) {
  return call(socketPath, "pane.get", { pane_id: paneId });
}
