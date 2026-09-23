"use strict";

const axios = require("axios");

function toHighQualityUrl(url, size = [2048, 2048]) {
  if (!url || typeof url !== "string") return null;
  const [width, height] = size;

  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("facebook.com") || parsed.hostname.includes("fbcdn.net")) {
      parsed.searchParams.set("width", String(width || 2048));
      parsed.searchParams.set("height", String(height || 2048));
      parsed.pathname = parsed.pathname.replace(/\/p\d+x\d+(?=\/|$)/i, `/p${width || 2048}x${height || 2048}`);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}width=${width || 2048}&height=${height || 2048}`;
  }
}

// Resolve the CDN URL returned by the logged-in Messenger session. The old
// implementation called graph.facebook.com with access_token=NONE, which
// returns an invalid/blank image for many accounts.
module.exports = function (defaultFuncs, api, ctx) {
  return function getAvatarUser(userIDs, size = [2048, 2048], callback) {
    const ids = Array.isArray(userIDs) ? userIDs : [userIDs];
    let resolveFunc;
    let rejectFunc;
    const promise = typeof callback === "function"
      ? null
      : new Promise((resolve, reject) => {
        resolveFunc = resolve;
        rejectFunc = reject;
      });

    const resolver = (err, result) => {
      if (typeof callback === "function") callback(err, result);
      if (!promise) return;
      if (err) rejectFunc(err);
      else resolveFunc(result);
    };

    (async () => {
      try {
        const result = {};
        for (const id of ids) {
          try {
            const response = await axios.post("https://www.facebook.com/api/graphql/", null, {
              params: {
                doc_id: "5341536295888250",
                variables: JSON.stringify({ height: 500, scale: 1, userID: id, width: 500 }),
              },
            });
            const directURL = response.data?.data?.profile?.profile_picture?.uri;
            if (directURL) result[String(id)] = directURL;
          } catch {}
        }

        const missingIDs = ids.filter((id) => !result[String(id)]);
        if (missingIDs.length && typeof api.getUserInfo === "function") {
          const info = await api.getUserInfo(missingIDs.length === 1 ? missingIDs[0] : missingIDs);
          for (const id of missingIDs) {
            const profile = info?.[String(id)];
            const url = toHighQualityUrl(profile?.profilePicUrl || profile?.thumbSrc, size);
            if (url) result[String(id)] = url;
          }
        }
        resolver(null, result);
      } catch (err) {
        resolver(err);
      }
    })();

    return promise;
  };
};
