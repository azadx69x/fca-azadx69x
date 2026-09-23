/* fca-azadx69x - MQTT ListenMqttPro */
"use strict";
// made by @Azadx69x

var utils = require("../utils");
var log = require("npmlog");
var mqtt = require("mqtt");
var websocket = require("websocket-stream");
var HttpsProxyAgent = require("https-proxy-agent");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

const checkpoint = require("../checkpoint");
const session = require("../session");

var identity = function () {};
var form = {};
var getSeqID = function () {};

var topics = [
  "/legacy_web",
  "/webrtc",
  "/rtc_multi",
  "/onevc",
  "/br_sr",
  "/sr_res",
  "/t_ms",
  "/thread_typing",
  "/orca_typing_notifications",
  "/notify_disconnect",
  "/orca_presence",
  "/inbox",
  "/mercury",
  "/messaging_events",
  "/orca_message_notifications",
  "/pp",
  "/webrtc_response",
];

/* ====== Helpers ====== */

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomUserAgent() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  ];
  return userAgents[getRandomInt(0, userAgents.length - 1)];
}

const MAX_RECONNECT_ATTEMPTS = 8;
const RATE_LIMIT_RETRY_DELAY = 10 * 60 * 1000;
const SUSPENSION_STATES = new Map();
const SESSION_LOGS = new Map();

function clearReconnectTimer(ctx) {
  if (!ctx?._proReconnectTimer) return;
  clearTimeout(ctx._proReconnectTimer);
  ctx._proReconnectTimer = null;
}

function resetReconnectState(ctx) {
  clearReconnectTimer(ctx);
  if (ctx) ctx._proReconnectAttempts = 0;
}

function reconnectDelay(attempt) {
  const base = Math.min(5000 * Math.pow(2, attempt), 300000);
  return base + getRandomInt(500, 5000);
}

function isActive(ctx) {
  return !!ctx && ctx.loggedIn !== false && !ctx._fatal;
}

