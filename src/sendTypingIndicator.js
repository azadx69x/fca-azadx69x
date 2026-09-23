"use strict";

const log = require("npmlog");
const utils = require("../utils");

const THREAD_LOOKUP_TIMEOUT = 5000;
const AUTO_STOP_DEFAULT = 10000;

function asThreadKey(threadID) {
  if (threadID === undefined || threadID === null || threadID === "")
    throw new Error("threadID is required");
  return String(threadID);
}

function getTypeCache(ctx) {
  if (!ctx.threadTypeCache || typeof ctx.threadTypeCache !== "object")
    ctx.threadTypeCache = Object.create(null);
  return ctx.threadTypeCache;
}

function rememberThreadType(ctx, threadID, isGroup, info) {
  const key = String(threadID);
  getTypeCache(ctx)[key] = Boolean(isGroup);

  if (!(ctx._threadMetadata instanceof Map)) ctx._threadMetadata = new Map();
  ctx._threadMetadata.set(key, {
    ...(ctx._threadMetadata.get(key) || {}),
    threadID: key,
    isGroup: Boolean(isGroup),
    threadName: info?.threadName || null,
    updatedAt: Date.now(),
  });

  if (!ctx._groupThreadIDs || typeof ctx._groupThreadIDs.add !== "function")
    ctx._groupThreadIDs = new Set();
  if (isGroup) ctx._groupThreadIDs.add(key);
  else ctx._groupThreadIDs.delete(key);
}

async function resolveThreadType(api, ctx, threadID, forcedType) {
  const key = String(threadID);
  if (typeof forcedType === "boolean") {
    rememberThreadType(ctx, key, forcedType);
    return forcedType;
  }

  const cache = getTypeCache(ctx);
  if (Object.prototype.hasOwnProperty.call(cache, key)) return Boolean(cache[key]);
  if (ctx._groupThreadIDs?.has?.(key)) {
    rememberThreadType(ctx, key, true);
    return true;
  }

  if (!ctx._typingThreadLookups) ctx._typingThreadLookups = new Map();
  if (ctx._typingThreadLookups.has(key)) return ctx._typingThreadLookups.get(key);

  const lookup = (async () => {
    try {
      if (typeof api?.getThreadInfo === "function") {
        const info = await utils.withTimeout(
          api.getThreadInfo(key),
          THREAD_LOOKUP_TIMEOUT,
          `thread type lookup for ${key}`
        );
        if (info && typeof info.isGroup === "boolean") {
          rememberThreadType(ctx, key, info.isGroup, info);
          return info.isGroup;
        }
      }
    }
    catch (error) {
      log.debug("sendTypingIndicator", `thread lookup failed for ${key}: ${error.message}`);
    }

    // This is only a last-resort fallback for deleted or inaccessible threads.
    const fallback = key.length >= 16;
    rememberThreadType(ctx, key, fallback);
    return fallback;
  })();

  ctx._typingThreadLookups.set(key, lookup);
  try {
    return await lookup;
  }
  finally {
    ctx._typingThreadLookups.delete(key);
  }
}

function publishMqtt(ctx, sendTyping, threadID, isGroup) {
  return new Promise((resolve, reject) => {
    if (!ctx.mqttClient || !ctx.mqttClient.connected) {
      reject(new Error("MQTT client not connected"));
      return;
    }

    const requestID = ++ctx.wsReqNumber;
    const payload = {
      thread_key: String(threadID),
      is_group_thread: isGroup ? 1 : 0,
      is_typing: sendTyping ? 1 : 0,
      attribution: 0,
      timestamp: Date.now(),
    };
    const request = {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        label: "3",
        payload: JSON.stringify(payload),
        version: "5849951561777440",
      }),
      request_id: requestID,
      type: 4,
    };

    try {
      ctx.mqttClient.publish(
        "/ls_req",
        JSON.stringify(request),
        { qos: 1, retain: false },
        (error) => error ? reject(error) : resolve({ method: "mqtt", requestID })
      );
    }
    catch (error) {
      reject(error);
    }
  });
}

