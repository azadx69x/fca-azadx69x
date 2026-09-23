"use strict";

const antiSuspension = require("./antiSuspension");
const chalk = require("chalk");
const gradient = require("gradient-string");
const echaceb = gradient(["#0061ff", "#681297"]);
const ws = echaceb("fca-azadx69x");
const verboseLogging = process.env.FCA_VERBOSE_LOGS === "true";

const requestDelays = new Map();
const MIN_REQUEST_DELAY = antiSuspension.DEFAULT_LIMITS.minGapMs;
const MAX_REQUESTS_PER_MINUTE = antiSuspension.DEFAULT_LIMITS.maxPerMinute;
const DEFAULT_USER_KEY = "global";

const FB_DOMAINS = [
    "https://www.facebook.com",
    "https://m.facebook.com",
    "https://web.facebook.com",
    "https://business.facebook.com",
    "https://www.messenger.com"
];

const SHARED_COOKIE_DOMAINS = [
    ".facebook.com", ".messenger.com",
    "facebook.com", "messenger.com",
    "www.facebook.com", "www.messenger.com"
];

const CRITICAL_COOKIE_KEYS = [
    "c_user", "xs", "fr", "sb", "datr", "wd",
    "spin", "presence", "_js_datr", "_js_reg_fb_ref"
];

