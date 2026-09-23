"use strict";
/**
 * Made by @Azadx69x 
 * fca-azadx69x
 * update as Thursday, 22 September 2026
 * do not remove the author name to get more updates
 */

const storage = require("./storage");

const FINGERPRINT_FILE = "session_fingerprint.json";
const RATE_FILE = "request_rate.json";

/**
 * A small set of *consistent* desktop fingerprints. Every field of one entry
 * must be used together — never mix a Chrome UA with Firefox sec-ch-ua.
 */
const FINGERPRINTS = [
  {
    id: "win-chrome-126",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    platform: '"Windows"',
    mobile: "?0",
    secChUa: '"Not_A Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    locale: "en-US",
    timezone: "Asia/Dhaka",
  },
  {
    id: "win-chrome-125",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    platform: '"Windows"',
    mobile: "?0",
    secChUa: '"Not_A Brand";v="8", "Chromium";v="125", "Google Chrome";v="125"',
    locale: "en-US",
    timezone: "Asia/Dhaka",
  },
  {
    id: "mac-chrome-126",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    platform: '"macOS"',
    mobile: "?0",
    secChUa: '"Not_A Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    locale: "en-US",
    timezone: "Asia/Dhaka",
  },
];

/** A stable, header set built from one fingerprint. */
function buildHeaders(fp, url, customHeader = {}) {
  const headers = {
    host: safeHostname(url),
    "User-Agent": fp.userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": `${fp.locale},en;q=0.9`,
    // The `request` library only auto-decompresses gzip/deflate. Advertising
    // "br" makes Facebook reply with Brotli, which stays undecoded binary and
    // breaks every JSON.parse. Keep the original gzip/deflate pair.
    "Accept-Encoding": "gzip, deflate",
    "sec-ch-ua": fp.secChUa,
    "sec-ch-ua-mobile": fp.mobile,
    "sec-ch-ua-platform": fp.platform,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
    DNT: "1",
  };

  if (!customHeader.noRef) {
    headers.referer = customHeader.referer || "https://www.facebook.com/";
    headers.origin = "https://www.facebook.com";
  }

  Object.assign(headers, customHeader);
  return headers;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "www.facebook.com";
  }
}

function pickFingerprint(userID) {
  if (!userID) {
    return FINGERPRINTS[Math.floor(Math.random() * FINGERPRINTS.length)];
  }

  // Reuse the fingerprint we already stored for this account, so the same
  // cookie set always presents the same browser.
  let all = {};
  try {
    all = storage.readJson(FINGERPRINT_FILE, {});
    const stored = all[userID];
    if (stored && stored.id) {
      const known = FINGERPRINTS.find((fp) => fp.id === stored.id);
      if (known) return known;
    }
  } catch (_) {
    all = {};
  }

  // Prefer a fingerprint no other account in this state file is already using,
  // so two accounts on one host never present the same browser fingerprint.
  const used = new Set(
    Object.values(all).map((entry) => entry && entry.id).filter(Boolean)
  );
  const free = FINGERPRINTS.filter((fp) => !used.has(fp.id));
  const pool = free.length ? free : FINGERPRINTS;
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  try {
    all[userID] = { id: chosen.id, assignedAt: new Date().toISOString() };
    storage.writeJson(FINGERPRINT_FILE, all);
  } catch (_) {
    /* non-fatal: fingerprint still applies for this process */
  }
  return chosen;
}

/**
 * Resolve the fingerprint for a context, caching it on ctx so a running
 * process never re-reads the file per request.
 */
