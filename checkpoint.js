"use strict"; 
/**
 * Made by @Azadx69x 
 * fca-azadx69x
 * update as Thursday, 22 September 2026
 * do not remove the author name to get more updates
 */

const fs = require("fs");
const storage = require("./storage");

const STATE_FILE = storage.statePath("checkpoint_state.json");

/** Known checkpoint flows, keyed by the numeric flow id in the checkpoint URL. */
const CHECKPOINT_TYPES = {
  "601051028565049": {
    id: "automated_behavior",
    label: "Automated behavior warning (scraping warning)",
    severity: "warning",
    bypassable: true,
  },
  "828281030927956": {
    id: "account_locked",
    label: "Account locked — identity/unvetted flow",
    severity: "blocked",
    bypassable: false,
  },
  "1501092823525282": {
    id: "account_suspended",
    label: "Account suspended — community standards",
    severity: "blocked",
    bypassable: false,
  },
  "1339039300213622": {
    id: "device_approval",
    label: "Login approval / new device confirmation required",
    severity: "blocked",
    bypassable: false,
  },
  "828281030927956_2fa": {
    id: "two_factor",
    label: "Two-factor authentication required",
    severity: "blocked",
    bypassable: false,
  },
};

const UNKNOWN_TYPE = {
  id: "unknown_checkpoint",
  label: "Unknown checkpoint",
  severity: "blocked",
  bypassable: false,
};

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeBody(res) {
  if (typeof res?.body === "string") return res.body;
  if (Buffer.isBuffer(res?.body)) return res.body.toString("utf8");
  if (res?.body && typeof res.body === "object") {
    try { return JSON.stringify(res.body); } catch { return ""; }
  }
  return "";
}

function currentUrl(res) {
  return res?.request?.uri?.href ||
    res?.request?.href ||
    res?.url ||
    res?.responseUrl ||
    res?.headers?.location ||
    "";
}

function resolveUID(appState, userID) {
  if (userID) return String(userID);
  if (!Array.isArray(appState)) return "unknown";
  const c = appState.find((i) =>
    i?.key === "i_user" || i?.name === "i_user" || i?.key === "c_user" || i?.name === "c_user"
  );
  return c?.value == null ? "unknown" : String(c.value);
}

