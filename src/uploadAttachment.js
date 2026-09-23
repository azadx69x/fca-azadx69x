const utils = require("../utils");
// @NethWs3Dev

/**
 * Filenames/Content-Types are applied by `utils.prepareAttachment`, which
 * assigns `stream.path` so `form-data@2.x` (bundled with request@2.88.2) emits
 * the correct multipart headers. See that helper for the full explanation.
 */
module.exports = function (defaultFuncs, api, ctx) {
  function upload(attachments, callback) {
    callback = callback || function () {};
    const uploads = [];

    // create an array of promises
    for (let i = 0; i < attachments.length; i++) {
      // Commands frequently do `attachment: res.data` — pass the axios RESULT,
      // not the stream. Unwrap it so the type check and the form value both see
      // the real stream while the content-type is read off the response headers.
      const original = attachments[i];
      const stream = utils.getAttachmentStream ? utils.getAttachmentStream(original) : original;
      if (!utils.isReadableStream(stream)) {
        callback({
          error:
            "Attachment should be a readable stream and not " +
            utils.getType(original) +
            ".",
        });
        return;
      }

      let prepared;
      try {
        prepared = utils.prepareAttachment(original, i);
      }
      catch (err) {
        callback(err);
        return;
      }

      const form = {
        upload_1024: prepared,
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
            // Facebook can answer with an error object, an empty metadata
            // array, or a payload-less body. Never hand back undefined: that is
            // what made sendMessage crash later on Object.keys(file).
            const file = utils.extractUploadMetadata
              ? utils.extractUploadMetadata(resData)
              : (resData && resData.payload && resData.payload.metadata
                ? resData.payload.metadata[0]
                : null);
            if (!file) {
              const reason =
                (resData && (resData.errorDescription || resData.errorSummary || resData.error)) ||
                "Upload failed: Facebook returned no attachment metadata.";
              throw typeof reason === "string" ? { error: reason } : reason;
            }
            return file;
          }),
      );
    }

    // resolve all promises
    Promise.all(uploads)
      .then(function (resData) {
        const files = (Array.isArray(resData) ? resData : []).filter(function (file) {
          return file && typeof file === "object" && Object.keys(file).length > 0;
        });
        if (!files.length) {
          return callback({ error: "Upload failed: no attachment metadata received." });
        }
        callback(null, files);
      })
      .catch(function (err) {
        utils.error("uploadAttachment", err);
        return callback(err);
      });
  }

  return function uploadAttachment(attachments, callback) {
    if (!attachments || (utils.getType(attachments) === "Array" && !attachments.length)) {
      throw { error: "Please pass an attachment or an array of attachments." };
    }

    let resolveFunc = function () {};
    let rejectFunc = function () {};
    const returnPromise = new Promise(function (resolve, reject) {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (!callback) {
      callback = function (err, info) {
        if (err) {
          return rejectFunc(err);
        }
        resolveFunc(info);
      };
    }

    if (utils.getType(attachments) !== "Array") attachments = [attachments];

    upload(attachments, (err, info) => {
      if (err) {
        return callback(err);
      }
      callback(null, info);
    });

    return returnPromise;
  };
};