const logoutCooldowns = new Map();
const LOGOUT_COOLDOWN_MS = 60 * 1000;
const LOGOUT_GLOBAL_COOLDOWN_MS = 30 * 1000;
let lastGlobalLogout = 0;

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(value, timeoutMs, label = "operation") {
    const limit = Math.max(1, Number(timeoutMs) || 1);
    const operation = typeof value === "function"
        ? Promise.resolve().then(value)
        : Promise.resolve(value);
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${limit}ms`)), limit);
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function safeJsonParse(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === "object" && !Buffer.isBuffer(value)) return value;
    try {
        return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
    }
    catch (_) {
        return fallback;
    }
}

function normalizeThreadID(threadID) {
    if (threadID == null) return null;
    const value = String(threadID).trim();
    return value || null;
}

function isTransientError(error) {
    const status = Number(error?.statusCode || error?.status || error?.response?.status);
    const code = String(error?.code || error?.error || "").toLowerCase();
    if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
    return /timeout|timed out|socket|network|econn|reset|temporar|offline|rate limit/.test(
        `${code} ${error?.message || ""}`.toLowerCase()
    );
}

function redactError(error) {
    if (!error) return null;
    return {
        name: error.name || "Error",
        message: String(error.message || error.error || error),
        code: error.code || error.errorCode || null,
        status: error.statusCode || error.status || error.response?.status || null,
        transient: isTransientError(error),
    };
}

/**
 * Turn whatever the upload endpoint returned into a usable metadata object,
 * or null when Facebook replied with an error / unexpected shape.
 *
 * `api.sendMessage` used to blindly read `payload.metadata[0]` and then run
 * `Object.keys(file)` on it. When the response was an error object or an empty
 * metadata array, `file` was undefined and the whole send crashed with
 * "TypeError: Cannot convert undefined or null to object".
 */
function extractUploadMetadata(resData) {
    if (resData == null) return null;
    if (Buffer.isBuffer(resData)) return null;

    let data = resData;
    if (typeof data === "string") data = safeJsonParse(data, null);

    // parseAndCheckLogin can hand back an array (single-object bodies get
    // wrapped, and Facebook may split a body into several objects). Unwrap
    // recursively so both shapes reach the same metadata reader.
    if (Array.isArray(data)) {
        for (const entry of data) {
            const found = extractUploadMetadata(entry);
            if (found) return found;
        }
        return null;
    }
    if (data == null || typeof data !== "object") return null;

    let payload = data.payload;
    if (payload && typeof payload === "string") payload = safeJsonParse(payload, null);
    if (payload && typeof payload === "object" && payload.payload != null) {
        const nested = typeof payload.payload === "string" ? safeJsonParse(payload.payload, null) : payload.payload;
        if (nested && typeof nested === "object" && (nested.metadata || nested.error)) payload = nested;
    }

    if (payload && payload.error) return null;
    if (data.error) return null;
    if (!payload || typeof payload !== "object") return null;

    const metadata = payload.metadata;
    if (!metadata || typeof metadata !== "object") return null;

    // Facebook has returned both an array and an object keyed by upload name
    // (for example { upload_1024: { image_id: "..." } }). Do not treat the
    // keyed container itself as the attachment metadata.
    const candidates = Array.isArray(metadata)
        ? metadata
        : [metadata, ...Object.values(metadata)];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object" || Object.keys(candidate).length === 0) continue;
        if (resolveAttachmentTarget(candidate) || candidate.filetype || candidate.fileType || candidate.filename) {
            return candidate;
        }
    }
    return null;
}

/**
 * Map one Facebook upload-metadata object to the sendMessage form field it
 * belongs in.
 *
 * The old code read Object.keys(file)[0] and assumed it was the id key. It is
 * not: Facebook returns {"filename","filetype","image_id"} in whatever order
 * it likes, so the first key is frequently "filename". That looked up
 * form["filenames"], which does not exist, so the id was silently dropped and
 * Facebook rejected the send with
 *   error 1545023 "Your message appears to be blank."
 *
 * @returns {{field: string, id: string}|null} the form bucket and the id.
 */
function resolveAttachmentTarget(file) {
    if (!file || typeof file !== "object") return null;

    const directFields = {
        imageid: "image_ids",
        photoid: "image_ids",
        gifid: "gif_ids",
        fileid: "file_ids",
        videoid: "video_ids",
        audioid: "audio_ids",
    };

    // 1. The normal shape: exactly one known *_id key, in any position.
    for (const name of Object.keys(file)) {
        const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
        if (Object.prototype.hasOwnProperty.call(directFields, normalized) && file[name] != null) {
            return { field: directFields[normalized], id: String(file[name]) };
        }
    }

    // 2. Fallback: some responses only carry a generic id plus a mime type.
    const id = file.id ?? file.fbid ?? file.attachment_id ?? file.legacy_attachment_id;
    if (id == null) return null;
    const mime = String(file.filetype || file.type || file.attachment_type || "").toLowerCase();
    const byMime = [
        ["image/gif", "gif_ids"],
        ["image/", "image_ids"],
        ["video/", "video_ids"],
        ["audio/", "audio_ids"],
    ];
    for (const [prefix, field] of byMime) {
        if (mime.startsWith(prefix)) return { field, id: String(id) };
    }
    // Unknown mime but we do have an id: treat it as a generic file.
    return mime ? { field: "file_ids", id: String(id) } : null;
}

/**
 * Read the content-type of an attachment whether it is a bare stream, an axios
 * response (`{ data, headers }`), or a stream that carries `headers` itself.
 * Axios response streams do NOT expose the response headers on the stream, so
 * without this every `attachment: res.data` upload lost its type.
 */
function getAttachmentContentType(attachment) {
    if (!attachment || typeof attachment !== "object") return "";
    const candidates = [
        attachment.headers,
        attachment.response && attachment.response.headers,
        attachment.data && attachment.data.headers
    ];
    for (const headers of candidates) {
        if (!headers || typeof headers !== "object") continue;
        const value = headers["content-type"] || headers["Content-Type"];
        if (value) return String(value).split(";", 1)[0].trim().toLowerCase();
    }
    return "";
}

/** The stream to upload, unwrapping an axios response if one was passed. */
function getAttachmentStream(attachment) {
    if (attachment && typeof attachment === "object" && isReadableStream(attachment.data)) {
        return attachment.data;
    }
    return attachment;
}

const ATTACHMENT_MIME_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
    "application/pdf": "pdf",
    "application/zip": "zip"
};

/**
 * Give a stream a filename `form-data` will use for the multipart part.
 *
 * `request@2.88.2` ships `form-data@~2.3.2`, which only reads the filename (and
 * the Content-Type derived from it) from `value.path` / `value.name`. It does
 * NOT understand the newer `{ value, options }` part shape — passing that shape
 * throws "source.on is not a function" and the upload silently never happens,
 * which is why every photo/video/audio send ended in Facebook error 1545023
 * "Your message appears to be blank."
 *
 * Assigning `stream.path` to a filename with the correct extension makes
 * form-data emit both the filename and the right Content-Type, and it behaves
 * identically on form-data 2.x and 4.x.
 */
function prepareAttachment(attachment, index) {
    const stream = getAttachmentStream(attachment);
    if (!stream || typeof stream !== "object") return stream;

    const headers = (attachment && attachment.headers) || stream.headers || {};
    const contentType =
        getAttachmentContentType(attachment) ||
        headers["content-type"] ||
        headers["Content-Type"] ||
        "";
    const disposition = headers["content-disposition"] || headers["Content-Disposition"] || "";
    const dispositionMatch = /filename\*?=(?:UTF-8''|["']?)([^;"']+)/i.exec(disposition);
    const normalizedType = String(contentType).split(";", 1)[0].trim().toLowerCase();

    const currentPath = typeof stream.path === "string" ? stream.path.split(/[?#]/)[0] : "";
    const currentExt = currentPath && currentPath.includes(".")
        ? currentPath.split(".").pop().toLowerCase()
        : "";
    const extension = ATTACHMENT_MIME_EXTENSIONS[normalizedType] || currentExt;

    // An fs stream already carries a real, descriptive path — leave it alone.
    const hasUsablePath = currentPath && currentPath.includes(".") && currentExt && currentExt !== "noext" && currentExt !== "bin";
    if (!hasUsablePath) {
        const named = [dispositionMatch && dispositionMatch[1], stream.name && String(stream.name)].find(Boolean);
        const base = named && named.includes(".") ? named : "attachment_" + index;
        stream.path = extension && !base.toLowerCase().endsWith("." + extension)
            ? base.replace(/\.[a-z0-9]+$/i, "") + "." + extension
            : base;
    }

    if (!stream.path || !String(stream.path).includes(".")) {
        throw {
            error:
                "Cannot determine a filename for the attachment. Pass an fs.createReadStream " +
                "or a stream whose path/name ends in a media extension."
        };
    }

    return stream;
}


function getRuntimeSnapshot(ctx = {}) {
    return {
        userID: ctx.userID || null,
        loggedIn: ctx.loggedIn !== false,
        mqttConnected: Boolean(ctx.mqttClient?.connected),
        lastSeqId: ctx.lastSeqId || null,
        syncToken: Boolean(ctx.syncToken),
        cachedThreads: ctx._threadMetadata instanceof Map ? ctx._threadMetadata.size : 0,
        cachedGroups: ctx._groupThreadIDs instanceof Set ? ctx._groupThreadIDs.size : 0,
        typingThreads: ctx.typingCounters instanceof Map ? ctx.typingCounters.size : 0,
    };
}

async function throttleRequest(userID = DEFAULT_USER_KEY, ctx) {
    // Delegate to the shared anti-suspension limiter so the gap, the rolling
    // per-minute ceiling and the burst cooldown are all enforced in one place.
    const target = ctx || { userID };
    if (!target.userID) target.userID = userID;
    return antiSuspension.awaitSlot(target, {
        minGapMs: MIN_REQUEST_DELAY,
        maxPerMinute: MAX_REQUESTS_PER_MINUTE,
    });
}

function expireEveryCookie(jar) {
    if (!jar || typeof jar.getCookies !== "function") return;

    FB_DOMAINS.forEach((siteUrl) => {
        let cookies = [];
        try { cookies = jar.getCookies(siteUrl); } catch (_) { return; }

        cookies.forEach((c) => {
            try {
                const key = c.key;
                const path = c.path || "/";
                const cookieDomain = (c.domain || "").replace(/^\./, "");
                const hostPart = cookieDomain ? `Domain=.${cookieDomain}; ` : "";
                const expired =
                    `${key}=deleted; Path=${path}; ${hostPart}` +
                    `Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
                jar.setCookie(expired, "https://www.facebook.com");
                jar.setCookie(expired, "https://www.messenger.com");
                jar.setCookie(expired, siteUrl);
            } catch (_) {}
        });
    });

    SHARED_COOKIE_DOMAINS.forEach((dom) => {
        CRITICAL_COOKIE_KEYS.forEach((key) => {
            try {
                const expired =
                    `${key}=; Path=/; Domain=${dom}; ` +
                    `Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
                jar.setCookie(expired, "https://www.facebook.com");
                jar.setCookie(expired, "https://www.messenger.com");
            } catch (_) {}
        });
    });
}

function clearAllCookies(jar) {
    if (!jar || typeof jar.getCookies !== "function") return Promise.resolve();

    const store = jar._jar && jar._jar.store;
    if (store && typeof store.removeAllCookies === "function") {
        return new Promise((resolve) => {
            try {
                store.removeAllCookies(() => {
                    expireEveryCookie(jar);
                    resolve();
                });
            } catch (_) {
                expireEveryCookie(jar);
                resolve();
            }
        });
    }
    expireEveryCookie(jar);
    return Promise.resolve();
}

async function waitForLogoutCooldown(userID) {
    const key = userID || DEFAULT_USER_KEY;
    const lastUser = logoutCooldowns.get(key) || 0;
    if (Date.now() - lastUser < LOGOUT_COOLDOWN_MS) {
        await sleep(LOGOUT_COOLDOWN_MS - (Date.now() - lastUser));
    }
    if (Date.now() - lastGlobalLogout < LOGOUT_GLOBAL_COOLDOWN_MS) {
        await sleep(LOGOUT_GLOBAL_COOLDOWN_MS - (Date.now() - lastGlobalLogout));
    }
    logoutCooldowns.set(key, Date.now());
    lastGlobalLogout = Date.now();
}

const modernUserAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15"
];

function randomUserAgent() {
    return modernUserAgents[getRandomInt(0, modernUserAgents.length - 1)];
}

const baseHeaders = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-User": "?1",
    "Sec-Fetch-Dest": "document",
    "Cache-Control": "max-age=0",
    "DNT": "1"
};

function getHeaders(url, options, ctx, customHeader) {
    // One stable fingerprint per account, for every request in the session.
    // Randomising the UA/headers per request is what gets accounts locked.
    const fingerprint = antiSuspension.fingerprintFor(ctx);
    const header = (customHeader && typeof customHeader === "object") ? { ...customHeader } : {};
    if (options && options.userAgent) header.customUserAgent = options.userAgent;
    if (ctx && ctx.region) header["X-MSGR-Region"] = ctx.region;
    return antiSuspension.buildHeaders(fingerprint, url, header);
}

let request = require("request").defaults({
    jar: true,
    headers: getHeaders("https://www.facebook.com")
});

function getJar() {
    return request.jar();
}

const stream = require("stream");
const querystring = require("querystring");
const url = require("url");

function setProxy(proxy) {
    request = require("request").defaults({
        jar: true,
        headers: getHeaders("https://www.facebook.com"),
        ...(proxy && { proxy })
    });
}

function isReadableStream(obj) {
    return obj instanceof stream.Stream && typeof obj._read == "function" && getType(obj._readableState) == "Object";
}

function cleanGet(url) {
    return new Promise((resolve, reject) => {
        request.get(url, { timeout: 60000 }, (error, res) => error ? reject(error) : resolve(res));
    });
}

async function get(url, jar, qs, options, ctx, customHeader) {
    await throttleRequest(DEFAULT_USER_KEY);
    return new Promise((resolve, reject) => {
        if (getType(qs) == "Object")
            for (let prop in qs)
                if (getType(qs[prop]) == 'Object') qs[prop] = JSON.stringify(qs[prop]);
        request.get(url, {
            headers: getHeaders(url, options, ctx, customHeader),
            timeout: 60000, qs, jar, gzip: true
        }, (error, res) => error ? reject(error) : resolve(res));
    });
}

async function post(url, jar, form, options, ctx, customHeader) {
    await throttleRequest(DEFAULT_USER_KEY);
    return new Promise((resolve, reject) => {
        request.post(url, {
            headers: getHeaders(url, options, ctx, customHeader),
            timeout: 60000, form, jar, gzip: true
        }, (error, res) => error ? reject(error) : resolve(res));
    });
}

async function postFormData(url, jar, form, qs, options, ctx) {
    await throttleRequest(DEFAULT_USER_KEY);
    return new Promise((resolve, reject) => {
        if (getType(qs) == "Object")
            for (let prop in qs)
                if (getType(qs[prop]) == 'Object') qs[prop] = JSON.stringify(qs[prop]);
        request.post(url, {
            headers: getHeaders(url, options, ctx, { 'content-type': 'multipart/form-data' }),
            timeout: 60000, formData: form, qs, jar, gzip: true
        }, (error, res) => error ? reject(error) : resolve(res));
    });
}

function padZeros(val, len) {
    val = String(val); len = len || 2;
    while (val.length < len) val = "0" + val;
    return val;
}

function generateThreadingID(clientID) {
    return "<" + Date.now() + ":" + Math.floor(Math.random() * 4294967295) + "-" + clientID + "@mail.projektitan.com>";
}

function binaryToDecimal(data) {
    let ret = "";
    while (data !== "0") {
        let end = 0, fullName = "", i = 0;
        for (; i < data.length; i++) {
            end = 2 * end + parseInt(data[i], 10);
            if (end >= 10) { fullName += "1"; end -= 10; }
            else fullName += "0";
        }
        ret = end.toString() + ret;
        data = fullName.slice(fullName.indexOf("1"));
    }
    return ret;
}

function generateOfflineThreadingID() {
    const ret = Date.now();
    const value = Math.floor(Math.random() * 4294967295);
    const str = ("0000000000000000000000" + value.toString(2)).slice(-22);
    return binaryToDecimal(ret.toString(2) + str);
}

let h;
const i = {};
const j = {
    _: "%", A: "%2", B: "000", C: "%7d", D: "%7b%22", E: "%2c%22", F: "%22%3a",
    G: "%2c%22ut%22%3a1", H: "%2c%22bls%22%3a", I: "%2c%22n%22%3a%22%",
    J: "%22%3a%7b%22i%22%3a0%7d", K: "%2c%22pt%22%3a0%2c%22vis%22%3a",
    L: "%2c%22ch%22%3a%7b%22h%22%3a%22", M: "%7b%22v%22%3a2%2c%22time%22%3a1",
    N: ".channel%22%2c%22sub%22%3a%5b", O: "%2c%22sb%22%3a1%2c%22t%22%3a%5b",
    P: "%2c%22ud%22%3a100%2c%22lc%22%3a0", Q: "%5d%2c%22f%22%3anull%2c%22uct%22%3a",
    R: ".channel%22%2c%22sub%22%3a%5b1%5d", S: "%22%2c%22m%22%3a0%7d%2c%7b%22i%22%3a",
    T: "%2c%22blc%22%3a1%2c%22snd%22%3a1%2c%22ct%22%3a", U: "%2c%22blc%22%3a0%2c%22snd%22%3a1%2c%22ct%22%3a",
    V: "%2c%22blc%22%3a0%2c%22snd%22%3a0%2c%22ct%22%3a", W: "%2c%22s%22%3a0%2c%22blo%22%3a0%7d%2c%22bl%22%3a%7b%22ac%22%3a",
    X: "%2c%22ri%22%3a0%7d%2c%22state%22%3a%7b%22p%22%3a0%2c%22ut%22%3a1",
    Y: "%2c%22pt%22%3a0%2c%22vis%22%3a1%2c%22bls%22%3a0%2c%22blc%22%3a0%2c%22snd%22%3a1%2c%22ct%22%3a",
    Z: "%2c%22sb%22%3a1%2c%22t%22%3a%5b%5d%2c%22f%22%3anull%2c%22uct%22%3a0%2c%22s%22%3a0%2c%22blo%22%3a0%7d%2c%22bl%22%3a%7b%22ac%22%3a"
};

(function() {
    const l = [];
    for (const m in j) { i[j[m]] = m; l.push(j[m]); }
    l.reverse();
    h = new RegExp(l.join("|"), "g");
})();

function presenceEncode(str) {
    return encodeURIComponent(str)
        .replace(/([_A-Z])|%../g, (m, n) => n ? "%" + n.charCodeAt(0).toString(16) : m)
        .toLowerCase()
        .replace(h, (m) => i[m]);
}

function generatePresence(userID) {
    const now = Date.now();
    const ts = now + getRandomInt(-10000, 10000);
    const status = getRandomInt(0, 2);
    return "E" + presenceEncode(JSON.stringify({
        v: 3, time: Math.floor(ts / 1000), user: userID,
        state: { ut: status, t2: [], lm2: null, uct2: ts, tr: null, tw: getRandomInt(100, 2000), at: ts },
        ch: { ["p_" + userID]: 0 }
    }));
}

function generateAccessiblityCookie() {
    const time = Date.now();
    return encodeURIComponent(JSON.stringify({
        sr: 0, "sr-ts": time, jk: 0, "jk-ts": time,
        kb: 0, "kb-ts": time, hcm: 0, "hcm-ts": time
    }));
}

function getGUID() {
    let sectionLength = Date.now();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        const r = Math.floor((sectionLength + Math.random() * 16) % 16);
        sectionLength = Math.floor(sectionLength / 16);
        return (c == "x" ? r : (r & 7) | 8).toString(16);
    });
}

function getExtension(original_extension, fullFileName = "") {
    if (original_extension) return original_extension;
    const extension = fullFileName.split(".").pop();
    return extension === fullFileName ? "" : extension;
}

function _formatAttachment(attachment1, attachment2) {
    const fullFileName = attachment1.filename;
    const fileSize = Number(attachment1.fileSize || 0);
    const durationVideo = attachment1.genericMetadata ? Number(attachment1.genericMetadata.videoLength) : undefined;
    const durationAudio = attachment1.genericMetadata ? Number(attachment1.genericMetadata.duration) : undefined;
    const mimeType = attachment1.mimeType;

    attachment2 = attachment2 || { id: "", image_data: {} };
    attachment1 = attachment1.mercury || attachment1;
    let blob = attachment1.blob_attachment || attachment1.sticker_attachment;
    let type = blob && blob.__typename ? blob.__typename : attachment1.attach_type;

    if (!type && attachment1.sticker_attachment) {
        type = "StickerAttachment"; blob = attachment1.sticker_attachment;
    } else if (!type && attachment1.extensible_attachment) {
        if (attachment1.extensible_attachment.story_attachment &&
            attachment1.extensible_attachment.story_attachment.target &&
            attachment1.extensible_attachment.story_attachment.target.__typename === "MessageLocation") {
            type = "MessageLocation";
        } else type = "ExtensibleAttachment";
        blob = attachment1.extensible_attachment;
    }

    switch (type) {
        case "sticker":
            return { type: "sticker", ID: attachment1.metadata.stickerID.toString(), url: attachment1.url,
                packID: attachment1.metadata.packID.toString(), spriteUrl: attachment1.metadata.spriteURI,
                spriteUrl2x: attachment1.metadata.spriteURI2x, width: attachment1.metadata.width,
                height: attachment1.metadata.height, caption: attachment2.caption, description: attachment2.description,
                frameCount: attachment1.metadata.frameCount, frameRate: attachment1.metadata.frameRate,
                framesPerRow: attachment1.metadata.framesPerRow, framesPerCol: attachment1.metadata.framesPerCol,
                stickerID: attachment1.metadata.stickerID.toString(),
                spriteURI: attachment1.metadata.spriteURI, spriteURI2x: attachment1.metadata.spriteURI2x };
        case "file":
            return { type: "file", ID: attachment2.id.toString(), fullFileName, filename: attachment1.name,
                fileSize, original_extension: getExtension(attachment1.original_extension, fullFileName),
                mimeType, url: attachment1.url, isMalicious: attachment2.is_malicious,
                contentType: attachment2.mime_type, name: attachment1.name };
        case "photo":
            return { type: "photo", ID: attachment1.metadata.fbid.toString(), filename: attachment1.fileName,
                fullFileName, fileSize, original_extension: getExtension(attachment1.original_extension, fullFileName),
                mimeType, thumbnailUrl: attachment1.thumbnail_url, previewUrl: attachment1.preview_url,
                previewWidth: attachment1.preview_width, previewHeight: attachment1.preview_height,
                largePreviewUrl: attachment1.large_preview_url, largePreviewWidth: attachment1.large_preview_width,
                largePreviewHeight: attachment1.large_preview_height, url: attachment1.metadata.url,
                width: attachment1.metadata.dimensions.split(",")[0],
                height: attachment1.metadata.dimensions.split(",")[1], name: fullFileName };
        case "animated_image":
            return { type: "animated_image", ID: attachment2.id.toString(), filename: attachment2.filename,
                fullFileName, original_extension: getExtension(attachment2.original_extension, fullFileName),
                mimeType, previewUrl: attachment1.preview_url, previewWidth: attachment1.preview_width,
                previewHeight: attachment1.preview_height, url: attachment2.image_data.url,
                width: attachment2.image_data.width, height: attachment2.image_data.height,
                name: attachment1.name, facebookUrl: attachment1.url, thumbnailUrl: attachment1.thumbnail_url,
                rawGifImage: attachment2.image_data.raw_gif_image, rawWebpImage: attachment2.image_data.raw_webp_image,
                animatedGifUrl: attachment2.image_data.animated_gif_url,
                animatedGifPreviewUrl: attachment2.image_data.animated_gif_preview_url,
                animatedWebpUrl: attachment2.image_data.animated_webp_url,
                animatedWebpPreviewUrl: attachment2.image_data.animated_webp_preview_url };
        case "share":
            return { type: "share", ID: attachment1.share.share_id.toString(), url: attachment2.href,
                title: attachment1.share.title, description: attachment1.share.description,
                source: attachment1.share.source, image: attachment1.share.media.image,
                width: attachment1.share.media.image_size.width, height: attachment1.share.media.image_size.height,
                playable: attachment1.share.media.playable, duration: attachment1.share.media.duration,
                subattachments: attachment1.share.subattachments, properties: {},
                animatedImageSize: attachment1.share.media.animated_image_size,
                facebookUrl: attachment1.share.uri, target: attachment1.share.target,
                styleList: attachment1.share.style_list };
        case "video":
            return { type: "video", ID: attachment1.metadata.fbid.toString(), filename: attachment1.name,
                fullFileName, original_extension: getExtension(attachment1.original_extension, fullFileName),
                mimeType, duration: durationVideo, previewUrl: attachment1.preview_url,
                previewWidth: attachment1.preview_width, previewHeight: attachment1.preview_height,
                url: attachment1.url, width: attachment1.metadata.dimensions.width,
                height: attachment1.metadata.dimensions.height, videoType: "unknown",
                thumbnailUrl: attachment1.thumbnail_url };
        case "error":
            return { type: "error", attachment1, attachment2 };
        case "MessageImage":
            return { type: "photo", ID: blob.legacy_attachment_id, filename: blob.filename, fullFileName, fileSize,
                original_extension: getExtension(blob.original_extension, fullFileName), mimeType,
                thumbnailUrl: blob.thumbnail.uri, previewUrl: blob.preview.uri,
                previewWidth: blob.preview.width, previewHeight: blob.preview.height,
                largePreviewUrl: blob.large_preview.uri, largePreviewWidth: blob.large_preview.width,
                largePreviewHeight: blob.large_preview.height, url: blob.large_preview.uri,
                width: blob.original_dimensions.x, height: blob.original_dimensions.y, name: blob.filename };
        case "MessageAnimatedImage":
            return { type: "animated_image", ID: blob.legacy_attachment_id, filename: blob.filename, fullFileName,
                original_extension: getExtension(blob.original_extension, fullFileName), mimeType,
                previewUrl: blob.preview_image.uri, previewWidth: blob.preview_image.width,
                previewHeight: blob.preview_image.height, url: blob.animated_image.uri,
                width: blob.animated_image.width, height: blob.animated_image.height,
                thumbnailUrl: blob.preview_image.uri, name: blob.filename,
                facebookUrl: blob.animated_image.uri, rawGifImage: blob.animated_image.uri,
                animatedGifUrl: blob.animated_image.uri, animatedGifPreviewUrl: blob.preview_image.uri,
                animatedWebpUrl: blob.animated_image.uri, animatedWebpPreviewUrl: blob.preview_image.uri };
        case "MessageVideo":
            return { type: "video", ID: blob.legacy_attachment_id, filename: blob.filename, fullFileName,
                original_extension: getExtension(blob.original_extension, fullFileName), fileSize,
                duration: durationVideo, mimeType, previewUrl: blob.large_image.uri,
                previewWidth: blob.large_image.width, previewHeight: blob.large_image.height,
                url: blob.playable_url, width: blob.original_dimensions.x,
                height: blob.original_dimensions.y, videoType: blob.video_type.toLowerCase(),
                thumbnailUrl: blob.large_image.uri };
        case "MessageAudio":
            return { type: "audio", ID: blob.url_shimhash, filename: blob.filename, fullFileName, fileSize,
                duration: durationAudio, original_extension: getExtension(blob.original_extension, fullFileName),
                mimeType, audioType: blob.audio_type, url: blob.playable_url, isVoiceMail: blob.is_voicemail };
        case "StickerAttachment":
        case "Sticker":
            return { type: "sticker", ID: blob.id, url: blob.url,
                packID: blob.pack ? blob.pack.id : null, spriteUrl: blob.sprite_image,
                spriteUrl2x: blob.sprite_image_2x, width: blob.width, height: blob.height,
                caption: blob.label, description: blob.label, frameCount: blob.frame_count,
                frameRate: blob.frame_rate, framesPerRow: blob.frames_per_row,
                framesPerCol: blob.frames_per_column, stickerID: blob.id,
                spriteURI: blob.sprite_image, spriteURI2x: blob.sprite_image_2x };
        case "MessageLocation": {
            const urlAttach = blob.story_attachment.url;
            const mediaAttach = blob.story_attachment.media;
            const u = querystring.parse(url.parse(urlAttach).query).u;
            const where1 = querystring.parse(url.parse(u).query).where1;
            const address = where1.split(", ");
            let latitude, longitude;
            try { latitude = Number.parseFloat(address[0]); longitude = Number.parseFloat(address[1]); } catch (_) {}
            let imageUrl, width, height;
            if (mediaAttach && mediaAttach.image) {
                imageUrl = mediaAttach.image.uri;
                width = mediaAttach.image.width;
                height = mediaAttach.image.height;
            }
            return { type: "location", ID: blob.legacy_attachment_id, latitude, longitude,
                image: imageUrl, width, height, url: u || urlAttach, address: where1,
                facebookUrl: blob.story_attachment.url, target: blob.story_attachment.target,
                styleList: blob.story_attachment.style_list };
        }
        case "ExtensibleAttachment":
            return { type: "share", ID: blob.legacy_attachment_id, url: blob.story_attachment.url,
                title: blob.story_attachment.title_with_entities.text,
                description: blob.story_attachment.description && blob.story_attachment.description.text,
                source: blob.story_attachment.source ? blob.story_attachment.source.text : null,
                image: blob.story_attachment.media && blob.story_attachment.media.image && blob.story_attachment.media.image.uri,
                width: blob.story_attachment.media && blob.story_attachment.media.image && blob.story_attachment.media.image.width,
                height: blob.story_attachment.media && blob.story_attachment.media.image && blob.story_attachment.media.image.height,
                playable: blob.story_attachment.media && blob.story_attachment.media.is_playable,
                duration: blob.story_attachment.media && blob.story_attachment.media.playable_duration_in_ms,
                playableUrl: blob.story_attachment.media == null ? null : blob.story_attachment.media.playable_url,
                subattachments: blob.story_attachment.subattachments,
                properties: blob.story_attachment.properties.reduce((obj, cur) => (obj[cur.key] = cur.value.text, obj), {}),
                facebookUrl: blob.story_attachment.url, target: blob.story_attachment.target,
                styleList: blob.story_attachment.style_list };
        case "MessageFile":
            return { type: "file", ID: blob.message_file_fbid, fullFileName, filename: blob.filename, fileSize,
                mimeType: blob.mimetype, original_extension: blob.original_extension || fullFileName.split(".").pop(),
                url: blob.url, isMalicious: blob.is_malicious, contentType: blob.content_type, name: blob.filename };
        default:
            throw new Error("unrecognized attach_file of type " + type + "`" +
                JSON.stringify(attachment1, null, 4) + " attachment2: " +
                JSON.stringify(attachment2, null, 4) + "`");
    }
}

function formatAttachment(attachments, attachmentIds, attachmentMap, shareMap) {
    attachmentMap = shareMap || attachmentMap;
    return attachments ? attachments.map((val, i) => {
        if (!attachmentMap || !attachmentIds || !attachmentMap[attachmentIds[i]])
            return _formatAttachment(val);
        return _formatAttachment(val, attachmentMap[attachmentIds[i]]);
    }) : [];
}

function getMentionsFromDeltaMessage(delta) {
    const body = delta.body || "";
    const mentions = {};
    let mdata = [];
    if (delta.data && delta.data.prng) {
        try { mdata = JSON.parse(delta.data.prng); } catch (e) { mdata = []; }
    }
    if (mdata.length > 0) {
        for (let i = 0; i < mdata.length; i++) {
            mentions[String(mdata[i].i)] = body.substring(
                parseInt(mdata[i].o, 10) || 0,
                (parseInt(mdata[i].o, 10) || 0) + (parseInt(mdata[i].l, 10) || 0)
            );
        }
        return mentions;
    }
    const md = delta.messageMetadata;
    if (md && md.data && md.data.data && md.data.data.Gb && md.data.data.Gb.asMap && md.data.data.Gb.asMap.data) {
        const gbData = md.data.data.Gb.asMap.data;
        for (const key in gbData) {
            if (!Object.prototype.hasOwnProperty.call(gbData, key)) continue;
            const entry = gbData[key];
            if (entry && entry.asMap && entry.asMap.data) {
                const d = entry.asMap.data;
                const uid = d.id && d.id.asLong ? String(d.id.asLong) : null;
                const offset = parseInt(d.offset && d.offset.asLong ? d.offset.asLong : 0, 10);
                const len = parseInt(d.length && d.length.asLong ? d.length.asLong : 0, 10);
                if (uid != null) mentions[uid] = body.substring(offset, offset + len);
            }
        }
    }
    return mentions;
}

function formatDeltaMessage(m) {
    const md = m.delta.messageMetadata;
    return {
        type: "message", senderID: formatID(md.actorFbId.toString()),
        body: m.delta.body || "",
        threadID: formatID((md.threadKey.threadFbId || md.threadKey.otherUserFbId).toString()),
        messageID: md.messageId,
        attachments: (m.delta.attachments || []).map(v => _formatAttachment(v)),
        mentions: getMentionsFromDeltaMessage(m.delta),
        timestamp: md.timestamp,
        isGroup: !!md.threadKey.threadFbId,
        participantIDs: m.delta.participants
    };
}

function formatID(id) {
    if (id != undefined && id != null) return id.replace(/(fb)?id[:.]/, "");
    return id;
}

function formatMessage(m) {
    const originalMessage = m.message ? m.message : m;
    const obj = {
        type: "message", senderName: originalMessage.sender_name,
        senderID: formatID(originalMessage.sender_fbid.toString()),
        participantNames: originalMessage.group_thread_info ?
            originalMessage.group_thread_info.participant_names : [originalMessage.sender_name.split(" ")[0]],
        participantIDs: originalMessage.group_thread_info ?
            originalMessage.group_thread_info.participant_ids.map(v => formatID(v.toString())) :
            [formatID(originalMessage.sender_fbid)],
        body: originalMessage.body || "",
        threadID: formatID((originalMessage.thread_fbid || originalMessage.other_user_fbid).toString()),
        threadName: originalMessage.group_thread_info ?
            originalMessage.group_thread_info.name : originalMessage.sender_name,
        location: originalMessage.coordinates ? originalMessage.coordinates : null,
        messageID: originalMessage.mid ? originalMessage.mid.toString() : originalMessage.message_id,
        attachments: formatAttachment(originalMessage.attachments, originalMessage.attachmentIds,
            originalMessage.attachment_map, originalMessage.share_map),
        timestamp: originalMessage.timestamp,
        timestampAbsolute: originalMessage.timestamp_absolute,
        timestampRelative: originalMessage.timestamp_relative,
        timestampDatetime: originalMessage.timestamp_datetime,
        tags: originalMessage.tags,
        reactions: originalMessage.reactions ? originalMessage.reactions : [],
        isUnread: originalMessage.is_unread
    };
    if (m.type === "pages_messaging") obj.pageID = m.realtime_viewer_fbid.toString();
    obj.isGroup = obj.participantIDs.length > 2;
    return obj;
}

function formatEvent(m) {
    const originalMessage = m.message ? m.message : m;
    let logMessageType = originalMessage.log_message_type;
    let logMessageData;
    if (logMessageType === "log:generic-admin-text") {
        logMessageData = originalMessage.log_message_data.untypedData;
        logMessageType = getAdminTextMessageType(originalMessage.log_message_data.message_type);
    } else logMessageData = originalMessage.log_message_data;
    return Object.assign(formatMessage(originalMessage), {
        type: "event", logMessageType, logMessageData,
        logMessageBody: originalMessage.log_message_body
    });
}

function formatHistoryMessage(m) {
    if (m.action_type === "ma-type:log-message") return formatEvent(m);
    return formatMessage(m);
}

function getAdminTextMessageType(type) {
    switch (type) {
        case 'unpin_messages_v2': return 'log:unpin-message';
        case 'pin_messages_v2': return 'log:pin-message';
        case "change_thread_theme": return "log:thread-color";
        case "change_thread_icon":
        case 'change_thread_quick_reaction': return "log:thread-icon";
        case "change_thread_nickname": return "log:user-nickname";
        case "change_thread_admins": return "log:thread-admins";
        case "group_poll": return "log:thread-poll";
        case "change_thread_approval_mode": return "log:thread-approval-mode";
        case "messenger_call_log":
        case "participant_joined_group_call": return "log:thread-call";
        default: return type;
    }
}

function formatDeltaEvent(m) {
    let logMessageType, logMessageData;
    switch (m.class) {
        case "AdminTextMessage":
            logMessageData = m.untypedData;
            logMessageType = getAdminTextMessageType(m.type); break;
        case "ThreadName":
            logMessageType = "log:thread-name"; logMessageData = { name: m.name }; break;
        case "ParticipantsAddedToGroupThread":
            logMessageType = "log:subscribe"; logMessageData = { addedParticipants: m.addedParticipants }; break;
        case "ParticipantLeftGroupThread":
            logMessageType = "log:unsubscribe"; logMessageData = { leftParticipantFbId: m.leftParticipantFbId }; break;
        case "ApprovalQueue":
            logMessageType = "log:approval-queue";
            logMessageData = { approvalQueue: { action: m.action, recipientFbId: m.recipientFbId, requestSource: m.requestSource, ...m.messageMetadata } };
    }
    return {
        type: "event",
        threadID: formatID((m.messageMetadata.threadKey.threadFbId || m.messageMetadata.threadKey.otherUserFbId).toString()),
        messageID: m.messageMetadata.messageId.toString(),
        logMessageType, logMessageData, logMessageBody: m.messageMetadata.adminText,
        timestamp: m.messageMetadata.timestamp, author: m.messageMetadata.actorFbId,
        participantIDs: m.participants
    };
}

function formatTyp(event) {
    return {
        isTyping: !!event.st, from: event.from.toString(),
        threadID: formatID((event.to || event.thread_fbid || event.from).toString()),
        fromMobile: event.hasOwnProperty("from_mobile") ? event.from_mobile : true,
        userID: (event.realtime_viewer_fbid || event.from).toString(), type: "typ"
    };
}

function formatDeltaReadReceipt(delta) {
    return { reader: (delta.threadKey.otherUserFbId || delta.actorFbId).toString(),
        time: delta.actionTimestampMs,
        threadID: formatID((delta.threadKey.otherUserFbId || delta.threadKey.threadFbId).toString()),
        type: "read_receipt" };
}

function formatReadReceipt(event) {
    return { reader: event.reader.toString(), time: event.time,
        threadID: formatID((event.thread_fbid || event.reader).toString()), type: "read_receipt" };
}

function formatRead(event) {
    return { threadID: formatID(((event.chat_ids && event.chat_ids[0]) || (event.thread_fbids && event.thread_fbids[0])).toString()),
        time: event.timestamp, type: "read" };
}

function getFrom(str, startToken, endToken) {
    const start = str.indexOf(startToken) + startToken.length;
    if (start < startToken.length) return "";
    const lastHalf = str.substring(start);
    const end = lastHalf.indexOf(endToken);
    if (end === -1) throw Error("Could not find endTime `" + endToken + "` in the given string.");
    return lastHalf.substring(0, end);
}

function makeParsable(html) {
    const withoutForLoop = html.replace(/for\s*\(\s*;\s*;\s*\)\s*;\s*/, "");
    const trimmed = withoutForLoop.trim();
    // Facebook sometimes prefixes the payload with junk (e.g. "while(1);").
    const cleaned = trimmed
        .replace(/^while\s*\(\s*1\s*\)\s*;?/, "")
        .replace(/^for\s*\(\s*;\s*;\s*\)\s*;?/, "")
        .trim();
    if (!cleaned.includes("}{") && !/\}\r?\n *\{/.test(cleaned)) {
        return cleaned;
    }
    const maybeMultipleObjects = cleaned.split(/\}\r?\n *\{/);
    if (maybeMultipleObjects.length === 1) {
        return maybeMultipleObjects[0];
    }
    return "[" + maybeMultipleObjects.join("},{") + "]";
}

function decodeHtmlEntities(value) {
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function extractEmbeddedJson(html) {
    const result = [];
    const scriptPattern = /<script\b[^>]*(?:type=["']application\/(?:json|ld\+json)["']|data-sjs=["'])[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptPattern.exec(html))) {
        const content = decodeHtmlEntities(match[1]).trim().replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, "");
        if (!content) continue;
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) result.push(...parsed);
            else result.push(parsed);
        }
        catch (_) {}
    }
    return result;
}