function scheduleReconnect(ctx, cbRef) {
  if (!isActive(ctx) || ctx._proReconnectTimer) return;

  const attempts = ctx._proReconnectAttempts || 0;
  if (attempts >= MAX_RECONNECT_ATTEMPTS) {
    log.error("listenMqttPro", "giving up after " + attempts + " reconnect attempts");
    ctx.loggedIn = false;
    cbRef.fn({
      type: "stop_listen",
      error: "listenMqttPro reconnect limit reached",
      fatal: true,
      source: "listenMqttPro",
    });
    cbRef.silence();
    return;
  }

  const wait = reconnectDelay(attempts);
  ctx._proReconnectAttempts = attempts + 1;
  logSessionEvent(ctx.userID, `Reconnecting in ${Math.round(wait / 1000)}s (attempt ${ctx._proReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  log.info("listenMqttPro", `reconnecting in ${Math.round(wait / 1000)}s (attempt ${ctx._proReconnectAttempts})`);

  ctx._proReconnectTimer = setTimeout(() => {
    ctx._proReconnectTimer = null;
    if (isActive(ctx)) getSeqID();
  }, wait);
}

function isRateLimitError(error) {
  let text;
  try {
    text = JSON.stringify(error || "").toLowerCase();
  } catch {
    text = String(error || "").toLowerCase();
  }
  return text.includes("1675004") || text.includes("rate limit exceeded");
}

function makeCallbackRef(fn) {
  return { fn: fn || identity, silence() { this.fn = identity; } };
}

function logSessionEvent(userID, event) {
  if (!SESSION_LOGS.has(userID)) {
    SESSION_LOGS.set(userID, []);
  }
  const logs = SESSION_LOGS.get(userID);
  logs.push({
    timestamp: Date.now(),
    event: event,
    time: new Date().toISOString(),
  });
  
  if (logs.length > 100) logs.shift(); 
  log.info("listenMqttPro", `[${userID}] ${event}`);
}

/**
 * Pro-grade suspension/lock detector with persistent state tracking
 * Returns true when account CANNOT continue
 */
async function handleFatalState(ctx, err, cbRef) {
  let info = null;
  try {
    const res = err && (err.res || err.response || err);
    info = checkpoint.detect(res, utils.getAppState(ctx.jar), ctx.userID);
  } catch (e) {
    info = null;
  }

  const notLoggedIn =
    err && (err.error === "Not logged in" || err.error === "Not logged in." || err.error === 1357001);

  if (!info && !notLoggedIn) return false;

  if (info) {
    checkpoint.report(info, utils);
    logSessionEvent(ctx.userID, `CHECKPOINT DETECTED: ${info.type} - ${info.label}`);
    
    SUSPENSION_STATES.set(ctx.userID, {
      type: info.type,
      timestamp: Date.now(),
      label: info.label,
      severity: info.severity,
      message: info.message,
      checkpointUrl: info.checkpointUrl,
    });
  }

  const fatal =
    !info ||
    info.severity === "blocked" ||
    info.type === "account_suspended" ||
    info.type === "account_locked";

  if (!fatal) return false;

  ctx._fatal = info ? info.type : "not_logged_in";
  ctx.loggedIn = false;
  resetReconnectState(ctx);

  logSessionEvent(ctx.userID, `FATAL STATE: ${ctx._fatal}`);

  await new Promise((resolve) => teardownMqtt(ctx, resolve));

  if (info && (info.type === "account_suspended" || info.type === "account_locked")) {
    try {
      await session.handleSuspension(info, {
        jar: ctx.jar,
        ctx,
        globalOptions: ctx.globalOptions,
        onSuspended: ctx.onSuspended,
      });
      logSessionEvent(ctx.userID, "Suspension handler completed");
    } catch (e) {
      log.error("listenMqttPro", "suspension handler failed: " + e.message);
      logSessionEvent(ctx.userID, `Suspension handler error: ${e.message}`);
    }
  } else {
    session.clearSession(ctx.jar, ctx, { wipeCookies: false, wipeFiles: false });
    logSessionEvent(ctx.userID, "Session cleared due to fatal state");
  }

  cbRef.fn(
    Object.assign(
      {
        type: "stop_listen",
        error: info ? info.label : "Not logged in",
        fatal: true,
        suspended: !!info,
        suspensionType: info ? info.type : null,
        sessionLogs: SESSION_LOGS.get(ctx.userID) || [],
      },
      info || {}
    )
  );
  cbRef.silence();
  return true;
}

/**
 * Pro-grade MQTT teardown with forced connection kill
 * Guarantees callback runs exactly once
 */
function teardownMqtt(ctx, done) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };

  clearReconnectTimer(ctx);

  const client = ctx && ctx.mqttClient;
  if (!client) return finish();

  ctx.mqttClient = null;
  if (global.mqttClient === client) global.mqttClient = null;

  try {
    client.removeAllListeners("message");
    client.removeAllListeners("error");
    client.removeAllListeners("connect");
    client.removeAllListeners("close");

    try {
      topics.forEach((topic) => client.unsubscribe(topic, () => {}));
    } catch (e) {}
    
    try {
      client.publish("/browser_close", "{}", { qos: 0 });
    } catch (e) {}

    client.end(true, finish);

    const forceKillTimer = setTimeout(() => {
      try {
        client.end(true);
      } catch (e) {}
      finish();
    }, 3000);

    client.once("close", () => {
      clearTimeout(forceKillTimer);
      finish();
    });
  } catch (e) {
    finish();
  }
}

/* ====== Pro Listener ====== */

function listenMqttPro(defaultFuncs, api, ctx, cbRef) {
  if (!isActive(ctx)) {
    log.info("listenMqttPro", "not starting — session is closed");
    return;
  }

  logSessionEvent(ctx.userID, "MQTT connection starting");

  var chatOn = ctx.globalOptions.online;
  var foreground = false;

  if (!ctx._sessionUserAgent)
    ctx._sessionUserAgent = ctx.globalOptions.userAgent || getRandomUserAgent();

  var sessionID = Math.floor(Math.random() * 9007199254740991) + 1;
  var GUID = utils.getGUID();
  var clientID = ctx.clientID || GUID;

  const username = {
    u: ctx.userID,
    s: sessionID,
    chat_on: chatOn,
    fg: foreground,
    d: clientID,
    ct: "websocket",
    aid: ctx.mqttAppID || "219994525426954",
    aids: null,
    mqtt_sid: "",
    cp: 3,
    ecp: 10,
    st: [],
    pm: [],
    dc: "",
    no_auto_fg: true,
    gas: null,
    pack: [],
    p: null,
    php_override: "",
    fb_dtsg: ctx.fb_dtsg || null,
    a: ctx.globalOptions.userAgent || ctx._sessionUserAgent,
  };

  var cookies = ctx.jar.getCookies("https://www.facebook.com").join("; ");

  const region = ctx.region ? `region=${ctx.region.toLowerCase()}&` : "";
  const host = `wss://edge-chat.messenger.com/chat?${region}sid=${sessionID}&cid=${clientID}`;

  const options = {
    clientId: "mqttwsclient",
    protocolId: "MQIsdp",
    protocolVersion: 3,
    username: JSON.stringify(username),
    clean: true,
    wsOptions: {
      headers: {
        Cookie: cookies,
        Origin: "https://www.messenger.com",
        "User-Agent": ctx._sessionUserAgent,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: "https://www.messenger.com/",
        Host: new URL(host).hostname,
        "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
        "Sec-WebSocket-Version": "13",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "websocket",
        "Sec-Fetch-Site": "same-origin",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      origin: "https://www.messenger.com",
      protocolVersion: 13,
      binaryType: "arraybuffer",
    },
    keepalive: 10,
    reschedulePings: true,
    reconnectPeriod: 0,
    connectTimeout: 60000,
  };

  if (typeof ctx.globalOptions.proxy != "undefined")
    options.wsOptions.agent = new HttpsProxyAgent(ctx.globalOptions.proxy);

  try {
    ctx.mqttClient = new mqtt.Client((_) => websocket(host, options.wsOptions), options);
    global.mqttClient = ctx.mqttClient;
    logSessionEvent(ctx.userID, "MQTT client created successfully");
  } catch (e) {
    log.error("listenMqttPro", "failed to create MQTT client: " + (e.message || e));
    logSessionEvent(ctx.userID, `MQTT client creation failed: ${e.message}`);
    cbRef.fn({
      type: "connection_error",
      error: "listenMqttPro client creation failed",
      message: e?.message || "Unable to create MQTT client",
      source: "listenMqttPro",
      transient: true,
    });
    scheduleReconnect(ctx, cbRef);
    return;
  }

  const reportConnectionFailure = (message, err) => {
    cbRef.fn({
      type: "connection_error",
      error: message,
      message: err?.message || message,
      source: "listenMqttPro",
      transient: true,
    });
  };

  ctx.mqttClient.on("error", function (err) {
    if (!isActive(ctx)) return;
    log.error("listenMqttPro", "MQTT error: " + (err.message || err));
    logSessionEvent(ctx.userID, `MQTT error: ${err.message}`);
    reportConnectionFailure("listenMqttPro MQTT error", err);
    teardownMqtt(ctx, () => scheduleReconnect(ctx, cbRef));
  });

  ctx.mqttClient.on("connect", function () {
    if (!isActive(ctx)) {
      teardownMqtt(ctx, () => {});
      return;
    }

    resetReconnectState(ctx);
    logSessionEvent(ctx.userID, "MQTT connected successfully");

    topics.forEach((topicsub) => {
      try {
        ctx.mqttClient.subscribe(topicsub);
      } catch (e) {}
    });

    var topic;
    var queue = {
      sync_api_version: 10,
      max_deltas_able_to_process: 1000,
      delta_batch_size: 500,
      encoding: "JSON",
      entity_fbid: ctx.userID,
    };

    if (ctx.syncToken) {
      topic = "/messenger_sync_get_diffs";
      queue.last_seq_id = ctx.lastSeqId;
      queue.sync_token = ctx.syncToken;
    } else {
      topic = "/messenger_sync_create_queue";
      queue.initial_titan_sequence_id = ctx.lastSeqId;
      queue.device_params = null;
    }

    try {
      ctx.mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });
      logSessionEvent(ctx.userID, `Published to topic: ${topic}`);
    } catch (e) {
      log.error("listenMqttPro", "publish error: " + (e.message || e));
      logSessionEvent(ctx.userID, `Publish error: ${e.message}`);
    }

    var rTimeout = setTimeout(function () {
      if (!isActive(ctx)) return;
      logSessionEvent(ctx.userID, "Connection timeout - reconnecting");
      reportConnectionFailure("listenMqttPro connection timeout");
      teardownMqtt(ctx, () => scheduleReconnect(ctx, cbRef));
    }, 30000);

    ctx.tmsWait = function () {
      clearTimeout(rTimeout);
      if (ctx.globalOptions.emitReady) {
        cbRef.fn(null, { type: "ready", error: null });
        logSessionEvent(ctx.userID, "Ready event emitted");
      }
      delete ctx.tmsWait;
    };
  });

  ctx.mqttClient.on("message", function (topic, message) {
    if (!isActive(ctx)) return;

    var jsonMessage;
    try {
      jsonMessage = JSON.parse(message);
    } catch (ex) {
      return log.error("listenMqttPro", "parse error: " + (ex.message || ex));
    }

    if (topic === "/t_ms") {
      if (typeof ctx.tmsWait == "function") ctx.tmsWait();

      if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
        ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
        ctx.syncToken = jsonMessage.syncToken;
      }
      if (jsonMessage.lastIssuedSeqId) ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);

      for (var i in jsonMessage.deltas)
        parseDelta(defaultFuncs, api, ctx, cbRef, { delta: jsonMessage.deltas[i] });
    } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
      cbRef.fn(null, {
        type: "typ",
        isTyping: !!jsonMessage.state,
        from: jsonMessage.sender_fbid.toString(),
        threadID: utils.formatID((jsonMessage.thread || jsonMessage.sender_fbid).toString()),
      });
    } else if (topic === "/orca_presence") {
      if (!ctx.globalOptions.updatePresence) {
        for (var j in jsonMessage.list) {
          var data = jsonMessage.list[j];
          cbRef.fn(null, {
            type: "presence",
            userID: data["u"].toString(),
            timestamp: data["l"] * 1000,
            statuses: data["p"],
          });
        }
      }
    }
  });

  ctx.mqttClient.on("close", function () {
    if (!isActive(ctx)) return;
    log.warn("listenMqttPro", "MQTT connection closed; scheduling reconnect");
    logSessionEvent(ctx.userID, "MQTT connection closed");
    reportConnectionFailure("listenMqttPro connection closed");
    // A clean WebSocket close does not always emit MQTT's error event.
    // Reuse the guarded reconnect path instead of stopping silently.
    teardownMqtt(ctx, () => scheduleReconnect(ctx, cbRef));
  });
}