function fingerprintFor(ctx) {
  if (!ctx) {
    if (!module.exports._fallbackFingerprint) {
      module.exports._fallbackFingerprint = pickFingerprint(null);
    }
    return module.exports._fallbackFingerprint;
  }
  if (!ctx._fingerprint) {
    ctx._fingerprint = pickFingerprint(ctx.userID);
  }
  return ctx._fingerprint;
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

const DEFAULT_LIMITS = {
  // Minimum spacing between two requests of the same class, in ms.
  minGapMs: 900,
  // Absolute ceiling of requests inside any rolling 60s window.
  maxPerMinute: 40,
  // Extra pause applied after a burst.
  burstCooldownMs: 4000,
};

const requestWindows = new Map();

/** Deterministic-but-human jitter: jagged, never a fixed rhythm. */
function humanJitter(baseMs) {
  const spread = baseMs * 0.6;
  return Math.round(baseMs + Math.random() * spread);
}

function rollingCount(key, now) {
  const window = requestWindows.get(key) || [];
  const fresh = window.filter((ts) => now - ts < 60000);
  requestWindows.set(key, fresh);
  return fresh;
}

/**
 * Wait until it is safe to issue another request for this account.
 * Respects both the minimum gap and the per-minute ceiling.
 */
async function awaitSlot(ctx, limits = {}) {
  const opts = { ...DEFAULT_LIMITS, ...limits };
  const key = (ctx && ctx.userID) || "global";
  const now = Date.now();
  const window = rollingCount(key, now);

  if (window.length >= opts.maxPerMinute) {
    const oldest = window[0];
    const wait = Math.max(1000, 60000 - (now - oldest) + humanJitter(500));
    await sleep(wait);
    return awaitSlot(ctx, limits);
  }

  const last = ctx && ctx._lastRequestAt ? ctx._lastRequestAt : 0;
  const gap = now - last;
  const required = opts.minGapMs + humanJitter(300);
  if (gap < required) await sleep(required - gap);

  const stamp = Date.now();
  const fresh = rollingCount(key, stamp);
  fresh.push(stamp);
  if (ctx) ctx._lastRequestAt = stamp;
  requestWindows.set(key, fresh);

  // Occasional longer pause, the way a human reads a thread before replying.
  if (fresh.length % 25 === 0) await sleep(humanJitter(opts.burstCooldownMs));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRateSnapshot(ctx) {
  const key = (ctx && ctx.userID) || "global";
  const window = rollingCount(key, Date.now());
  return {
    requestsLastMinute: window.length,
    lastRequestAt: (ctx && ctx._lastRequestAt) || null,
    minGapMs: DEFAULT_LIMITS.minGapMs,
    maxPerMinute: DEFAULT_LIMITS.maxPerMinute,
  };
}

/* ------------------------------------------------------------------ *
 * Quiet keep-warm
 * ------------------------------------------------------------------ */

/**
 * A single lightweight "poke" that renews the session without doing anything
 * visible: loads the home page and lets utils.updateDTSG refresh the tokens.
 * Deliberately cheap — one GET, no MQTT traffic, no presence change.
 */
async function warmSession(ctx, jar, utils, globalOptions) {
  if (!ctx || !jar || ctx.loggedIn === false) return { ok: false, skipped: true };
  try {
    await awaitSlot(ctx);
    const res = await utils.get("https://www.facebook.com/", jar, null, globalOptions, {
      noRef: false,
    });
    const body = typeof res?.body === "string" ? res.body : "";
    const locked = /checkpoint|unvetted|automated behavior/i.test(body) && /\/checkpoint/i.test(body);
    return { ok: !locked, statusCode: res?.statusCode || null, warm: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Schedules the warm-up loop. Uses a self-rescheduling timeout (not cron) so
 * the interval can be randomised every cycle and never fires in tight clusters.
 * Returns a handle with .stop().
 */
function startWarmLoop(ctx, jar, utils, globalOptions, options = {}) {
  const minMinutes = Number(options.minMinutes) || 25;
  const maxMinutes = Number(options.maxMinutes) || 55;
  let stopped = false;
  let handle = null;

  const nextDelay = () =>
    humanJitter(((minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60000)) | 0;

  const tick = async () => {
    if (stopped) return;
    const result = await warmSession(ctx, jar, utils, globalOptions);
    if (utils && typeof utils.log === "function") {
      if (result.warm) utils.log("antiSuspension", `Session warmed for ${ctx.userID}`);
      else if (!result.skipped) utils.warn("antiSuspension", `Warm-up skipped: ${result.error || "checkpoint"}`);
    }
    if (!stopped) handle = setTimeout(tick, nextDelay());
  };

  handle = setTimeout(tick, nextDelay());

  return {
    stop() {
      stopped = true;
      if (handle) clearTimeout(handle);
      handle = null;
    },
    get running() {
      return !stopped;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Logout prevention
 * ------------------------------------------------------------------ */

/**
 * Facebook sends these when it is about to kill the session. Catching them
 * lets us refresh tokens instead of losing the account.
 */
function classifySessionSignal(error) {
  const text = `${error?.error || ""} ${error?.errorDescription || ""} ${error?.message || ""}`.toLowerCase();
  const code = Number(error?.error || error?.code);
  const status = Number(error?.statusCode || error?.status || error?.response?.status) || 0;

  if (code === 1357001 || /blocked the login|not logged in/.test(text)) {
    return { kind: "blocked", action: "stop", fatal: true };
  }
  if (/checkpoint|unvetted|identity/.test(text)) {
    return { kind: "checkpoint", action: "pause", fatal: false };
  }
  if (status === 401 || status === 403) {
    return { kind: "expired", action: "refresh", fatal: false };
  }
  if (/session (expired|invalid)|please (log|re-?login)/.test(text)) {
    return { kind: "expired", action: "refresh", fatal: false };
  }
  return { kind: "unknown", action: "ignore", fatal: false };
}

module.exports = {
  FINGERPRINTS,
  DEFAULT_LIMITS,
  buildHeaders,
  fingerprintFor,
  pickFingerprint,
  awaitSlot,
  humanJitter,
  getRateSnapshot,
  warmSession,
  startWarmLoop,
  classifySessionSignal,
  sleep,
};
