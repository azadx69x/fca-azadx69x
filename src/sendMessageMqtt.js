"use strict";

var utils = require("../utils");

/**
 * The multipart part for one attachment. Filenames/Content-Types are applied
 * by `utils.prepareAttachment`, which assigns `stream.path` so the bundled
 * `form-data@2.x` (required by request@2.88.2) emits the correct headers. The
 * newer `{ value, options }` shape throws on form-data 2.x. See the helper.
 */
function attachmentFormValue(attachment, index) {
  return utils.prepareAttachment(attachment, index);
}

function buildMentionData(msg, baseBody) {
  if (!msg.mentions || !Array.isArray(msg.mentions) || !msg.mentions.length) return null;
  const base = typeof baseBody === "string" ? baseBody : "";
  const ids = [];
  const offsets = [];
  const lengths = [];
  const types = [];
  let cursor = 0;
  for (const m of msg.mentions) {
    const raw = String(m.tag || "");
    const name = raw.replace(/^@+/, "");
    const start = Number.isInteger(m.fromIndex) ? m.fromIndex : cursor;
    let idx = base.indexOf(raw, start);
    let adj = 0;
    if (idx === -1) {
      idx = base.indexOf(name, start);
      adj = 0;
    } else {
      adj = raw.length - name.length;
    }
    if (idx < 0) {
      idx = 0;
      adj = 0;
    }
    const off = idx + adj;
    ids.push(String(m.id || 0));
    offsets.push(off);
    lengths.push(name.length);
    types.push("p");
    cursor = off + name.length;
  }
  return {
    mention_ids: ids.join(","),
    mention_offsets: offsets.join(","),
    mention_lengths: lengths.join(","),
    mention_types: types.join(",")
  };
}