/* ====== delta parsing ====== */

function parseDelta(defaultFuncs, api, ctx, cbRef, v) {
  const globalCallback = (...args) => cbRef.fn(...args);

  if (v.delta.class == "NewMessage") {
    if (ctx.globalOptions.pageID && ctx.globalOptions.pageID != v.queue) return;

    (function resolveAttachmentUrl(i) {
      if (i == (v.delta.attachments || []).length) {
        let fmtMsg;
        try {
          fmtMsg = utils.formatDeltaMessage(v);
        } catch (err) {
          return globalCallback({
            error: "Problem parsing message object.",
            detail: err,
            res: v,
            type: "parse_error",
          });
        }
        if (fmtMsg && ctx.globalOptions.autoMarkDelivery)
          markDelivery(ctx, api, fmtMsg.threadID, fmtMsg.messageID);

        return !ctx.globalOptions.selfListen &&
          (fmtMsg.senderID === ctx.i_userID || fmtMsg.senderID === ctx.userID)
          ? undefined
          : globalCallback(null, fmtMsg);
      }
      if (v.delta.attachments[i].mercury.attach_type == "photo") {
        api.resolvePhotoUrl(v.delta.attachments[i].fbid, (err, url) => {
          if (!err) v.delta.attachments[i].mercury.metadata.url = url;
          return resolveAttachmentUrl(i + 1);
        });
      } else return resolveAttachmentUrl(i + 1);
    })(0);
  }

  if (v.delta.class == "ClientPayload") {
    var clientPayload = utils.decodeClientPayload(v.delta.payload);
    if (clientPayload && clientPayload.deltas) {
      for (var i in clientPayload.deltas) {
        var delta = clientPayload.deltas[i];
        if (delta.deltaMessageReaction && !!ctx.globalOptions.listenEvents) {
          globalCallback(null, {
            type: "message_reaction",
            threadID: (
              delta.deltaMessageReaction.threadKey.threadFbId ||
              delta.deltaMessageReaction.threadKey.otherUserFbId
            ).toString(),
            messageID: delta.deltaMessageReaction.messageId,
            reaction: delta.deltaMessageReaction.reaction,
            senderID: delta.deltaMessageReaction.senderId.toString(),
            userID: delta.deltaMessageReaction.userId.toString(),
          });
        } else if (delta.deltaRecallMessageData && !!ctx.globalOptions.listenEvents) {
          globalCallback(null, {
            type: "message_unsend",
            threadID: (
              delta.deltaRecallMessageData.threadKey.threadFbId ||
              delta.deltaRecallMessageData.threadKey.otherUserFbId
            ).toString(),
            messageID: delta.deltaRecallMessageData.messageID,
            senderID: delta.deltaRecallMessageData.senderID.toString(),
            deletionTimestamp: delta.deltaRecallMessageData.deletionTimestamp,
            timestamp: delta.deltaRecallMessageData.timestamp,
          });
        } else if (delta.deltaMessageReply) {
          var mdata =
            delta.deltaMessageReply.message === undefined
              ? []
              : delta.deltaMessageReply.message.data === undefined
                ? []
                : delta.deltaMessageReply.message.data.prng === undefined
                  ? []
                  : JSON.parse(delta.deltaMessageReply.message.data.prng);
          var m_id = mdata.map((u) => u.i);
          var m_offset = mdata.map((u) => u.o);
          var m_length = mdata.map((u) => u.l);

          var mentions = {};
          for (var k = 0; k < m_id.length; k++)
            mentions[m_id[k]] = (delta.deltaMessageReply.message.body || "").substring(
              m_offset[k],
              m_offset[k] + m_length[k]
            );

          var callbackToReturn = {
            type: "message_reply",
            threadID: (
              delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId ||
              delta.deltaMessageReply.message.messageMetadata.threadKey.otherUserFbId
            ).toString(),
            messageID: delta.deltaMessageReply.message.messageMetadata.messageId,
            senderID: delta.deltaMessageReply.message.messageMetadata.actorFbId.toString(),
            attachments: (delta.deltaMessageReply.message.attachments || [])
              .map(function (att) {
                var mercury = JSON.parse(att.mercuryJSON);
                Object.assign(att, mercury);
                return att;
              })
              .map((att) => {
                var x;
                try {
                  x = utils._formatAttachment(att);
                } catch (ex) {
                  x = att;
                  x.error = ex;
                  x.type = "unknown";
                }
                return x;
              }),
            args: (delta.deltaMessageReply.message.body || "").trim().split(/\s+/),
            body: delta.deltaMessageReply.message.body || "",
            isGroup: !!delta.deltaMessageReply.message.messageMetadata.threadKey.threadFbId,
            mentions: mentions,
            timestamp: delta.deltaMessageReply.message.messageMetadata.timestamp,
            participantIDs: (
              delta.deltaMessageReply.message.messageMetadata.cid.canonicalParticipantFbids ||
              delta.deltaMessageReply.message.participants ||
              []
            ).map((e) => e.toString()),
          };

          if (ctx.globalOptions.autoMarkDelivery)
            markDelivery(ctx, api, callbackToReturn.threadID, callbackToReturn.messageID);

          return !ctx.globalOptions.selfListen && callbackToReturn.senderID === ctx.userID
            ? undefined
            : globalCallback(null, callbackToReturn);
        }
      }
      return;
    }
  }

  if (v.delta.class !== "NewMessage" && !ctx.globalOptions.listenEvents) return;
  switch (v.delta.class) {
    case "JoinableMode": {
      let fmtMsg;
      try {
        fmtMsg = utils.formatDeltaEvent(v.delta);
      } catch (err) {
        return globalCallback({
          error: "Problem parsing event object.",
          detail: err,
          res: v.delta,
          type: "parse_error",
        });
      }
      return globalCallback(null, fmtMsg);
    }
    case "AdminTextMessage":
      switch (v.delta.type) {
        case "confirm_friend_request":
        case "shared_album_delete":
        case "shared_album_addition":
        case "pin_messages_v2":
        case "unpin_messages_v2":
        case "change_thread_theme":
        case "change_thread_nickname":
        case "change_thread_icon":
        case "change_thread_quick_reaction":
        case "change_thread_admins":
        case "group_poll":
        case "joinable_group_link_mode_change":
        case "magic_words":
        case "change_thread_approval_mode":
        case "messenger_call_log":
        case "participant_joined_group_call": {
          let fmtMsg;
          try {
            fmtMsg = utils.formatDeltaEvent(v.delta);
          } catch (err) {
            return globalCallback({
              error: "Problem parsing event object.",
              detail: err,
              res: v.delta,
              type: "parse_error",
            });
          }
          return globalCallback(null, fmtMsg);
        }
        default:
          return;
      }
  }
}

