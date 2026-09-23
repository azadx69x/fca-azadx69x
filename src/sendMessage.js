// fixed by @azadx69x 
"use strict";

var utils = require("../utils");
var log = require("npmlog");
var bluebird = require("bluebird");

/**
 * The multipart part for one attachment. Filenames/Content-Types are applied
 * by `utils.prepareAttachment`, which assigns `stream.path` so the bundled
 * `form-data@2.x` (required by request@2.88.2) emits the correct headers. The
 * newer `{ value, options }` shape throws on form-data 2.x. See the helper.
 */
function attachmentFormValue(attachment, index) {
	return utils.prepareAttachment(attachment, index);
}

function isUnavailableThreadError(error) {
	const code = Number(error?.error);
	const text = `${error?.errorSummary || ""} ${error?.errorDescription || ""}`.toLowerCase();
	return code === 1545012 || code === 1545116 || /thread disabled|not part of the conversation/.test(text);
}

var allowedProperties = {
	attachment: true,
	url: true,
	sticker: true,
	emoji: true,
	emojiSize: true,
	body: true,
	mentions: true,
	location: true
};

module.exports = function (defaultFuncs, api, ctx) {
	function uploadAttachment(attachments, callback) {
		var uploads = [];

		for (var i = 0; i < attachments.length; i++) {
			// Unwrap `attachment: res.data` axios results so the validity check
			// sees the stream while the content-type is read off the response.
			const original = attachments[i];
			const stream = utils.getAttachmentStream ? utils.getAttachmentStream(original) : original;
			if (!utils.isReadableStream(stream)) throw { error: "Attachment should be a readable stream and not " + utils.getType(original) + "." };
			var form = {
				upload_1024: attachmentFormValue(original, i),
				// Facebook's upload.php treats voice_clip as the generic "this
				// part is media" flag; the response metadata decides the real
				// type. Sending image/video/file here instead makes Facebook
				// drop the part and reject the later send as blank (1545023).
				voice_clip: "true"
			};

			uploads.push(
				defaultFuncs
					.postFormData("https://upload.facebook.com/ajax/mercury/upload.php", ctx.jar, form, {}, {})
					.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
					.then(function (resData) {
						// Never return undefined here: handleAttachment feeds this
						// straight into Object.keys(), which used to throw
						// "Cannot convert undefined or null to object".
						const file = utils.extractUploadMetadata
							? utils.extractUploadMetadata(resData)
							: (resData && resData.payload && resData.payload.metadata ? resData.payload.metadata[0] : null);
						if (!file) {
							const reason = (resData && (resData.errorDescription || resData.errorSummary || resData.error)) || "Upload failed: Facebook returned no attachment metadata.";
							throw { error: reason };
						}
						return file;
					})
			);
		}

		bluebird
			.all(uploads)
			.then(resData => callback(null, (Array.isArray(resData) ? resData : []).filter(function (file) {
				return file && typeof file === "object" && Object.keys(file).length > 0;
			})))
			.catch(function (err) {
				log.error("uploadAttachment", err);
				return callback(err);
			});
	}

	function getUrl(url, callback) {
		var form = {
			image_height: 960,
			image_width: 960,
			uri: url
		};

		defaultFuncs
			.post("https://www.facebook.com/message_share_attachment/fromURI/", ctx.jar, form)
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(function (resData) {
				if (resData.error) return callback(resData);
				if (!resData.payload) return callback({ error: "Invalid url" });
				callback(null, resData.payload.share_data.share_params);
			})
			.catch(function (err) {
				log.error("getUrl", err);
				return callback(err);
			});
	}

	function sendContent(form, threadID, isSingleUser, messageAndOTID, callback) {
		if (utils.getType(threadID) === "Array") {
			for (var i = 0; i < threadID.length; i++) form["specific_to_list[" + i + "]"] = "fbid:" + threadID[i];
			form["specific_to_list[" + threadID.length + "]"] = "fbid:" + ctx.userID;
			form["client_thread_id"] = "root:" + messageAndOTID;
			log.info("sendMessage", "Sending message to multiple users: " + threadID);
		}
		else {
			if (isSingleUser) {
				form["specific_to_list[0]"] = "fbid:" + threadID;
				form["specific_to_list[1]"] = "fbid:" + ctx.userID;
				form["other_user_fbid"] = threadID;
			}
			else form["thread_fbid"] = threadID;
		}

		if (ctx.globalOptions.pageID) {
			form["author"] = "fbid:" + ctx.globalOptions.pageID;
			form["specific_to_list[1]"] = "fbid:" + ctx.globalOptions.pageID;
			form["creator_info[creatorID]"] = ctx.userID;
			form["creator_info[creatorType]"] = "direct_admin";
			form["creator_info[labelType]"] = "sent_message";
			form["creator_info[pageID]"] = ctx.globalOptions.pageID;
			form["request_user_id"] = ctx.globalOptions.pageID;
			form["creator_info[profileURI]"] = "https://www.facebook.com/profile.php?id=" + ctx.userID;
		}

		defaultFuncs
			.post("https://www.facebook.com/messaging/send/", ctx.jar, form)
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(function (resData) {
				if (!resData) return callback({ error: "Send message failed." });
				if (resData.error) {
					if (Number(resData.error) === 1545023) {
						log.error("sendMessage", "Outgoing payload summary", {
							bodyLength: String(form.body || "").length,
							hasAttachment: form.has_attachment,
							imageIds: Array.isArray(form.image_ids) ? form.image_ids.length : 0,
							gifIds: Array.isArray(form.gif_ids) ? form.gif_ids.length : 0,
							videoIds: Array.isArray(form.video_ids) ? form.video_ids.length : 0,
							audioIds: Array.isArray(form.audio_ids) ? form.audio_ids.length : 0,
							fileIds: Array.isArray(form.file_ids) ? form.file_ids.length : 0,
							route: form.thread_fbid ? "thread_fbid" : form.other_user_fbid ? "other_user_fbid" : "missing"
						});
					}
					if (isUnavailableThreadError(resData))
						log.info("sendMessage", "Skipping unavailable thread " + threadID);
					else {
						log.error("sendMessage", resData);
					}
					return callback(resData);
				}

				var messageInfo = resData.payload.actions.reduce(function (p, v) {
					return (
						{
							threadID: v.thread_fbid,
							messageID: v.message_id,
							timestamp: v.timestamp
						} || p
					);
				}, null);

				return callback(null, messageInfo);
			})
			.catch(function (err) {
				log.error("sendMessage", err);
				if (utils.getType(err) == "Object" && err.error === "Not logged in.") ctx.loggedIn = false;
				return callback(err);
			});
	}

	function send(form, threadID, messageAndOTID, callback, isGroup) {
		const sendNow = () => {
			// Match the npm routing. Do not make another getThreadInfo request.
			if (utils.getType(threadID) === "Array")
				return sendContent(form, threadID, false, messageAndOTID, callback);
			if (utils.getType(isGroup) !== "Boolean")
				return sendContent(form, threadID, threadID.length === 15, messageAndOTID, callback);
			return sendContent(form, threadID, !isGroup, messageAndOTID, callback);
		};

		const config = global.GoatBot?.config || {};
		const typingConfig = config.typingIndicator;
		const typingEnabled = typingConfig === true
			? true
			: typingConfig && typeof typingConfig === "object"
				? typingConfig.enable === true
				: config.enableTypingIndicator === true;
		const configuredDuration = typingConfig && typeof typingConfig === "object"
			? typingConfig.duration
			: config.typingDuration;
		const typingDuration = Number(configuredDuration) || 2000;

		if (!typingEnabled || !form.body || utils.getType(threadID) === "Array" || typeof api.sendTypingIndicator !== "function")
			return sendNow();

		try {
			api.sendTypingIndicator(true, threadID, (err) => {
				if (err) return sendNow();
				setTimeout(() => {
					try {
						api.sendTypingIndicator(false, threadID, () => sendNow());
					}
					catch (_) {
						sendNow();
					}
				}, typingDuration);
			});
		}
		catch (_) {
			return sendNow();
		}
	}

	function handleUrl(msg, form, callback, cb) {
		if (msg.url) {
			form["shareable_attachment[share_type]"] = "100";
			getUrl(msg.url, function (err, params) {
				if (err) return callback(err);
				form["shareable_attachment[share_params]"] = params;
				cb();
			});
		}
		else cb();
	}

	function handleLocation(msg, form, callback, cb) {
		if (msg.location) {
			if (msg.location.latitude == null || msg.location.longitude == null) return callback({ error: "location property needs both latitude and longitude" });
			form["location_attachment[coordinates][latitude]"] = msg.location.latitude;
			form["location_attachment[coordinates][longitude]"] = msg.location.longitude;
			form["location_attachment[is_current_location]"] = !!msg.location.current;
		}
		cb();
	}

	function handleSticker(msg, form, callback, cb) {
		if (msg.sticker) form["sticker_id"] = msg.sticker;
		cb();
	}

	function handleEmoji(msg, form, callback, cb) {
		if (msg.emojiSize != null && msg.emoji == null) return callback({ error: "emoji property is empty" });
		if (msg.emoji) {
			if (msg.emojiSize == null) msg.emojiSize = "medium";
			if (msg.emojiSize != "small" && msg.emojiSize != "medium" && msg.emojiSize != "large") return callback({ error: "emojiSize property is invalid" });
			if (form["body"] != null && form["body"] != "") return callback({ error: "body is not empty" });
			form["body"] = msg.emoji;
			if (!form["tags[0]"]) form["tags[0]"] = "hot_emoji_size:" + msg.emojiSize;
		}
		cb();
	}

	function handleAttachment(msg, form, callback, cb) {
		if (msg.attachment) {
			form["image_ids"] = [];
			form["gif_ids"] = [];
			form["file_ids"] = [];
			form["video_ids"] = [];
			form["audio_ids"] = [];

			if (utils.getType(msg.attachment) !== "Array") msg.attachment = [msg.attachment];
			if (msg.attachment.every(e => /_id$/.test(e[0]))) {
				msg.attachment.map(e => form[`${e[0]}s`].push(e[1]));
				return cb();
			}
			uploadAttachment(msg.attachment, function (err, files) {
				if (err) return callback(err);
				const list = Array.isArray(files) ? files : [files];
				for (var i = 0; i < list.length; i++) {
					const file = list[i];
					if (!file || typeof file !== "object") continue;
					const target = utils.resolveAttachmentTarget
						? utils.resolveAttachmentTarget(file)
						: null;
					if (target && form[target.field]) {
						form[target.field].push(target.id);
						continue;
					}
					// The upload response names the field itself: image_id,
					// gif_id, video_id, audio_id or file_id. Trust that key
					// (matching the upstream fca contract) and fall back to a
					// resolved target only if the response is unexpected.
					const keys = Object.keys(file).filter(function (k) {
						return /_id$/.test(k) && file[k];
					});
					if (keys.length) {
						const type = keys[0];
						if (form[type + "s"]) form[type + "s"].push(file[type]);
						continue;
					}
				}
				cb();
			});
		}
		else cb();
	}

	function handleMention(msg, form, callback, cb) {
		if (msg.mentions) {
			for (let i = 0; i < msg.mentions.length; i++) {
				const mention = msg.mentions[i];
				const tag = mention.tag;
				if (typeof tag !== "string") return callback({ error: "Mention tags must be strings." });
				const offset = msg.body.indexOf(tag, mention.fromIndex || 0);
				if (offset < 0) log.warn("handleMention", 'Mention for "' + tag + '" not found in message string.');
				if (mention.id == null) log.warn("handleMention", "Mention id should be non-null.");

				const id = mention.id || 0;
				const emptyChar = '\u200E';
				form["body"] = emptyChar + msg.body;
				form["profile_xmd[" + i + "][offset]"] = offset + 1;
				form["profile_xmd[" + i + "][length]"] = tag.length;
				form["profile_xmd[" + i + "][id]"] = id;
				form["profile_xmd[" + i + "][type]"] = "p";
			}
		}
		cb();
	}

	return function sendMessage(msg, threadID, callback, replyToMessage, isGroup) {
		typeof isGroup == "undefined" ? isGroup = null : "";
		if (!callback && (utils.getType(threadID) === "Function" || utils.getType(threadID) === "AsyncFunction")) return threadID({ error: "Pass a threadID as a second argument." });
		if (!replyToMessage && utils.getType(callback) === "String") {
			replyToMessage = callback;
			callback = function () { };
		}

		var resolveFunc = function () { };
		var rejectFunc = function () { };
		var returnPromise = new Promise(function (resolve, reject) {
			resolveFunc = resolve;
			rejectFunc = reject;
		});

		if (!callback) {
			callback = function (err, data) {
				if (err) return rejectFunc(err);
				resolveFunc(data);
			};
		}

		var msgType = utils.getType(msg);
		var threadIDType = utils.getType(threadID);
		var messageIDType = utils.getType(replyToMessage);

		if (msgType !== "String" && msgType !== "Object") return callback({ error: "Message should be of type string or object and not " + msgType + "." });

		if (threadIDType !== "Array" && threadIDType !== "Number" && threadIDType !== "String") return callback({ error: "ThreadID should be of type number, string, or array and not " + threadIDType + "." });

		if (replyToMessage && messageIDType !== 'String') return callback({ error: "MessageID should be of type string and not " + threadIDType + "." });

		if (msgType === "String") msg = { body: msg };
		var disallowedProperties = Object.keys(msg).filter(prop => !allowedProperties[prop]);
		if (disallowedProperties.length > 0) return callback({ error: "Dissallowed props: `" + disallowedProperties.join(", ") + "`" });

		var messageAndOTID = utils.generateOfflineThreadingID();
		var form = {
			client: "mercury",
			action_type: "ma-type:user-generated-message",
			author: "fbid:" + ctx.userID,
			timestamp: Date.now(),
			timestamp_absolute: "Today",
			timestamp_relative: utils.generateTimestampRelative(),
			timestamp_time_passed: "0",
			is_unread: false,
			is_cleared: false,
			is_forward: false,
			is_filtered_content: false,
			is_filtered_content_bh: false,
			is_filtered_content_account: false,
			is_filtered_content_quasar: false,
			is_filtered_content_invalid_app: false,
			is_spoof_warning: false,
			source: "source:chat:web",
			"source_tags[0]": "source:chat",
			body: msg.body ? msg.body.toString() : "",
			html_body: false,
			ui_push_phase: "V3",
			status: "0",
			offline_threading_id: messageAndOTID,
			message_id: messageAndOTID,
			threading_id: utils.generateThreadingID(ctx.clientID),
			"ephemeral_ttl_mode:": "0",
			manual_retry_cnt: "0",
			has_attachment: !!(msg.attachment || msg.url || msg.sticker),
			signatureID: utils.getSignatureID(),
			replied_to_message_id: replyToMessage
		};

		handleLocation(msg, form, callback, () =>
			handleSticker(msg, form, callback, () =>
				handleAttachment(msg, form, callback, () =>
					handleUrl(msg, form, callback, () =>
						handleEmoji(msg, form, callback, () =>
							handleMention(msg, form, callback, () =>
								send(form, threadID, messageAndOTID, callback, isGroup)
							)
						)
					)
				)
			)
		);
		return returnPromise;
	};
};
