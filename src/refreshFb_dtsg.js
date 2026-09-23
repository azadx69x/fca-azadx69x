// fixed by @Azadx69x
"use strict";
const log = require("npmlog");
const utils = require("../utils");

class CustomError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'REFRESH_ERROR';
    this.name = 'CustomError';
  }
}

module.exports = function (defaultFuncs, api, ctx) {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 15; SM-S918B Build/AP3A.240905.015.A2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/566.0.0.48.73;IABMV/1;]',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Sec-CH-UA': '"Chromium";v="151", "Google Chrome";v="151", "Not-A.Brand";v="24"',
    'Sec-CH-UA-Mobile': '?1',
    'Sec-CH-UA-Platform': '"Android"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive'
  };

  function extractDtsg(html) {
    const patterns = [
      /"DTSGInitialData",\[],\{"token":"([^"]+)"/,
      /"dtsg":{"token":"([^"]+)"/,
      /name="fb_dtsg" value="([^"]+)"/,
      /"fb_dtsg":"([^"]+)"/,
      /DTSGInitialData\.token\s*=\s*"([^"]+)"/,
      /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  function generateJazoest(fbDtsg) {
    if (!fbDtsg) return "";
    let sum = 0;
    for (let i = 0; i < fbDtsg.length; i++) sum += fbDtsg.charCodeAt(i);
    return "2" + sum;
  }

  async function fetchFreshDtsg() {
    const urls = [
      { link: "https://www.facebook.com/home.php", src: 'homepage' },
      { link: "https://www.facebook.com/settings", src: 'settings' },
      { link: "https://www.facebook.com/messages/t", src: 'messenger' }
    ];

    for (const item of urls) {
      try {
        const res = await defaultFuncs.get(item.link, ctx.jar, null, { headers: HEADERS });
        const dtsg = extractDtsg(res.body || res);
        if (dtsg) {
          log.verbose("refreshFb_dtsg", `Found fb_dtsg from ${item.src}`);
          return { fb_dtsg: dtsg, source: item.src };
        }
      } catch (err) {
        log.verbose("refreshFb_dtsg", `Failed to fetch from ${item.src}`);
      }
    }
    throw new Error('Could not extract fb_dtsg from any page. Session might be expired.');
  }

  return function refreshFb_dtsg(obj, callback) {
    if (typeof obj === "function") { callback = obj; obj = {}; }
    if (!obj) obj = {};

    if (typeof obj !== "object" || Array.isArray(obj)) {
      const err = new CustomError("The first parameter must be an object or a callback function", 'INVALID_PARAM');
      if (callback) callback(err);
      throw err;
    }

    let resolveFunc, rejectFunc;
    const returnPromise = new Promise((resolve, reject) => { resolveFunc = resolve; rejectFunc = reject; });
    if (!callback) callback = (err, data) => err ? rejectFunc(err) : resolveFunc(data);

    let called = false;
    const safeCallback = (err, data) => {
      if (called) return;
      called = true;
      callback(err, data);
    };

    (async () => {
      try {
        if (Object.keys(obj).length > 0 && obj.fb_dtsg) {
          log.info("refreshFb_dtsg", "Using manually provided fb_dtsg");
          const oldDtsg = ctx.fb_dtsg;
          Object.assign(ctx, obj);
          if (ctx.fb_dtsg && ctx.fb_dtsg !== oldDtsg) ctx.jazoest = generateJazoest(ctx.fb_dtsg);
          return safeCallback(null, { success: true, refreshed: Object.keys(obj), fb_dtsg_preview: ctx.fb_dtsg ? ctx.fb_dtsg.substring(0, 10) + '...' : null, source: 'manual', timestamp: new Date().toISOString() });
        }

        log.info("refreshFb_dtsg", "Auto-fetching fresh fb_dtsg...");
        const freshData = await fetchFreshDtsg();
        if (!freshData.fb_dtsg) throw new CustomError("Failed to extract fb_dtsg from Facebook pages", 'EXTRACTION_FAILED');

        const oldDtsg = ctx.fb_dtsg;
        const newDtsg = freshData.fb_dtsg;
        ctx.fb_dtsg = newDtsg;
        ctx.jazoest = generateJazoest(newDtsg);
        ctx.fb_dtsg_g = generateJazoest(newDtsg);

        if (ctx.globalOptions) {
          ctx.globalOptions.fb_dtsg = newDtsg;
          ctx.globalOptions.jazoest = ctx.jazoest;
        }

        const changed = oldDtsg !== newDtsg;
        log.info("refreshFb_dtsg", `Token refreshed successfully (changed: ${changed}, source: ${freshData.source})`);
        
        safeCallback(null, {
          success: true,
          refreshed: ['fb_dtsg', 'jazoest'],
          changed: changed,
          source: freshData.source,
          timestamp: new Date().toISOString(),
          fb_dtsg_preview: newDtsg.substring(0, 10) + '...'
        });

      } catch (err) {
        log.error("refreshFb_dtsg", "Refresh failed:", err.message);
        safeCallback(new CustomError(`Failed to refresh fb_dtsg: ${err.message}`, err.code || 'REFRESH_FAILED'));
      }
    })();

    return returnPromise;
  };
};