module.exports = function (defaultFuncs, api, ctx) {
  function uploadAttachment(attachments, callback) {
    callback = callback || function () {};
    var uploads = [];

    // create an array of promises
    for (var i = 0; i < attachments.length; i++) {
      // Unwrap `attachment: res.data` axios results so the validity check sees
      // the stream while the content-type is read off the response headers.
      const original = attachments[i];
      const stream = utils.getAttachmentStream ? utils.getAttachmentStream(original) : original;
      if (!utils.isReadableStream(stream)) {
        throw {
          error:
            "Attachment should be a readable stream and not " +
            utils.getType(original) +
            ".",
        };
      }

      var form = {
        upload_1024: attachmentFormValue(original, i),
        // Facebook's upload.php treats voice_clip as the generic "this part
        // is media" flag; the response metadata decides the real type. A
        // per-type flag here makes Facebook drop the part (error 1545023).
        voice_clip: "true",
      };

      uploads.push(
        defaultFuncs
          .postFormData(
            "https://upload.facebook.com/ajax/mercury/upload.php",
            ctx.jar,
            form,
            {},
          )
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then(function (resData) {
            // Same reader as sendMessage.js: parseAndCheckLogin may wrap the
            // body in an array, so resData.payload.metadata[0] would throw.
            const file = utils.extractUploadMetadata
              ? utils.extractUploadMetadata(resData)
              : (resData && resData.payload && resData.payload.metadata ? resData.payload.metadata[0] : null);
            if (!file) {
              const reason = (resData && (resData.errorDescription || resData.errorSummary || resData.error)) || "Upload failed: Facebook returned no attachment metadata.";
              throw typeof reason === "string" ? { error: reason } : reason;
            }
            return file;
          }),
      );
    }

    // resolve all promises
    Promise.all(uploads)
      .then(function (resData) {
        callback(null, (Array.isArray(resData) ? resData : []).filter(function (file) {
          return file && typeof file === "object" && Object.keys(file).length > 0;
        }));
      })
      .catch(function (err) {
        utils.error("uploadAttachment", err);
        return callback(err);
      });
  }

  let variance = 0;
  const epoch_id = () =>
    Math.floor(Date.now() * (4194304 + (variance = (variance + 0.1) % 5)));
  const emojiSizes = {
    small: 1,
    medium: 2,
    large: 3,
  };

  function handleEmoji(msg, form, callback, cb) {
    if (msg.emojiSize != null && msg.emoji == null) {
      return callback({ error: "emoji property is empty" });
    }
    if (msg.emoji) {
      if (!msg.emojiSize) {
        msg.emojiSize = "small";
      }
      if (
        msg.emojiSize !== "small" &&
        msg.emojiSize !== "medium" &&
        msg.emojiSize !== "large" &&
        (isNaN(msg.emojiSize) || msg.emojiSize < 1 || msg.emojiSize > 3)
      ) {
        return callback({ error: "emojiSize property is invalid" });
      }

      form.payload.tasks[0].payload.send_type = 1;
      form.payload.tasks[0].payload.text = msg.emoji;
      form.payload.tasks[0].payload.hot_emoji_size = !isNaN(msg.emojiSize)
        ? msg.emojiSize
        : emojiSizes[msg.emojiSize];
    }
    cb();
  }

  function handleSticker(msg, form, callback, cb) {
    if (msg.sticker) {
      form.payload.tasks[0].payload.send_type = 2;
      form.payload.tasks[0].payload.sticker_id = msg.sticker;
    }
    cb();
  }

  function handleAttachment(msg, form, callback, cb) {
    if (msg.attachment) {
      form.payload.tasks[0].payload.send_type = 3;
      form.payload.tasks[0].payload.attachment_fbids = [];
      if (form.payload.tasks[0].payload.text == "")
        form.payload.tasks[0].payload.text = null;
      if (utils.getType(msg.attachment) !== "Array") {
        msg.attachment = [msg.attachment];
      }

      uploadAttachment(msg.attachment, function (err, files) {
        if (err) {
          return callback(err);
        }

        const list = Array.isArray(files) ? files : [files];
        for (let i = 0; i < list.length; i++) {
          const file = list[i];
          if (!file || typeof file !== "object") continue;
          // The upload response names its own field (image_id, gif_id,
          // video_id, audio_id, file_id). Trust that key, matching the
          // upstream fca contract, and fall back to the resolver only if
          // the response is unexpected.
          const idKeys = Object.keys(file).filter(function (k) {
            return /_id$/.test(k) && file[k];
          });
          if (idKeys.length) {
            form.payload.tasks[0].payload.attachment_fbids.push(
              String(file[idKeys[0]]),
            );
            continue;
          }
          const target = utils.resolveAttachmentTarget
            ? utils.resolveAttachmentTarget(file)
            : null;
          if (target)
            form.payload.tasks[0].payload.attachment_fbids.push(target.id); // push the id
        }
        cb();
      });
    } else {
      cb();
    }
  }

  function handleMention(msg, form, callback, cb) {
    if (msg.mentions) {
      form.payload.tasks[0].payload.send_type = 1;
      const baseBody = msg.body != null ? String(msg.body) : "";
      const mentionData = buildMentionData(msg, baseBody);
      if (mentionData) form.payload.tasks[0].payload.mention_data = mentionData;
    }
    cb();
  }

  function handleLocation(msg, form, callback, cb) {
    // this is not working yet
    if (msg.location) {
      if (msg.location.latitude == null || msg.location.longitude == null) {
        return callback({
          error: "location property needs both latitude and longitude",
        });
      }

      form.payload.tasks[0].payload.send_type = 1;
      form.payload.tasks[0].payload.location_data = {
        coordinates: {
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
        },
        is_current_location: !!msg.location.current,
        is_live_location: !!msg.location.live,
      };
    }

    cb();
  }

  function send(form, threadID, callback, replyToMessage) {
    if (replyToMessage) {
      form.payload.tasks[0].payload.reply_metadata = {
        reply_source_id: replyToMessage,
        reply_source_type: 1,
        reply_type: 0,
      };
    }
    const mqttClient = ctx.mqttClient;
    form.payload.tasks.forEach((task) => {
      task.payload = JSON.stringify(task.payload);
    });
    form.payload = JSON.stringify(form.payload);
    return mqttClient.publish(
      "/ls_req",
      JSON.stringify(form),
      function (err, data) {
        if (err) {
          utils.error("Error publishing message: ", err);
          callback(err);
        } else {
          callback(null, data);
        }
      },
    );
  }

  return function sendMessageMqtt(msg, threadID, callback, replyToMessage) {
    if (
      !callback &&
      (utils.getType(threadID) === "Function" ||
        utils.getType(threadID) === "AsyncFunction")
    ) {
      return threadID({ error: "Pass a threadID as a second argument." });
    }
    if (!replyToMessage && utils.getType(callback) === "String") {
      replyToMessage = callback;
      callback = function () {};
    }

    if (!callback) {
      callback = function (err, friendList) {};
    }

    var msgType = utils.getType(msg);
    var threadIDType = utils.getType(threadID);
    var messageIDType = utils.getType(replyToMessage);

    if (msgType !== "String" && msgType !== "Object") {
      return callback({
        error:
          "Message should be of type string or object and not " + msgType + ".",
      });
    }

    if (msgType === "String") {
      msg = { body: msg };
    }

    const timestamp = Date.now();
    // get full date time
    const epoch = timestamp << 22;
    //const otid = epoch + 0; // TODO replace with randomInt(0, 2**22)
    const otid = epoch + Math.floor(Math.random() * 4194304);

    const form = {
      app_id: "2220391788200892",
      payload: {
        tasks: [
          {
            label: "46",
            payload: {
              thread_id: threadID.toString(),
              otid: otid.toString(),
              source: 0,
              send_type: 1,
              sync_group: 1,
              text:
                msg.body != null && msg.body != undefined
                  ? msg.body.toString()
                  : "",
              initiating_source: 1,
              skip_url_preview_gen: 0,
            },
            queue_name: threadID.toString(),
            task_id: 0,
            failure_count: null,
          },
          {
            label: "21",
            payload: {
              thread_id: threadID.toString(),
              last_read_watermark_ts: Date.now(),
              sync_group: 1,
            },
            queue_name: threadID.toString(),
            task_id: 1,
            failure_count: null,
          },
        ],
        epoch_id: epoch_id(),
        version_id: "6120284488008082",
        data_trace_id: null,
      },
      request_id: 1,
      type: 3,
    };

    handleEmoji(msg, form, callback, function () {
      handleLocation(msg, form, callback, function () {
        handleMention(msg, form, callback, function () {
          handleSticker(msg, form, callback, function () {
            handleAttachment(msg, form, callback, function () {
              send(form, threadID, callback, replyToMessage);
            });
          });
        });
      });
    });
  };
};