async function json(url, jar, qs, options, ctx) {
    const response = await get(url, jar, qs, options, ctx);
    const body = response?.body ?? response;
    if (typeof body !== "string") return body;
    try {
        const parsed = JSON.parse(makeParsable(body));
        return Array.isArray(parsed) ? parsed : [parsed];
    }
    catch (error) {
        const embedded = extractEmbeddedJson(body);
        if (embedded.length) return embedded;

        const match = String(url).match(/^https?:\/\/(?:www\.)?facebook\.com\/(\d+)\/?$/i);
        if (match) {
            return [{
                id: match[1],
                __typename: "User",
                profile_tabs: [],
                name: null,
                url: String(url)
            }];
        }
        throw error;
    }
}

function arrToForm(form) {
    return arrayToObject(form, v => v.name, v => v.val);
}

function arrayToObject(arr, getKey, getValue) {
    return arr.reduce((acc, val) => (acc[getKey(val)] = getValue(val), acc), {});
}

function getSignatureID() {
    return Math.floor(Math.random() * 2147483648).toString(16);
}

function generateTimestampRelative() {
    const d = new Date();
    return d.getHours() + ":" + padZeros(d.getMinutes());
}

function makeDefaults(html, userID, ctx) {
    let reqCounter = 1;
    const revision = getFrom(html, 'revision":', ",");
    function mergeWithDefaults(obj) {
        const newObj = {
            av: userID, __user: userID, __req: (reqCounter++).toString(36),
            __rev: revision, __a: 1,
            ...(ctx && { fb_dtsg: ctx.fb_dtsg, jazoest: ctx.jazoest })
        };
        if (!obj) return newObj;
        for (const prop in obj)
            if (obj.hasOwnProperty(prop) && !newObj[prop]) newObj[prop] = obj[prop];
        return newObj;
    }
    return {
        get: (url, jar, qs, ctxx, customHeader = {}) => get(url, jar, mergeWithDefaults(qs), ctx.globalOptions, ctxx || ctx, customHeader),
        post: (url, jar, form, ctxx, customHeader = {}) => post(url, jar, mergeWithDefaults(form), ctx.globalOptions, ctxx || ctx, customHeader),
        postFormData: (url, jar, form, qs, ctxx) => postFormData(url, jar, mergeWithDefaults(form), mergeWithDefaults(qs), ctx.globalOptions, ctxx || ctx)
    };
}