async function publishHttp(defaultFuncs, ctx, sendTyping, threadID, isGroup) {
  if (typeof defaultFuncs?.post !== "function")
    throw new Error("HTTP typing fallback is unavailable");

  const form = {
    av: ctx.userID,
    fb_dtsg: ctx.fb_dtsg || ctx.globalOptions?.fb_dtsg || "",
    jazoest: ctx.jazoest || "",
    __a: 1,
    __req: "t",
    __be: 1,
    dpr: 1.5,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "ChatTypingMutation",
    doc_id: "2822256701439905",
    variables: JSON.stringify({
      input: {
        thread_id: isGroup ? String(threadID) : `user:${threadID}`,
        is_group_thread: Boolean(isGroup),
        is_typing: Boolean(sendTyping),
        actor_id: ctx.userID,
        client_mutation_id: String(Math.floor(Math.random() * 1000000)),
      },
    }),
  };

  const response = await defaultFuncs.post(
    "https://www.facebook.com/api/graphql/",
    ctx.jar,
    form,
    ctx.globalOptions || {}
  );
  const body = typeof response === "string" ? response : response?.body ?? response;
  const parsed = body && typeof body === "object"
    ? body
    : utils.safeJsonParse
      ? utils.safeJsonParse(String(body).replace(/^for\s*\([^;]+;\);?/, ""), null)
      : null;
  if (parsed?.errors?.length) throw new Error(parsed.errors[0].message || "GraphQL typing error");
  return { method: "http" };
}

function publishLegacy(ctx, sendTyping, threadID, isGroup) {
  return new Promise((resolve, reject) => {
    if (!ctx.mqttClient || !ctx.mqttClient.connected) {
      reject(new Error("MQTT client not connected"));
      return;
    }

    const topic = isGroup ? "/thread_typing" : "/orca_typing_notifications";
    const payload = {
      type: "typ",
      thread_key: String(threadID),
      is_group_thread: Boolean(isGroup),
      is_typing: Boolean(sendTyping),
      sender_fbid: ctx.userID,
      timestamp: Date.now(),
    };

    try {
      ctx.mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve({ method: "legacy" });
      });
    }
    catch (error) {
      reject(error);
    }
  });
}

function clearTypingTimer(ctx, key) {
  const current = ctx.typingCounters?.get(key);
  if (current?.timer) clearTimeout(current.timer);
  ctx.typingCounters?.delete(key);
}

module.exports = function (defaultFuncs, api, ctx) {
  if (typeof ctx.wsReqNumber !== "number") ctx.wsReqNumber = 0;
  if (!(ctx.typingCounters instanceof Map)) ctx.typingCounters = new Map();

  return async function sendTypingIndicator(sendTyping, threadID, callback, options = {}) {
    options = options && typeof options === "object" ? options : {};
    const hasCallback = typeof callback === "function";
    const autoStopValue = Number(options.autoStop);
    const autoStop = Number.isFinite(autoStopValue) ? autoStopValue : AUTO_STOP_DEFAULT;
    const finish = hasCallback ? callback : () => {};

    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    try {
      if (typeof sendTyping !== "boolean" && typeof sendTyping !== "number")
        throw new Error("sendTyping must be boolean (true/false) or 0/1");

      const threadIDs = Array.isArray(threadID) ? threadID : [threadID];
      if (!threadIDs.length) throw new Error("threadID is required");
      const keys = threadIDs.map(asThreadKey);
      const isTyping = Boolean(sendTyping);
      const types = await Promise.all(
        keys.map((key) => resolveThreadType(api, ctx, key, options.isGroup))
      );

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const isGroup = types[i];
        clearTypingTimer(ctx, key);

        try {
          await publishMqtt(ctx, isTyping, key, isGroup);
        }
        catch (mqttError) {
          log.warn("sendTypingIndicator", `MQTT failed for ${key}: ${mqttError.message}`);
          try {
            await publishHttp(defaultFuncs, ctx, isTyping, key, isGroup);
          }
          catch (httpError) {
            log.warn("sendTypingIndicator", `HTTP failed for ${key}: ${httpError.message}`);
            await publishLegacy(ctx, isTyping, key, isGroup);
          }
        }

        if (isTyping && autoStop > 0) {
          const timer = setTimeout(() => {
            publishMqtt(ctx, false, key, isGroup).catch(() => {});
            ctx.typingCounters.delete(key);
          }, autoStop);
          ctx.typingCounters.set(key, { timer, startedAt: Date.now(), isGroup });
        }
      }

      // Keep the established API contract: success resolves/callbacks with true.
      try { finish(null, true); } catch (error) { log.error("sendTypingIndicator", error); }
      resolveResult(true);
    }
    catch (error) {
      log.error("sendTypingIndicator", error);
      try { finish(error); } catch (callbackError) { log.error("sendTypingIndicator", callbackError); }
      // Callback callers commonly ignore the returned promise.
      if (hasCallback) resolveResult(false);
      else rejectResult(error);
    }

    return resultPromise;
  };
};