function markDelivery(ctx, api, threadID, messageID) {
  if (!threadID || !messageID) return;
  api.markAsDelivered(threadID, messageID, (err) => {
    if (err) return log.error("markAsDelivered", err);
    if (ctx.globalOptions.autoMarkRead)
      api.markAsRead(threadID, (e) => {
        if (e) log.error("markAsRead", e);
      });
  });
}

/* ====== stop / logout ====== */

function stopListening(ctx, cbRef, callback) {
  callback = callback || (() => {});
  ctx.loggedIn = false;
  resetReconnectState(ctx);
  if (cbRef && typeof cbRef.silence === "function") cbRef.silence();

  logSessionEvent(ctx.userID, "Listener stopped");

  teardownMqtt(ctx, () => {
    ctx.lastSeqId = null;
    ctx.syncToken = undefined;
    ctx.t_mqttCalled = false;
    ctx.tmsWait = null;
    ctx.firstListen = true;
    log.info("stopListening", "listener stopped");
    callback(null, { success: true, logs: SESSION_LOGS.get(ctx.userID) || [] });
  });
}

function logout(defaultFuncs, ctx, cbRef, callback) {
  const done = (result) => {
    if (typeof callback === "function") callback(null, result);
    return result;
  };

  return new Promise((resolve) => {
    if (ctx._loggedOut) {
      logSessionEvent(ctx.userID, "Already logged out");
      return resolve(done({ success: true, message: "Already logged out" }));
    }
    ctx._loggedOut = true;
    logSessionEvent(ctx.userID, "Logout initiated");

    stopListening(ctx, cbRef, async function () {
      form = {};
      try {
        logSessionEvent(ctx.userID, "Server logout starting");
        const res = await session.logout(ctx.jar, ctx, ctx.globalOptions);
        logSessionEvent(ctx.userID, "Server logout completed");
        resolve(
          done({
            success: true,
            message: "Logged out successfully",
            userID: res && res.userID,
            timestamp: Date.now(),
            logs: SESSION_LOGS.get(ctx.userID) || [],
          })
        );
      } catch (err) {
        log.warn("logout", "server logout failed: " + (err.message || err.error || err));
        logSessionEvent(ctx.userID, `Server logout failed: ${err.message}`);
        session.clearSession(ctx.jar, ctx, { wipeCookies: true, wipeFiles: true });
        resolve(
          done({
            success: true,
            warning: "Local logout done, server logout failed",
            timestamp: Date.now(),
            logs: SESSION_LOGS.get(ctx.userID) || [],
          })
        );
      }
    });
  });
}