function parseAndCheckLogin(ctx, http, retryCount) {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const _try = (tryData) => new Promise((resolve, reject) => {
        try { resolve(tryData()); } catch (error) { reject(error); }
    });

    if (retryCount == undefined) retryCount = 0;
    const MAX_RETRIES = 3;

    return function(data) {
        function any() {
            if (data.statusCode >= 500 && data.statusCode < 600) {
                if (retryCount >= MAX_RETRIES) {
                    const err = new Error("Request retry failed. Check the `res` and `statusCode` property on this error.");
                    err.statusCode = data.statusCode; err.res = data.body;
                    err.error = "Request retry failed. Check the `res` and `statusCode` property on this error.";
                    throw err;
                }
                retryCount++;
                const baseDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                const retryTime = baseDelay + getRandomInt(0, 1000);
                console.warn("parseAndCheckLogin", "Got status code " + data.statusCode + " - " + retryCount + ". attempt to retry in " + retryTime + " milliseconds...");
                const url = data.request.uri.protocol + "//" + data.request.uri.hostname + data.request.uri.pathname;
                if (data.request.headers["content-type"].split(";")[0] === "multipart/form-data") {
                    return delay(retryTime).then(() => http.postFormData(url, ctx.jar, data.request.formData)).then(parseAndCheckLogin(ctx, http, retryCount));
                }
                return delay(retryTime).then(() => http.post(url, ctx.jar, data.request.formData)).then(parseAndCheckLogin(ctx, http, retryCount));
            }
            if (data.statusCode === 404) return;
            if (data.statusCode === 401 || data.statusCode === 403) {
                const err = new Error("Session expired or invalid");
                err.statusCode = data.statusCode; err.error = "Not logged in.";
                throw err;
            }
            if (data.statusCode !== 200)
                throw new Error("parseAndCheckLogin got status code: " + data.statusCode + ". Bailing out of trying to parse response.");

            let res = null;
            try { res = JSON.parse(makeParsable(data.body)); }
            catch (e) {
                const err = new Error("JSON.parse error. Check the `detail` property on this error.");
                err.error = "JSON.parse error. Check the `detail` property on this error.";
                err.detail = e; err.res = data.body; throw err;
            }

            if (res.redirect && data.request.method === "GET")
                return http.get(res.redirect, ctx.jar).then(parseAndCheckLogin(ctx, http));

            if (res.jsmods && res.jsmods.require && Array.isArray(res.jsmods.require[0]) && res.jsmods.require[0][0] === "Cookie") {
                res.jsmods.require[0][3][0] = res.jsmods.require[0][3][0].replace("_js_", "");
                const requireCookie = res.jsmods.require[0][3];
                ctx.jar.setCookie(formatCookie(requireCookie, "facebook"), "https://www.facebook.com");
                ctx.jar.setCookie(formatCookie(requireCookie, "messenger"), "https://www.messenger.com");
            }
            if (res.jsmods && Array.isArray(res.jsmods.require)) {
                for (const i in res.jsmods.require) {
                    if (res.jsmods.require[i][0] === "DTSG" && res.jsmods.require[i][1] === "setToken") {
                        ctx.fb_dtsg = res.jsmods.require[i][3][0];
                        ctx.ttstamp = "2";
                        for (let j = 0; j < ctx.fb_dtsg.length; j++) ctx.ttstamp += ctx.fb_dtsg.charCodeAt(j);
                    }
                }
            }
            if (res.error === 1357001) {
                const err = new Error('Facebook blocked the login');
                err.error = "Not logged in."; throw err;
            }
            return res;
        }
        return _try(any);
    };
}

