"use strict";
// fca-azadx69x 
// made by @Azadx69x 

module.exports = (defaultFuncs, api, ctx) => {
  if (!(ctx._conversationStates instanceof Map)) ctx._conversationStates = new Map();
  if (!(ctx._conversationLocks instanceof Map)) ctx._conversationLocks = new Map();
  if (!(ctx._threadMetadata instanceof Map)) ctx._threadMetadata = new Map();

  const normalizeThreadID = (threadID) => {
    if (threadID === undefined || threadID === null || threadID === "")
      throw new Error("threadID is required");
    return String(threadID);
  };

  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

  const cloneState = (state) => ({
    ...state,
    data: isObject(state.data) ? { ...state.data } : state.data
  });

  return {
    getConversationState: (threadID) => {
      threadID = normalizeThreadID(threadID);
      const state = ctx._conversationStates.get(threadID);
      return cloneState(state || { threadID, lastMessage: null, count: 0, data: {} });
    },

    updateConversationState: (threadID, newState) => {
      threadID = normalizeThreadID(threadID);
      if (!isObject(newState)) throw new Error("newState must be an object");

      const existing = ctx._conversationStates.get(threadID) || { threadID, data: {} };
      const updated = {
        ...existing,
        ...newState,
        threadID,
        data: isObject(existing.data) && isObject(newState.data)
          ? { ...existing.data, ...newState.data }
          : newState.data === undefined
            ? existing.data
            : newState.data
      };
      ctx._conversationStates.set(threadID, updated);
      return cloneState(updated);
    },

    withConversationLock: async (threadID, fn) => {
      threadID = normalizeThreadID(threadID);
      if (typeof fn !== "function") throw new Error("fn must be a function");

      const previous = ctx._conversationLocks.get(threadID) || Promise.resolve();
      const running = previous.catch(() => undefined).then(fn);
      const settled = running.finally(() => {
        if (ctx._conversationLocks.get(threadID) === settled)
          ctx._conversationLocks.delete(threadID);
      });

      ctx._conversationLocks.set(threadID, settled);
      return settled;
    },

    getCachedThreadType: (threadID) => {
      threadID = normalizeThreadID(threadID);
      const metadata = ctx._threadMetadata.get(threadID);
      return isObject(metadata) ? { ...metadata } : metadata || null;
    },

    setCachedThreadType: (threadID, metadata) => {
      threadID = normalizeThreadID(threadID);
      const value = isObject(metadata) ? { ...metadata } : metadata;
      ctx._threadMetadata.set(threadID, value);
      return isObject(value) ? { ...value } : value;
    },

    clearAllConversationStates: () => {
      const count = ctx._conversationStates.size;
      ctx._conversationStates.clear();
      return { cleared: true, count };
    },

    clearAllConversationLocks: () => {
      const count = ctx._conversationLocks.size;
      ctx._conversationLocks.clear();
      return { cleared: true, count };
    },

    clearAllThreadMetadata: () => {
      const count = ctx._threadMetadata.size;
      ctx._threadMetadata.clear();
      return { cleared: true, count };
    }
  };
};