/* ====== module ====== */

module.exports = function (defaultFuncs, api, ctx) {
  const cbRef = makeCallbackRef(identity);

  api.logout = function (callback) {
    return logout(defaultFuncs, ctx, cbRef, callback);
  };
  api.stopListening = function (callback) {
    return stopListening(ctx, cbRef, callback);
  };
  api.isSuspended = function () {
    const state = SUSPENSION_STATES.get(ctx.userID);
    if (state) {
      return { suspended: true, ...state };
    }
    return ctx._fatal === "account_suspended" || ctx._fatal === "account_locked"
      ? { suspended: true, type: ctx._fatal }
      : { suspended: false };
  };
  api.getSuspensionHistory = function () {
    return Array.from(SUSPENSION_STATES.entries()).map(([uid, state]) => ({
      userID: uid,
      ...state,
    }));
  };
  api.getSessionLogs = function (userID) {
    return SESSION_LOGS.get(userID) || [];
  };
  api.clearSuspensionHistory = function () {
    SUSPENSION_STATES.clear();
  };
  api.clearSessionLogs = function (userID) {
    if (userID) SESSION_LOGS.delete(userID);
    else SESSION_LOGS.clear();
  };

  getSeqID = function getSeqID() {
    if (!isActive(ctx)) {
      log.info("getSeqID", "skipping — session is closed");
      return;
    }

    ctx.t_mqttCalled = false;
    defaultFuncs
      .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then((resData) => {
        if (!isActive(ctx)) return;

        if (utils.getType(resData) != "Array") throw { error: "Not logged in", res: resData };
        if (resData[resData.length - 1].error_results > 0) throw resData[0].o0.errors;
        if (resData[resData.length - 1].successful_results === 0)
          throw { error: "getSeqId: there was no successful_results", res: resData };
        if (!resData[0].o0.data.viewer.message_threads.sync_sequence_id)
          throw { error: "getSeqId: no sync_sequence_id found.", res: resData };

        ctx.lastSeqId = resData[0].o0.data.viewer.message_threads.sync_sequence_id;
        ctx._rateLimitWarned = false;
        logSessionEvent(ctx.userID, `SeqID obtained: ${ctx.lastSeqId}`);
        listenMqttPro(defaultFuncs, api, ctx, cbRef);
      })
      .catch(async (err) => {
        if (!isActive(ctx)) {
          log.info("getSeqID", "ignoring error — session is closed");
          return;
        }

        const fatal = await handleFatalState(ctx, err, cbRef);
        if (fatal) return;

        if (isRateLimitError(err)) {
          if (!ctx._rateLimitWarned)
            log.warn("getSeqID", "Facebook rate limit reached; retrying in 10 minutes without restarting the bot");
          ctx._rateLimitWarned = true;
          setTimeout(() => {
            if (isActive(ctx)) getSeqID();
          }, RATE_LIMIT_RETRY_DELAY);
          return;
        }

        log.error("getSeqId", err);
        logSessionEvent(ctx.userID, `SeqID error: ${err.message}`);
        cbRef.fn(err);

        scheduleReconnect(ctx, cbRef);
      });
  };

  return function (callback) {
    class MessageEmitter extends EventEmitter {
      stopListening(cb) {
        return stopListening(ctx, cbRef, cb);
      }
      stopListeningAsync() {
        return new Promise((resolve, reject) => {
          this.stopListening((err, res) => (err ? reject(err) : resolve(res)));
        });
      }
      logout(cb) {
        return api.logout(cb);
      }
      logoutAsync() {
        return api.logout();
      }
    }

    const msgEmitter = new MessageEmitter();
    cbRef.fn =
      callback ||
      function (error, message) {
        if (error) return msgEmitter.emit("error", error);
        msgEmitter.emit("message", message);
      };

    if (!ctx.firstListen) ctx.lastSeqId = null;
    ctx.syncToken = undefined;
    ctx.t_mqttCalled = false;
    ctx._loggedOut = false;
    ctx._fatal = undefined;
    ctx.loggedIn = true;
    resetReconnectState(ctx);

    logSessionEvent(ctx.userID, "Listener initialization started");

    form = {
      av: ctx.globalOptions.pageID,
      queries: JSON.stringify({
        o0: {
          doc_id: "3336396659757871",
          query_params: {
            limit: 1,
            before: null,
            tags: ["INBOX"],
            includeDeliveryReceipts: false,
            includeSeqID: true,
          },
        },
      }),
    };

    if (!ctx.firstListen || !ctx.lastSeqId) getSeqID();
    else listenMqttPro(defaultFuncs, api, ctx, cbRef);

    ctx.firstListen = false;

    return msgEmitter;
  };
};