function extendCookieExpiry(cookieStr) {
    const thirtyDays = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toUTCString();
    if (/expires=/i.test(cookieStr)) return cookieStr.replace(/expires=[^;]+/i, "expires=" + thirtyDays);
    if (/max-age=/i.test(cookieStr)) return cookieStr.replace(/max-age=\d+/i, "max-age=2592000");
    return cookieStr + "; expires=" + thirtyDays;
}

function saveCookies(jar) {
    return function(res) {
        const cookies = res.headers["set-cookie"] || [];
        cookies.forEach(function(c) {
            const extended = extendCookieExpiry(c);
            if (extended.indexOf(".facebook.com") > -1)
                jar.setCookie(extended, "https://www.facebook.com");
            const c2 = extended.replace(/domain=\.facebook\.com/, "domain=.messenger.com");
            jar.setCookie(c2, "https://www.messenger.com");
        });
        return res;
    };
}

const NUM_TO_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NUM_TO_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDate(date) {
    let d = date.getUTCDate(); d = d >= 10 ? d : "0" + d;
    let h = date.getUTCHours(); h = h >= 10 ? h : "0" + h;
    let m = date.getUTCMinutes(); m = m >= 10 ? m : "0" + m;
    let s = date.getUTCSeconds(); s = s >= 10 ? s : "0" + s;
    return NUM_TO_DAY[date.getUTCDay()] + ", " + d + " " + NUM_TO_MONTH[date.getUTCMonth()] + " " +
        date.getUTCFullYear() + " " + h + ":" + m + ":" + s + " GMT";
}

