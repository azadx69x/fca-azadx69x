"use strict";
// fca-azadx69x 
// made by @Azadx69x

module.exports = (defaultFuncs, api, ctx) => {
  return {
    getRuntimeInfo: () => {
      const health = ctx._runtimeHealth || {};
      const startedAt = health.startedAt || Date.now();
      const operations = health.operations || {};
      const totalOperationCalls = Object.values(operations)
        .reduce((total, operation) => total + (operation.total ||
          (operation.success || 0) + (operation.failed || 0)), 0);
      const messagesSent = ["sendMessage", "sendMessageMqtt"]
        .reduce((total, name) => total + (operations[name]?.success || 0), 0);
      const messagesFailed = ["sendMessage", "sendMessageMqtt"]
        .reduce((total, name) => total + (operations[name]?.failed || 0), 0);

      return {
        userID: ctx.userID || null,
        botName: ctx.userName || "x69x_bot_v3",
        loggedIn: ctx.loggedIn === true,
        region: ctx.region || "UNKNOWN",
        clientID: ctx.clientID || null,
        startedAt,
        uptime: Math.max(0, Date.now() - startedAt),
        conversationsCached: ctx._conversationStates?.size || 0,
        lockedConversations: ctx._conversationLocks?.size || 0,
        threadsMetadataCached: ctx._threadMetadata?.size || 0,
        lastSuccessAt: health.lastSuccessAt,
        lastErrorAt: health.lastErrorAt,
        consecutiveErrors: health.consecutiveErrors || 0,
        healthStatus: (health.consecutiveErrors || 0) > 5 ? "degraded" : "healthy",
        mqttConnected: !!ctx.mqttClient,
        wsReqNumber: ctx.wsReqNumber || 0,
        wsTaskNumber: ctx.wsTaskNumber || 0,
        totalOperations: Object.keys(operations).length,
        totalOperationCalls,
        messagesSent,
        messagesFailed
      };
    }
  };
};
