"use strict";
// fca-azadx69x
// made by @Azadx69x


//  ! Hardened listener:
//  - per-ctx reconnect state (multi-account safe)
//  - single-shot reconnect timer (no stacking)
//  - exponential backoff with jitter + floor
//  - capped retries (never hammer a suspended account)
//  - non-suspension fatals do NOT wipe the local session
//  - timers cleared on stopListening / logout / teardown

var utils = require("../utils");
var log = require("npmlog");
var mqtt = require("mqtt");
var websocket = require("websocket-stream");
var HttpsProxyAgent = require("https-proxy-agent");
const EventEmitter = require("events");

const checkpoint = require("../checkpoint");
const session = require("../session");

var identity = function () {};
var form = {};
var getSeqID = function () {};

var topics = [
  "/legacy_web", "/webrtc", "/rtc_multi", "/onevc", "/br_sr", "/sr_res",
  "/t_ms", "/thread_typing", "/orca_typing_notifications", "/notify_disconnect",
  "/orca_presence", "/inbox", "/mercury", "/messaging_events",
  "/orca_message_notifications", "/pp", "/webrtc_response",
];

// ===== Anti-suspension tuning =====
const MAX_RECONNECT_ATTEMPTS = 12;               // ~55 min coverage before we stop
const MAX_RECONNECT_DELAY = 600000;              // 10 min cap
const MIN_RECONNECT_DELAY = 15000;               // 15 s floor
const INITIAL_LISTEN_JITTER_MS = 1500;           // desync initial pings
const HEALTHCHECK_COOLDOWN = 60 * 1000;          // probe FB at most once/min
const MQTT_KEEPALIVE_SECONDS = 120;
const RATE_LIMIT_RETRY_DELAY = 10 * 60 * 1000;

/** @param {number} min
 * @param {number} max
 */
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** @returns {string} */
function getRandomUserAgent() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/126.0.0.0 Safari/537.36",
  ];
  return userAgents[getRandomInt(0, userAgents.length - 1)];
}

// Per-ctx reconnect state helpers
// Previously `reconnectAttempts` was module-level → two accounts
// clobbered each other's backoff counter.
function resetReconnectState(ctx) {
  if (!ctx) return;
  ctx._reconnectAttempts = 0;
  clearReconnectTimer(ctx);
}

function clearReconnectTimer(ctx) {
  if (!ctx) return;
  if (ctx._reconnectTimer) {
    clearTimeout(ctx._reconnectTimer);
    ctx._reconnectTimer = null;
  }
}

function nextReconnectDelay(ctx) {
  const attempt = ctx._reconnectAttempts || 0;
  const base = Math.min(
    MIN_RECONNECT_DELAY * Math.pow(1.5, attempt),
    MAX_RECONNECT_DELAY
  );
  return base + getRandomInt(1000, 10000);
}