function formatCookie(arr, url) {
    return arr[0] + "=" + arr[1] + "; Path=" + arr[3] + "; Domain=" + url + ".com";
}

function formatThread(data) {
    return {
        threadID: formatID(data.thread_fbid.toString()),
        participants: data.participants.map(formatID),
        participantIDs: data.participants.map(formatID),
        name: data.name, nicknames: data.custom_nickname, snippet: data.snippet,
        snippetAttachments: data.snippet_attachments,
        snippetSender: formatID((data.snippet_sender || "").toString()),
        unreadCount: data.unread_count, messageCount: data.message_count,
        imageSrc: data.image_src, timestamp: data.timestamp,
        serverTimestamp: data.server_timestamp, muteUntil: data.mute_until,
        isCanonicalUser: data.is_canonical_user, isCanonical: data.is_canonical,
        isSubscribed: data.is_subscribed, folder: data.folder,
        isArchived: data.is_archived, recipientsLoadable: data.recipients_loadable,
        hasEmailParticipant: data.has_email_participant, readOnly: data.read_only,
        canReply: data.can_reply, cannotReplyReason: data.cannot_reply_reason,
        lastMessageTimestamp: data.last_message_timestamp,
        lastReadTimestamp: data.last_read_timestamp,
        lastMessageType: data.last_message_type,
        emoji: data.custom_like_icon, color: data.custom_color,
        adminIDs: data.admin_ids, threadType: data.thread_type
    };
}

