"use strict";

function keyOf(threadID) {
  if (threadID === undefined || threadID === null || threadID === "") {
    throw new TypeError("thread cache requires a threadID");
  }
  return String(threadID);
}

function copy(value) {
  if (!value || typeof value !== "object") return value;
  return { ...value };
}

module.exports = function (defaultFuncs, api, ctx) {
  function metadata() {
    if (!(ctx._threadMetadata instanceof Map)) ctx._threadMetadata = new Map();
    return ctx._threadMetadata;
  }

  function getThreadMetadata(threadID) {
    return copy(metadata().get(keyOf(threadID))) || null;
  }

  function setThreadMetadata(threadID, value = {}) {
    const key = keyOf(threadID);
    const next = {
      ...(metadata().get(key) || {}),
      ...(value && typeof value === "object" ? value : {}),
      threadID: key,
      updatedAt: Date.now(),
    };
    metadata().set(key, next);

    if (typeof next.isGroup === "boolean") {
      if (!ctx.threadTypeCache) ctx.threadTypeCache = Object.create(null);
      ctx.threadTypeCache[key] = next.isGroup;
      if (!ctx._groupThreadIDs || typeof ctx._groupThreadIDs.add !== "function") {
        ctx._groupThreadIDs = new Set();
      }
      if (next.isGroup) ctx._groupThreadIDs.add(key);
      else ctx._groupThreadIDs.delete(key);
    }
    return copy(next);
  }

  function markGroupThread(threadID, isGroup = true) {
    return setThreadMetadata(threadID, { isGroup: Boolean(isGroup) });
  }

  function getCachedThreadType(threadID) {
    const key = keyOf(threadID);
    const known = metadata().get(key);
    if (known && typeof known.isGroup === "boolean") return known.isGroup;
    if (ctx.threadTypeCache && Object.prototype.hasOwnProperty.call(ctx.threadTypeCache, key)) {
      return Boolean(ctx.threadTypeCache[key]);
    }
    if (ctx._groupThreadIDs?.has(key)) return true;
    return null;
  }

  function clearThreadCache(threadID) {
    const key = keyOf(threadID);
    metadata().delete(key);
    if (ctx.threadTypeCache) delete ctx.threadTypeCache[key];
    ctx._groupThreadIDs?.delete(key);
    return true;
  }

  function clearAllThreadCache() {
    metadata().clear();
    if (ctx.threadTypeCache) ctx.threadTypeCache = Object.create(null);
    ctx._groupThreadIDs?.clear();
    return true;
  }

  return {
    getThreadMetadata,
    setThreadMetadata,
    markGroupThread,
    getCachedThreadType,
    clearThreadCache,
    clearAllThreadCache,
  };
};