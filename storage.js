"use strict";
/**
 * Made by @Azadx69x 
 * fca-azadx69x
 * update as Thursday, 22 September 2026
 * do not remove the author name to get more updates
 */

const fs = require("fs");
const path = require("path");

/**
 * Small, dependency-free storage layer for FCA runtime state.
 *
 * The default directory intentionally remains process.cwd() for backwards
 * compatibility. Set FCA_STATE_DIR when the host has a dedicated writable
 * data directory.
 */
function stateDir() {
  const configured = String(process.env.FCA_STATE_DIR || "").trim();
  return configured ? path.resolve(process.cwd(), configured) : process.cwd();
}

function statePath(fileName) {
  if (!fileName || typeof fileName !== "string") {
    throw new TypeError("storage.statePath: fileName must be a string");
  }
  return path.join(stateDir(), path.basename(fileName));
}

function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(fileName, fallback = {}) {
  try {
    const file = statePath(fileName);
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeJson(fileName, value) {
  const file = statePath(fileName);
  ensureStateDir();
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  return file;
}

function remove(fileName) {
  try {
    const file = statePath(fileName);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  stateDir,
  statePath,
  ensureStateDir,
  readJson,
  writeJson,
  remove,
};