function getType(obj) {
    return Object.prototype.toString.call(obj).slice(8, -1);
}

function formatProxyPresence(presence, userID) {
    if (presence.lat === undefined || presence.p === undefined) return null;
    return { type: "presence", timestamp: presence.lat * 1000, userID, statuses: presence.p };
}

function formatPresence(presence, userID) {
    return { type: "presence", timestamp: presence.la * 1000, userID, statuses: presence.a };
}

function decodeClientPayload(payload) {
    return JSON.parse(String.fromCharCode.apply(null, payload));
}

function getAppState(jar) {
    return jar.getCookies("https://www.facebook.com").concat(jar.getCookies("https://www.messenger.com"));
}

function getAccessFromBusiness(jar, Options) {
    return function(res) {
        const html = res ? res.body : null;
        return get('https://business.facebook.com/content_management', jar, null, Options, null, { noRef: true })
            .then((res) => {
                const token = /"accessToken":"([^.]+)","clientID":/g.exec(res.body)[1];
                return [html, token];
            })
            .catch(() => [html, null]);
    };
}

async function logout(jar, ctx, callback) {
    try {
        const key = (ctx && ctx.userID) || DEFAULT_USER_KEY;
        await waitForLogoutCooldown(key);
        await sleep(getRandomInt(700, 2500));
        await clearAllCookies(jar);

        if (ctx) {
            ctx.fb_dtsg = null;
            ctx.ttstamp = null;
            ctx.jazoest = null;
            ctx.userID = null;
            ctx.loggedIn = false;
            ctx.messengerLoggedIn = false;
            ctx.messengerUserID = null;
            if ("globalOptions" in ctx) ctx.globalOptions = null;
            if ("http" in ctx) ctx.http = null;
        }

        const result = {
            success: true,
            message: "Logged out successfully from Facebook + Messenger (local session cleared)",
            domainsCleared: ["facebook.com", "m.facebook.com", "web.facebook.com", "business.facebook.com", "messenger.com"]
        };
        if (callback) callback(null, result);
        return result;
    } catch (err) {
        const error = { error: "Logout failed", detail: err.message };
        if (callback) callback(error, null);
        throw new Error("Logout failed: " + err.message);
    }
}

async function clearSession(jar, ctx) {
    await clearAllCookies(jar);
    if (ctx) {
        ctx.fb_dtsg = null; ctx.ttstamp = null; ctx.jazoest = null;
        ctx.userID = null; ctx.loggedIn = false;
        ctx.messengerLoggedIn = false; ctx.messengerUserID = null;
    }
    return { success: true, message: "Session cleared for both Facebook and Messenger" };
}

const KEEPALIVE_INTERVAL_MIN = 120000;
const KEEPALIVE_INTERVAL_MAX = 300000;
let keepAliveRunning = false;

async function keepAlive(ctx, jar) {
    keepAliveRunning = true;
    while (keepAliveRunning) {
        try {
            await sleep(getRandomInt(KEEPALIVE_INTERVAL_MIN, KEEPALIVE_INTERVAL_MAX));
            if (!keepAliveRunning) break;
            if (!ctx || !ctx.userID) break;
            const form = {
                presence: generatePresence(ctx.userID),
                __user: ctx.userID, __a: 1, fb_dtsg: ctx.fb_dtsg
            };
            if (ctx.http)
                await ctx.http.post('https://www.facebook.com/ajax/mercury/update_presence.php', jar, form);
            else
                await post('https://www.facebook.com/ajax/mercury/update_presence.php', jar, form);
        } catch (e) {
            console.warn('Keep-alive failed:', e.message);
            break;
        }
    }
    keepAliveRunning = false;
}

function stopKeepAlive() { keepAliveRunning = false; }

let loginFunction = null;
function setLoginFunction(fn) { loginFunction = fn; }

const sessionRecoveryState = new Map();

/**
 * Self-healing wrapper for API calls.
 *
 * On an expired/invalid session it refreshes the tokens and retries the call
 * once instead of letting the bot die. A hard block ("Facebook blocked the
 * login", checkpoint, suspension) is never retried: retrying those is what
 * escalates a warning into a permanent lock.
 */
