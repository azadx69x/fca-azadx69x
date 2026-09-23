"use strict";

const utils = require("../utils");

module.exports = function (defaultFuncs, api, ctx) {
  return async function setMessageReaction(
    reaction,
    messageID,
    callback,
    forceCustomReaction,
  ) {
    // Accept both the normal and legacy signatures.
    if (typeof callback !== "function") {
      if (typeof arguments[3] === "function") {
        forceCustomReaction = arguments[4];
        callback = arguments[3];
      } else {
        callback = null;
      }
    }

    const operation = (async () => {
      if (reaction === undefined || reaction === null) {
        throw new Error("Please enter a valid emoji.");
      }

      const defData = await defaultFuncs.postFormData(
        "https://www.facebook.com/webgraphql/mutation/",
        ctx.jar,
        {},
        {
          doc_id: "1491398900900362",
          variables: JSON.stringify({
            data: {
              client_mutation_id: ctx.clientMutationId++,
              actor_id: ctx.userID,
              action: reaction == "" ? "REMOVE_REACTION" : "ADD_REACTION",
              message_id: messageID,
              reaction,
            },
          }),
          dpr: 1,
        },
      );

      const resData = await utils.parseAndCheckLogin(ctx, defaultFuncs)(defData);
      if (!resData) {
        throw new Error("setMessageReaction returned empty object.");
      }
      if (resData.error) throw resData;
      return resData;
    })();

    if (typeof callback === "function") {
      operation
        .then(() => callback(null))
        .catch((err) => {
          utils.error("setReaction", err);
          callback(err);
        });
    }

    return operation;
  };
};
