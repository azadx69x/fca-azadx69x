"use strict";
// fca-azadx69x 
// made by @Azadx69x

module.exports = (defaultFuncs, api, ctx) => {
  const createHealth = (startedAt = Date.now()) => ({
    startedAt,
    lastSuccessAt: null,
    lastErrorAt: null,
    consecutiveErrors: 0,
    operations: {}
  });

  const ensureHealth = () => {
    if (!ctx._runtimeHealth || typeof ctx._runtimeHealth !== "object")
      ctx._runtimeHealth = createHealth();
    if (!ctx._runtimeHealth.operations || typeof ctx._runtimeHealth.operations !== "object")
      ctx._runtimeHealth.operations = {};
    return ctx._runtimeHealth;
  };

  const clone = (value) => {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") return { ...value };
    return value;
  };

  const getTotalCalls = (operation) => operation.total ||
    (operation.success || 0) + (operation.failed || 0);

  const getOperationCount = (operations, names, field) => names
    .reduce((total, name) => total + (operations[name]?.[field] || 0), 0);

  const snapshot = () => {
    const health = ensureHealth();
    const operations = Object.fromEntries(
      Object.entries(health.operations).map(([name, operation]) => [name, clone(operation)])
    );
    const totalOperationCalls = Object.values(operations)
      .reduce((total, operation) => total + getTotalCalls(operation), 0);

    return {
      startedAt: health.startedAt,
      uptime: Math.max(0, Date.now() - health.startedAt),
      lastSuccessAt: health.lastSuccessAt,
      lastErrorAt: health.lastErrorAt,
      consecutiveErrors: health.consecutiveErrors || 0,
      totalOperations: Object.keys(operations).length,
      totalOperationCalls,
      operations,
      status: (health.consecutiveErrors || 0) > 5 ? "degraded" : "healthy",
      messagesSent: getOperationCount(operations, ["sendMessage", "sendMessageMqtt"], "success"),
      messageFailed: getOperationCount(operations, ["sendMessage", "sendMessageMqtt"], "failed"),
      messagesFailed: getOperationCount(operations, ["sendMessage", "sendMessageMqtt"], "failed")
    };
  };

  const record = (operationName, success, details) => {
    const name = String(operationName || "unknown").trim() || "unknown";
    const health = ensureHealth();
    const now = Date.now();
    const operation = health.operations[name] || {
      success: 0,
      failed: 0,
      total: 0,
      lastRun: null,
      lastSuccessAt: null,
      lastErrorAt: null
    };

    operation.total = (operation.total || (operation.success || 0) + (operation.failed || 0)) + 1;
    operation.lastRun = now;
    if (success) {
      operation.success = (operation.success || 0) + 1;
      operation.lastSuccessAt = now;
      health.lastSuccessAt = now;
      health.consecutiveErrors = 0;
    } else {
      operation.failed = (operation.failed || 0) + 1;
      operation.lastErrorAt = now;
      health.lastErrorAt = now;
      health.consecutiveErrors = (health.consecutiveErrors || 0) + 1;
    }
    if (details !== undefined) operation.lastDetails = details;
    health.operations[name] = operation;
    return clone(operation);
  };

  ensureHealth();
  ctx._recordRuntimeOperation = record;

  return {
    getRuntimeHealth: snapshot,

    recordOperation: (operationName, success, details) => {
      return record(operationName, success, details);
    },

    resetRuntimeHealth: () => {
      ctx._runtimeHealth = createHealth();
      return snapshot();
    }
  };
};