/** @param {Object} ctx */
function isActive(ctx) {
  return !!ctx && ctx.loggedIn !== false && !ctx._fatal;
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

/** @param {Function} fn */
function makeCallbackRef(fn) {
  return { fn: fn || identity, silence() { this.fn = identity; } };
}

/**
 * Classify an error into { fatal, type, info }.
 * Network blips must NOT be classified as "not_logged_in".
 */
async function classifyError(ctx, err) {
  let info = null;
  try {
    const res = err && (err.res || err.response);
    if (res && (res.body || res.request)) {
      info = checkpoint.detect(res, utils.getAppState(ctx.jar), ctx.userID);
    }
  } catch (e) {
    info = null;
  }

  const notLoggedIn =
    err &&
    (err.error === "Not logged in" ||
      err.error === "Not logged in." ||
      err.error === 1357001) &&
    !!(err.res || err.response);

  if (!info && !notLoggedIn) {
    return { fatal: false, type: null, info: null };
  }

  const fatal =
    !info ||
    info.severity === "blocked" ||
    info.type === "account_suspended" ||
    info.type === "account_locked";

  return { fatal, type: info ? info.type : "not_logged_in", info };
}

/** @param {Object} ctx @param {Object} err @param {Object} cbRef */
async function handleFatalState(ctx, err, cbRef) {
  const { fatal, type, info } = await classifyError(ctx, err);
  if (!fatal) return false;

  if (info) checkpoint.report(info, utils);

  ctx._fatal = type;
  ctx.loggedIn = false;
  clearReconnectTimer(ctx);
  resetReconnectState(ctx);

  await new Promise((resolve) => teardownMqtt(ctx, resolve));

  if (info && (info.type === "account_suspended" || info.type === "account_locked")) {
    try {
      await session.handleSuspension(info, {
        jar: ctx.jar,
        ctx,
        globalOptions: ctx.globalOptions,
        onSuspended: ctx.onSuspended,
      });
    } catch (e) {
      log.error("listenMqtt", "suspension handler failed: " + e.message);
    }
  } else {
    // Do NOT clear session here — that was the source of the spurious logouts.
    log.warn("listenMqtt", `listener stopped (type=${type}); session preserved`);
  }

  cbRef.fn(
    Object.assign(
      { type: "stop_listen", error: info ? info.label : "Not logged in", fatal: true },
      info || {}
    )
  );
  cbRef.silence();
  return true;
}

/** @param {Object} ctx @param {Function} done */
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
    setTimeout(() => {
      try {
        client.end(true);
      } catch (e) {}
      finish();
    }, 3000);
  } catch (e) {
    finish();
  }
}

/**
 * Light FB probe before reconnecting MQTT, rate-limited to one hit per
 * HEALTHCHECK_COOLDOWN. Returns true when the account is healthy enough
 * to reconnect.
 */
async function healthCheck(ctx) {
  const now = Date.now();
  if (ctx._lastHealthCheck && now - ctx._lastHealthCheck < HEALTHCHECK_COOLDOWN) {
    return true;
  }
  ctx._lastHealthCheck = now;

  try {
    const res = await utils.get(
      "https://www.facebook.com/",
      ctx.jar,
      null,
      ctx.globalOptions,
      { noRef: true }
    );

    const info = checkpoint.detect(res, utils.getAppState(ctx.jar), ctx.userID);
    if (info) {
      const fake = { res, error: info.label, __fromHealthCheck: true };
      await handleFatalState(ctx, fake, { fn: identity, silence() {} });
      return false;
    }
    return true;
  } catch (e) {
    log.warn("listenMqtt", "health check failed (network): " + (e.message || e));
    return true;
  }
}