/** Pull the tokens needed for any checkpoint mutation out of the HTML. */
function extractTokens(body, utils) {
  const from = (start, end) => {
    try { return utils.getFrom(body, start, end) || ""; } catch { return ""; }
  };
  const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== "") || null;
  const fb_dtsg = first(
    from('["DTSGInitData",[],{"token":"', '","'),
    body.match(/DTSGInitData[^\n]{0,160}?token["']?\s*[:=]\s*["']([^"']+)/i)?.[1],
    body.match(/["']fb_dtsg["']\s*[:=]\s*["']([^"']+)/i)?.[1],
    body.match(/name=["']fb_dtsg["'][^>]*value=["']([^"']+)/i)?.[1]
  );
  const jazoest = first(
    from("jazoest=", '",'),
    body.match(/name=["']jazoest["'][^>]*value=["']([^"']+)/i)?.[1],
    body.match(/(?:jazoest|jazoest_token)["']?\s*[:=]\s*["']?(\d+)/i)?.[1]
  );
  const lsd = first(
    from('["LSD",[],{"token":"', '"}'),
    body.match(/(?:\["LSD"[^\n]{0,120}?token|lsd)["']?\s*[:=]\s*["']([^"']+)/i)?.[1],
    body.match(/name=["']lsd["'][^>]*value=["']([^"']+)/i)?.[1]
  );
  return { fb_dtsg, jazoest, lsd };
}

/**
 * Classify a response. Returns null when the response is not a checkpoint.
 */
function detect(res, appState, userID) {
  const url = currentUrl(res);
  const body = safeBody(res);
  const text = body.toLowerCase();
  const uid = resolveUID(appState, userID);
  const statusCode = Number(res?.statusCode || res?.status || 0) || null;

  const isCheckpointUrl = /\/checkpoint(?:\/|\?|$)/i.test(url);
  const isBlockPage = /checkpoint\/block|checkpoint_required|checkpoint.*(?:blocked|suspended|locked)/i.test(text);
  const isTwoFactor =
    /checkpoint(?:\/|\?|_)/i.test(text) &&
    /approvals_code|two_step_verification|two-factor|security code|login approval/i.test(text);
  const hasKnownCheckpointText =
    /automated behavior|scraping warning|unusual activity|suspicious activity|account suspended|account locked/i.test(text);

  if (!isCheckpointUrl && !isBlockPage && !isTwoFactor && !hasKnownCheckpointText) return null;

  let type = UNKNOWN_TYPE;
  const urlFlowId = url.match(/checkpoint\/[^/?#]*?(\d{6,})/i)?.[1];
  const bodyFlowId = body.match(/(?:flow[_-]?id|checkpoint_id)["']?\s*[:=]\s*["']?(\d{6,})/i)?.[1];
  let flowId = urlFlowId || bodyFlowId || null;
  for (const key of Object.keys(CHECKPOINT_TYPES)) {
    if (url.includes(key)) {
      flowId = key;
      type = CHECKPOINT_TYPES[key];
      break;
    }
  }
  if (!flowId && isTwoFactor) type = CHECKPOINT_TYPES["828281030927956_2fa"];
  if (type === UNKNOWN_TYPE) {
    if (/automated behavior|scraping warning|unusual activity|suspicious activity/i.test(text))
      type = CHECKPOINT_TYPES["601051028565049"];
    else if (/suspend|community standards/i.test(text))
      type = CHECKPOINT_TYPES["1501092823525282"];
    else if (/locked|unvetted/i.test(text))
      type = CHECKPOINT_TYPES["828281030927956"];
    else if (/device approval|login approval|security code/i.test(text))
      type = CHECKPOINT_TYPES["1339039300213622"];
  }

  return {
    checkpoint: true,
    uid,
    url,
    flowId,
    type: type.id,
    label: type.label,
    severity: type.severity,
    bypassable: type.bypassable,
    reasons: extractReasons(type.id, body),
    statusCode,
    detectedAt: new Date().toISOString(),
  };
}

/** Human-readable reasons, per checkpoint type. */
function extractReasons(typeId, body) {
  const reasons = {};

  if (typeId === "account_suspended") {
    const duration = body.match(/"log_out_uri":"(.*?)","title":"(.*?)"/);
    if (duration?.[2]) reasons.durationInfo = duration[2];
    const long = body.match(/"reason_section_body":"(.*?)"/);
    if (long?.[1]) {
      reasons.longReason = long[1];
      const short = long[1]
        .toLowerCase()
        .replace(
          "your account, or activity on it, doesn't follow our community standards on ",
          ""
        );
      reasons.shortReason = short.charAt(0).toUpperCase() + short.slice(1);
    }
  }

  if (typeId === "account_locked") {
    const lock = body.match(/"is_unvetted_flow":true,"title":"(.*?)"/);
    if (lock?.[1]) reasons.reason = lock[1];
  }

  if (typeId === "device_approval") {
    const t = body.match(/"title":"(.*?)"/);
    if (t?.[1]) reasons.reason = t[1];
  }

  if (!reasons.reason && !reasons.longReason) {
    const generic = body.match(/<title>(.*?)<\/title>/);
    if (generic?.[1]) reasons.pageTitle = generic[1];
  }

  return reasons;
}

/** Persist per-account checkpoint status so the bot can decide to retry later. */
function saveState(uid, entry, utils) {
  try {
    const all = storage.readJson("checkpoint_state.json", {});
    const prev = all[uid] || {};
    all[uid] = {
      ...entry,
      attempts: entry.type === prev.type ? (prev.attempts || 0) + 1 : 1,
      firstSeenAt: entry.type === prev.type ? prev.firstSeenAt || entry.detectedAt : entry.detectedAt,
    };
    storage.writeJson("checkpoint_state.json", all);
    return all[uid];
  } catch (e) {
    utils?.warn?.(`checkpoint: could not save state: ${e.message}`);
    return entry;
  }
}

function readState(uid) {
  try {
    const all = storage.readJson("checkpoint_state.json", {});
    return uid ? all[uid] || null : all;
  } catch {
    return null;
  }
}

function clearState(uid) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const all = storage.readJson("checkpoint_state.json", {});
    if (uid) delete all[uid];
    storage.writeJson("checkpoint_state.json", uid ? all : {});
  } catch {
    /* ignore */
  }
}

function report(info, utils) {
  const log = info.severity === "blocked" ? utils.error : utils.warn;
  log(`Checkpoint on ${info.uid}:`, `${info.label} (${info.type})`);
  if (info.flowId) log("Checkpoint flow id:", info.flowId);
  Object.entries(info.reasons || {}).forEach(([k, v]) => log(`  ${k}:`, v));
  if (!info.bypassable) {
    utils.error(
      "Action required:",
      "open https://www.facebook.com in a browser with this account and clear the checkpoint manually."
    );
  }
}

/** Bypass state, tracked per account so one bad account can't stall the rest. */
const bypassTracker = new Map();
const MAX_BYPASS_RETRIES = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

function tracker(uid) {
  if (!bypassTracker.has(uid)) bypassTracker.set(uid, { count: 0, cooldownUntil: 0 });
  return bypassTracker.get(uid);
}

function getStatus(uid) {
  const key = uid == null ? null : String(uid);
  const current = key ? tracker(key) : null;
  return {
    uid: key,
    state: key ? readState(key) : readState(),
    bypassAttempts: current?.count || 0,
    cooldownUntil: current?.cooldownUntil || 0,
    coolingDown: Boolean(current && Date.now() < current.cooldownUntil),
  };
}

function resetBypass(uid) {
  if (uid == null) return bypassTracker.clear();
  bypassTracker.delete(String(uid));
}

/**
 * Attempt the scraping-warning dismissal mutation.
 * Returns { bypassed, response }.
 */
async function bypass(res, { jar, appState, userID, globalOptions, utils, throttle }) {
  const uid = resolveUID(appState, userID);
  const t = tracker(uid);

  if (Date.now() < t.cooldownUntil) {
    utils.warn(
      `checkpoint: bypass for ${uid} is cooling down for ${Math.ceil(
        (t.cooldownUntil - Date.now()) / 1000
      )}s`
    );
    return { bypassed: false, response: res };
  }

  if (t.count >= MAX_BYPASS_RETRIES) {
    t.count = 0;
    t.cooldownUntil = Date.now() + COOLDOWN_MS;
    utils.warn(`checkpoint: max bypass retries reached for ${uid}, cooling down 5 minutes`);
    return { bypassed: false, response: res };
  }

  const { fb_dtsg, jazoest, lsd } = extractTokens(safeBody(res), utils);
  if (!fb_dtsg || !jazoest) {
    utils.warn("checkpoint: missing fb_dtsg/jazoest, cannot dismiss warning");
    return { bypassed: false, response: res };
  }

  // Exponential backoff with jitter before each attempt.
  const backoff = Math.min(3000 * 2 ** t.count, 60000) + getRandomInt(500, 3000);
  await sleep(backoff);
  if (typeof throttle === "function") await throttle();

  const form = {
    av: uid,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "FBScrapingWarningMutation",
    variables: JSON.stringify({}),
    server_timestamps: true,
    doc_id: 6339492849481770,
    fb_dtsg,
    jazoest,
    lsd,
  };

  t.count += 1;

  try {
    const posted = await utils
      .post("https://www.facebook.com/api/graphql/", jar, form, globalOptions)
      .then(utils.saveCookies(jar));

    // Verify: re-load home and confirm we are no longer on a checkpoint.
    if (typeof throttle === "function") await throttle();
    const verify = await utils
      .get("https://www.facebook.com/", jar, null, globalOptions, { noRef: true })
      .then(utils.saveCookies(jar));

    const still = detect(verify, appState, uid);
    if (still && still.type === "automated_behavior") {
      utils.warn(
        `checkpoint: warning still present after attempt ${t.count}/${MAX_BYPASS_RETRIES}`
      );
      return { bypassed: false, response: verify };
    }

    t.count = 0;
    t.cooldownUntil = 0;
    clearState(uid);
    utils.log(`checkpoint: automated behavior warning dismissed for ${uid}`);
    return { bypassed: true, response: verify || posted };
  } catch (e) {
    utils.error("checkpoint: bypass request failed:", e.message || e);
    return { bypassed: false, response: res };
  }
}

/**
 * Main entry point. Always safe to call on any response.
 *
 * Returns:
 *   { checkpoint: false }                                     — clean response
 *   { checkpoint: true, bypassed: true, response }             — handled, keep going
 *   { checkpoint: true, blocked: true, ...info }               — cannot continue
 */
async function handle(res, opts = {}) {
  const { utils } = opts;
  if (!utils) throw new Error("checkpoint.handle: utils is required");

  let info;
  try {
    info = detect(res, opts.appState, opts.userID);
  } catch (e) {
    utils.error("checkpoint: detection failed:", e.message);
    return { checkpoint: false, response: res };
  }

  if (!info) return { checkpoint: false, response: res };

  report(info, utils);
  const stored = saveState(info.uid, info, utils);

  if (info.bypassable) {
    const { bypassed, response } = await bypass(res, opts);
    if (bypassed) return { checkpoint: true, bypassed: true, response };
    return {
      checkpoint: true,
      blocked: true,
      bypassed: false,
      response,
      ...info,
      attempts: stored.attempts,
      error: `${info.label} could not be dismissed automatically.`,
    };
  }

  return {
    checkpoint: true,
    blocked: true,
    bypassed: false,
    response: res,
    ...info,
    attempts: stored.attempts,
    error: info.label,
  };
}

module.exports = {
  handle,
  detect,
  bypass,
  report,
  readState,
  getStatus,
  resetBypass,
  clearState,
  extractTokens,
  CHECKPOINT_TYPES,
  STATE_FILE,
};
