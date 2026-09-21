import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
  // "off" | "blocked" | "all" — when to send a herdr notification.
  notify: "blocked",
  // "none" | "done" | "request" — herdr notification sound.
  sound: "none",
  // Show per-session counts in the sidebar agent label (zero config needed).
  display: true,
};

const CONFIG_PATH = join(homedir(), ".config", "opencode", "herdr-bridge.json");

function readFileConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

// Precedence: file config, then legacy env overrides.
export function loadConfig(env = process.env) {
  const config = { ...DEFAULTS, ...readFileConfig() };
  if (env.HERDR_BRIDGE_NOTIFY !== undefined) {
    config.notify = env.HERDR_BRIDGE_NOTIFY === "1" ? "blocked" : "off";
  }
  if (env.HERDR_BRIDGE_SOUND) config.sound = env.HERDR_BRIDGE_SOUND;
  if (env.HERDR_BRIDGE_DISPLAY === "0") config.display = false;
  return config;
}

export function configPath() {
  return CONFIG_PATH;
}