async function withSessionRecovery(apiCall, ...args) {
    const signal = antiSuspension.classifySessionSignal;
    const ctx = (apiCall && apiCall.ctx) || null;
    const key = (ctx && ctx.userID) || "global";

    const attempt = async () => apiCall(...args);

    try {
        return await attempt();
    } catch (err) {
        const info = signal ? signal(err) : { kind: "unknown", action: "ignore" };

        if (info.kind === "blocked" || info.kind === "checkpoint") {
            // Do NOT retry — stop cleanly and surface the reason.
            throw err;
        }

        const isExpired =
            info.kind === "expired" ||
            err.statusCode === 401 ||
            err.statusCode === 403 ||
            err.error === "Not logged in.";

        if (!isExpired) throw err;

        const state = sessionRecoveryState.get(key) || { count: 0, lastAt: 0 };
        const now = Date.now();
        // At most one recovery per 5 minutes, so we never hammer the endpoint.
        if (now - state.lastAt < 5 * 60 * 1000 || state.count >= 3) throw err;

        sessionRecoveryState.set(key, { count: state.count + 1, lastAt: now });

        if (!loginFunction) throw err;

        console.warn("Session expired – re-logging in...");
        await loginFunction();
        throw new Error("Re-login triggered, but you need to update your global ctx and jar and retry.");
    }
}

function resetSessionRecovery(userID) {
    if (userID == null) sessionRecoveryState.clear();
    else sessionRecoveryState.delete(String(userID));
}

class SessionManager {
    constructor(loginFn, options = {}) {
        if (typeof loginFn !== "function") throw new TypeError("SessionManager: loginFn must be a function");
        this.loginFn = loginFn;
        this.options = options;
        this.ctx = null;
        this.jar = null;
        this.api = null;
        this.userID = null;
        this._loggingIn = null;
        this._keepAliveTask = null;
        this._listeners = new Set();
        this._destroyed = false;
        this._recovering = false;
        this._startedAt = Date.now();
    }

    async ensureSession() {
        if (this._destroyed) throw new Error("SessionManager destroyed");

        if (this.ctx && this.ctx.userID && this.ctx.loggedIn !== false) {
            return { ctx: this.ctx, jar: this.jar, api: this.api };
        }
        if (this._loggingIn) return this._loggingIn;

        this._loggingIn = (async () => {
            try {
                const result = await this.loginFn(this.options);
                this.ctx = result.ctx || result;
                this.jar = result.jar || this.ctx.jar;
                this.api = result.api || result;

                this.ctx.loggedIn = true;
                this.ctx.messengerLoggedIn = true;
                this.userID = this.ctx.userID;

                return { ctx: this.ctx, jar: this.jar, api: this.api };
            } finally {
                this._loggingIn = null;
            }
        })();

        return this._loggingIn;
    }

    async recover() {
        if (this._recovering) {
            while (this._recovering) await sleep(200);
            return { ctx: this.ctx, jar: this.jar, api: this.api };
        }
        this._recovering = true;
        try {
            try {
                if (this.ctx) {
                    this.ctx.fb_dtsg = null;
                    this.ctx.ttstamp = null;
                    this.ctx.jazoest = null;
                    this.ctx.userID = null;
                    this.ctx.loggedIn = false;
                    this.ctx.messengerLoggedIn = false;
                }
            } catch (_) {}
            await sleep(getRandomInt(2000, 5000));
            return await this.ensureSession();
        } finally {
            this._recovering = false;
        }
    }

    async call(fn, ...args) {
        await this.ensureSession();
        try {
            return await fn.call(this.api, this.ctx, this.jar, ...args);
        } catch (err) {
            const expired = err && (
                err.statusCode === 401 ||
                err.statusCode === 403 ||
                err.error === "Not logged in." ||
                /session expired/i.test(err.message || "")
            );
            if (!expired) throw err;

            console.warn("[SessionManager] Session expired — recovering...");
            await this.recover();
            return await fn.call(this.api, this.ctx, this.jar, ...args);
        }
    }

    startKeepAlive() {
        if (this._keepAliveTask) return;
        this._keepAliveTask = (async () => {
            while (!this._destroyed) {
                try {
                    await sleep(getRandomInt(KEEPALIVE_INTERVAL_MIN, KEEPALIVE_INTERVAL_MAX));
                    if (this._destroyed) break;
                    if (!this.ctx || !this.ctx.userID) {
                        await this.ensureSession();
                        continue;
                    }
                    const form = {
                        presence: generatePresence(this.ctx.userID),
                        __user: this.ctx.userID,
                        __a: 1,
                        fb_dtsg: this.ctx.fb_dtsg
                    };
                    await post("https://www.facebook.com/ajax/mercury/update_presence.php", this.jar, form);
                } catch (e) {
                    console.warn("[SessionManager] keepAlive error:", e.message);
                    await sleep(5000);
                }
            }
        })();
    }

    onMessage(handler) {
        this._listeners.add(handler);
        return () => this._listeners.delete(handler);
    }

    async dispatch(event) {
        for (const h of Array.from(this._listeners)) {
            try {
                await h(event, {
                    reply: (text, opts = {}) =>
                        this.call(function (ctx, jar, text, opts) {
                            return this.sendMessage(text, event.threadID, null, opts);
                        }, text, opts),
                    send: (threadID, text, opts = {}) =>
                        this.call(function (ctx, jar, threadID, text, opts) {
                            return this.sendMessage(text, threadID, null, opts);
                        }, threadID, text, opts)
                });
            } catch (e) {
                console.error("[SessionManager] listener error:", e.message);
            }
        }
    }

    async stop() {
        this._destroyed = true;
        this._listeners.clear();
        stopKeepAlive();
        if (this.ctx && this.jar) {
            try { await clearSession(this.jar, this.ctx); } catch (_) {}
        }
    }

    get status() {
        return {
            userID: this.userID,
            loggedIn: !!(this.ctx && this.ctx.loggedIn),
            uptime: Date.now() - this._startedAt,
            listeners: this._listeners.size,
            keepAlive: !!this._keepAliveTask
        };
    }
}

const meta = prop => new RegExp(`<meta property="${prop}" content="([^"]*)"`);

module.exports = {
    log(...args) {
        if (verboseLogging) console.log(ws, chalk.green.bold("[LOG]"), ...args);
    },
    error(...args) { console.error(ws, chalk.red.bold("[ERROR]"), ...args); },
    warn(...args) { console.warn(ws, chalk.yellow.bold("[WARNING]"), ...args); },
    isReadableStream, cleanGet, get, json, post, postFormData,
    generateThreadingID, generateOfflineThreadingID, getGUID, getFrom,
    makeParsable, arrToForm, getSignatureID, getJar, generateTimestampRelative,
    makeDefaults, parseAndCheckLogin, saveCookies, getType, _formatAttachment,
    formatHistoryMessage, formatID, formatMessage, formatDeltaEvent, formatDeltaMessage,
    formatProxyPresence, formatPresence, formatTyp, formatDeltaReadReceipt,
    formatCookie, formatThread, formatReadReceipt, formatRead,
    generatePresence, generateAccessiblityCookie, formatDate, decodeClientPayload,
    getAppState, getAdminTextMessageType, setProxy, getAccessFromBusiness,
    presenceEncode,
    headers: baseHeaders,
    defaultUserAgent: randomUserAgent(),
    windowsUserAgent: modernUserAgents[1],
    randomUserAgent, meta, getMentionsFromDeltaMessage,
    logout, clearSession, throttleRequest, sleep, getRandomInt,
    keepAlive, stopKeepAlive, setLoginFunction, withSessionRecovery, resetSessionRecovery,
    clearAllCookies, expireEveryCookie, waitForLogoutCooldown,
    withTimeout, safeJsonParse, normalizeThreadID, isTransientError,
    redactError, getRuntimeSnapshot, extractUploadMetadata, resolveAttachmentTarget,
    getAttachmentContentType, getAttachmentStream, prepareAttachment, antiSuspension,
    getHeaders,
    FB_DOMAINS, LOGOUT_COOLDOWN_MS, LOGOUT_GLOBAL_COOLDOWN_MS,
    SessionManager
};