/** Schedule a single reconnect (idempotent). */
function scheduleReconnect(ctx, cbRef) {
  if (!isActive(ctx)) return;
  if (ctx._reconnectTimer) return; // already queued

  if ((ctx._reconnectAttempts || 0) >= MAX_RECONNECT_ATTEMPTS) {
    log.warn(
      "listenMqtt",
      `giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`
    );
    ctx.loggedIn = false;
    ctx._fatal = "reconnect_exhausted";
    cbRef.fn({
      type: "stop_listen",
      error: "listenMqtt reconnect budget exhausted",
      fatal: true,
    });
    cbRef.silence();
    return;
  }

  const wait = nextReconnectDelay(ctx);
  ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;

  log.info(
    "listenMqtt",
    `reconnecting in ${Math.round(wait / 1000)}s (attempt ${ctx._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
  );

  ctx._reconnectTimer = setTimeout(async () => {
    ctx._reconnectTimer = null;
    if (!isActive(ctx)) return;

    const healthy = await healthCheck(ctx);
    if (!healthy || !isActive(ctx)) return;

    getSeqID();
  }, wait);
}

/** @param {Object} defaultFuncs @param {Object} api @param {Object} ctx @param {Object} cbRef */
function listenMqtt(defaultFuncs, api, ctx, cbRef) {
  if (!isActive(ctx)) {
    log.info("listenMqtt", "not starting — session is closed");
    return;
  }

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

  const reportConnectionFailure = (message, err) => {
    cbRef.fn({
      type: "connection_error",
      error: message,
      message: err?.message || message,
      source: "listenMqtt",
      transient: true,
    });
  };

  try {
    ctx.mqttClient = new mqtt.Client((_) => websocket(host, options.wsOptions), options);
    global.mqttClient = ctx.mqttClient;
  } catch (e) {
    log.error("listenMqtt", "failed to create MQTT client: " + (e.message || e));
    reportConnectionFailure("listenMqtt client creation failed", e);
    scheduleReconnect(ctx, cbRef);
    return;
  }

  ctx.mqttClient.on("error", function (err) {
    if (!isActive(ctx)) return;
    log.error("listenMqtt", "MQTT error: " + (err.message || err));
    reportConnectionFailure("listenMqtt MQTT error", err);
    teardownMqtt(ctx, () => scheduleReconnect(ctx, cbRef));
  });

  ctx.mqttClient.on("connect", function () {
    if (!isActive(ctx)) {
      teardownMqtt(ctx, () => {});
      return;
    }

    ctx._reconnectAttempts = 0;

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
      app_id: "772021112871879",
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
    } catch (e) {
      log.error("listenMqtt", "publish error: " + (e.message || e));
    }

    var rTimeout = setTimeout(function () {
      if (!isActive(ctx)) return;
      reportConnectionFailure("listenMqtt connection timeout");
      teardownMqtt(ctx, () => scheduleReconnect(ctx, cbRef));
    }, 60000);

    ctx.tmsWait = function () {
      clearTimeout(rTimeout);
      if (ctx.globalOptions.emitReady) cbRef.fn(null, { type: "ready", error: null });
      delete ctx.tmsWait;
    };
  });

  ctx.mqttClient.on("message", function (topic, message) {
    if (!isActive(ctx)) return;

    var jsonMessage;
    try {
      jsonMessage = JSON.parse(message);
    } catch (ex) {
      return log.error("listenMqtt", "parse error: " + (ex.message || ex));
    }

    if (topic === "/t_ms") {
      if (typeof ctx.tmsWait == "function") ctx.tmsWait();

      if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
        ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
        ctx.syncToken = jsonMessage.syncToken;
      }
      if (jsonMessage.lastIssuedSeqId)
        ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);

      for (var i in jsonMessage.deltas)
        parseDelta(defaultFuncs, api, ctx, cbRef, { delta: jsonMessage.deltas[i] });
    } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
      cbRef.fn(null, {
        type: "typ",
        isTyping: !!jsonMessage.state,
        from: jsonMessage.sender_fbid.toString(),
        threadID: utils.formatID(
          (jsonMessage.thread || jsonMessage.sender_fbid).toString()
        ),
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
    log.warn("listenMqtt", "MQTT connection closed; scheduling reconnect");
    reportConnectionFailure("listenMqtt connection closed");
    // A clean WebSocket close does not always emit MQTT's error event.
    // Route it through the same guarded reconnect path so the listener does
    // not silently stop.
    teardownMqtt(ctx, () => {});
    scheduleReconnect(ctx, cbRef);
  });
}

/** @param {Object} defaultFuncs @param {Object} api @param {Object} ctx @param {Object} cbRef @param {Object} v */
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

          if (delta.deltaMessageReply.repliedToMessage) {
            mdata =
              delta.deltaMessageReply.repliedToMessage.data === undefined
                ? []
                : delta.deltaMessageReply.repliedToMessage.data.prng === undefined
                  ? []
                  : JSON.parse(delta.deltaMessageReply.repliedToMessage.data.prng);
            m_id = mdata.map((u) => u.i);
            m_offset = mdata.map((u) => u.o);
            m_length = mdata.map((u) => u.l);

            var rmentions = {};
            for (var n = 0; n < m_id.length; n++)
              rmentions[m_id[n]] = (
                delta.deltaMessageReply.repliedToMessage.body || ""
              ).substring(m_offset[n], m_offset[n] + m_length[n]);

            callbackToReturn.messageReply = {
              threadID: (
                delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId ||
                delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.otherUserFbId
              ).toString(),
              messageID: delta.deltaMessageReply.repliedToMessage.messageMetadata.messageId,
              senderID:
                delta.deltaMessageReply.repliedToMessage.messageMetadata.actorFbId.toString(),
              attachments: (delta.deltaMessageReply.repliedToMessage.attachments || [])
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
              args: (delta.deltaMessageReply.repliedToMessage.body || "").trim().split(/\s+/),
              body: delta.deltaMessageReply.repliedToMessage.body || "",
              isGroup:
                !!delta.deltaMessageReply.repliedToMessage.messageMetadata.threadKey.threadFbId,
              mentions: rmentions,
              timestamp: delta.deltaMessageReply.repliedToMessage.messageMetadata.timestamp,
            };
          } else if (delta.deltaMessageReply.replyToMessageId) {
            return defaultFuncs
              .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, {
                av: ctx.globalOptions.pageID,
                queries: JSON.stringify({
                  o0: {
                    doc_id: "2848441488556444",
                    query_params: {
                      thread_and_message_id: {
                        thread_id: callbackToReturn.threadID,
                        message_id: delta.deltaMessageReply.replyToMessageId.id,
                      },
                    },
                  },
                }),
              })
              .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
              .then((resData) => {
                if (resData[resData.length - 1].error_results > 0) throw resData[0].o0.errors;
                if (resData[resData.length - 1].successful_results === 0)
                  throw { error: "forcedFetch: there was no successful_results", res: resData };
                var fetchData = resData[0].o0.data.message;
                var mobj = {};
                for (var q in fetchData.message.ranges)
                  mobj[fetchData.message.ranges[q].entity.id] = (
                    fetchData.message.text || ""
                  ).substr(
                    fetchData.message.ranges[q].offset,
                    fetchData.message.ranges[q].length
                  );

                callbackToReturn.messageReply = {
                  threadID: callbackToReturn.threadID,
                  messageID: fetchData.message_id,
                  senderID: fetchData.message_sender.id.toString(),
                  attachments: fetchData.message.blob_attachment.map((att) => {
                    var x;
                    try {
                      x = utils._formatAttachment({ blob_attachment: att });
                    } catch (ex) {
                      x = att;
                      x.error = ex;
                      x.type = "unknown";
                    }
                    return x;
                  }),
                  args: (fetchData.message.text || "").trim().split(/\s+/) || [],
                  body: fetchData.message.text || "",
                  isGroup: callbackToReturn.isGroup,
                  mentions: mobj,
                  timestamp: parseInt(fetchData.timestamp_precise),
                };
              })
              .catch((err) => log.error("forcedFetch", err))
              .finally(function () {
                if (ctx.globalOptions.autoMarkDelivery)
                  markDelivery(ctx, api, callbackToReturn.threadID, callbackToReturn.messageID);
                if (ctx.globalOptions.selfListen || callbackToReturn.senderID !== ctx.userID)
                  globalCallback(null, callbackToReturn);
              });
          } else callbackToReturn.delta = delta;

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
    case "ForcedFetch": {
      if (!v.delta.threadKey) return;
      var mid = v.delta.messageId;
      var tid = v.delta.threadKey.threadFbId;
      if (!mid || !tid) break;

      defaultFuncs
        .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, {
          av: ctx.globalOptions.pageID,
          queries: JSON.stringify({
            o0: {
              doc_id: "2848441488556444",
              query_params: {
                thread_and_message_id: { thread_id: tid.toString(), message_id: mid },
              },
            },
          }),
        })
        .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
        .then((resData) => {
          if (resData[resData.length - 1].error_results > 0) throw resData[0].o0.errors;
          if (resData[resData.length - 1].successful_results === 0)
            throw { error: "forcedFetch: there was no successful_results", res: resData };

          var fetchData = resData[0].o0.data.message;
          if (utils.getType(fetchData) != "Object") return log.error("forcedFetch", fetchData);

          switch (fetchData.__typename) {
            case "ThreadImageMessage":
              if (
                (ctx.globalOptions.selfListen ||
                  fetchData.message_sender.id.toString() !== ctx.userID) &&
                ctx.loggedIn
              ) {
                globalCallback(null, {
                  type: "change_thread_image",
                  threadID: utils.formatID(tid.toString()),
                  snippet: fetchData.snippet,
                  timestamp: fetchData.timestamp_precise,
                  author: fetchData.message_sender.id,
                  image: {
                    attachmentID:
                      fetchData.image_with_metadata &&
                      fetchData.image_with_metadata.legacy_attachment_id,
                    width:
                      fetchData.image_with_metadata &&
                      fetchData.image_with_metadata.original_dimensions.x,
                    height:
                      fetchData.image_with_metadata &&
                      fetchData.image_with_metadata.original_dimensions.y,
                    url:
                      fetchData.image_with_metadata &&
                      fetchData.image_with_metadata.preview.uri,
                  },
                });
              }
              break;
            case "UserMessage":
              globalCallback(null, {
                type: "message",
                senderID: utils.formatID(fetchData.message_sender.id),
                body: fetchData.message.text || "",
                threadID: utils.formatID(tid.toString()),
                messageID: fetchData.message_id,
                attachments: [
                  {
                    type: "share",
                    ID: fetchData.extensible_attachment.legacy_attachment_id,
                    url: fetchData.extensible_attachment.story_attachment.url,
                    title:
                      fetchData.extensible_attachment.story_attachment.title_with_entities.text,
                    description:
                      fetchData.extensible_attachment.story_attachment.description.text,
                    source: fetchData.extensible_attachment.story_attachment.source,
                    image: (
                      (fetchData.extensible_attachment.story_attachment.media || {}).image || {}
                    ).uri,
                    width: (
                      (fetchData.extensible_attachment.story_attachment.media || {}).image || {}
                    ).width,
                    height: (
                      (fetchData.extensible_attachment.story_attachment.media || {}).image || {}
                    ).height,
                    playable:
                      (fetchData.extensible_attachment.story_attachment.media || {})
                        .is_playable || false,
                    duration:
                      (fetchData.extensible_attachment.story_attachment.media || {})
                        .playable_duration_in_ms || 0,
                    subattachments: fetchData.extensible_attachment.subattachments,
                    properties: fetchData.extensible_attachment.story_attachment.properties,
                  },
                ],
                mentions: {},
                timestamp: parseInt(fetchData.timestamp_precise),
                participantIDs:
                  fetchData.participants ||
                  (fetchData.messageMetadata
                    ? fetchData.messageMetadata.cid
                      ? fetchData.messageMetadata.cid.canonicalParticipantFbids
                      : fetchData.messageMetadata.participantIds
                    : []) ||
                  [],
                isGroup: fetchData.message_sender.id != tid.toString(),
              });
          }
        })
        .catch((err) => log.error("forcedFetch", err));
      break;
    }
    case "ThreadName":
    case "ParticipantsAddedToGroupThread":
    case "ParticipantsLeftGroupThread": {
      let formattedEvent;
      try {
        formattedEvent = utils.formatDeltaEvent(v.delta);
      } catch (err) {
        return globalCallback({
          error: "Problem parsing event object.",
          detail: err,
          res: v.delta,
          type: "parse_error",
        });
      }
      return (!ctx.globalOptions.selfListen &&
        formattedEvent.author.toString() === ctx.userID) ||
        !ctx.loggedIn
        ? undefined
        : globalCallback(null, formattedEvent);
    }
  }
}

/** @param {Object} ctx @param {Object} api @param {string} threadID @param {string} messageID */
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

/** @param {Object} ctx @param {Object} cbRef @param {Function} callback */
function stopListening(ctx, cbRef, callback) {
  callback = callback || (() => {});
  ctx.loggedIn = false;

  resetReconnectState(ctx);

  if (cbRef && typeof cbRef.silence === "function") cbRef.silence();

  teardownMqtt(ctx, () => {
    ctx.lastSeqId = null;
    ctx.syncToken = undefined;
    ctx.t_mqttCalled = false;
    ctx.tmsWait = null;
    ctx.firstListen = true;
    log.info("stopListening", "listener stopped");
    callback(null, { success: true });
  });
}

/** @param {Object} defaultFuncs @param {Object} ctx @param {Object} cbRef @param {Function} callback */
function logout(defaultFuncs, ctx, cbRef, callback) {
  const done = (result) => {
    if (typeof callback === "function") callback(null, result);
    return result;
  };

  return new Promise((resolve) => {
    if (ctx._loggedOut) return resolve(done({ success: true, message: "Already logged out" }));
    ctx._loggedOut = true;

    stopListening(ctx, cbRef, async function () {
      form = {};
      try {
        const res = await session.logout(ctx.jar, ctx, ctx.globalOptions);
        resolve(
          done({
            success: true,
            message: "Logged out successfully",
            userID: res && res.userID,
            timestamp: Date.now(),
          })
        );
      } catch (err) {
        log.warn("logout", "server logout failed: " + (err.message || err.error || err));
        session.clearSession(ctx.jar, ctx, { wipeCookies: true, wipeFiles: true });
        resolve(
          done({
            success: true,
            warning: "Local logout done, server logout failed",
            timestamp: Date.now(),
          })
        );
      }
    });
  });
}

/** @param {Object} defaultFuncs @param {Object} api @param {Object} ctx */
module.exports = function (defaultFuncs, api, ctx) {
  const cbRef = makeCallbackRef(identity);

  api.logout = function (callback) {
    return logout(defaultFuncs, ctx, cbRef, callback);
  };
  api.stopListening = function (callback) {
    return stopListening(ctx, cbRef, callback);
  };
  api.isSuspended = function () {
    return ctx._fatal === "account_suspended" || ctx._fatal === "account_locked"
      ? { suspended: true, type: ctx._fatal }
      : { suspended: false };
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

        setTimeout(() => {
          if (isActive(ctx)) listenMqtt(defaultFuncs, api, ctx, cbRef);
        }, getRandomInt(200, INITIAL_LISTEN_JITTER_MS));
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
          clearReconnectTimer(ctx);
          ctx._reconnectTimer = setTimeout(() => {
            ctx._reconnectTimer = null;
            if (isActive(ctx)) getSeqID();
          }, RATE_LIMIT_RETRY_DELAY);
          return;
        }

        log.error("getSeqId", err);
        cbRef.fn(err);

        // Use the same single-shot scheduler as MQTT errors → no stacking.
        scheduleReconnect(ctx, cbRef);
      });
  };

  /** @param {Function} callback */
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

    // Only wipe _fatal when the caller explicitly restarts after a clean
    // logout. Otherwise a suspended account gets spammed every time listen()
    // is called.
    if (ctx._fatal && ctx._fatal !== "reconnect_exhausted") {
      log.warn(
        "listenMqtt",
        `refusing to restart — previous fatal state: ${ctx._fatal}. Call api.logout() and re-login.`
      );
      return msgEmitter;
    }

    ctx._fatal = undefined;
    ctx.loggedIn = true;
    resetReconnectState(ctx);

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
    else listenMqtt(defaultFuncs, api, ctx, cbRef);

    ctx.firstListen = false;

    return msgEmitter;
  };
};
