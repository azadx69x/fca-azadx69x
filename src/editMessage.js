/* editMessage.js - Fully Fixed Version */
// fixed by @Azadx69x 
"use strict";

const log = require("npmlog");

// Fallback implementation if utils not available
function generateOfflineThreadingID() {
  // Facebook's offline threading ID format: <timestamp><random>
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 100000);
  return (timestamp * 100000 + random).toString();
}

module.exports = function (defaultFuncs, api, ctx) {
  
  // Initialize required context properties
  if (!ctx.pendingEdits) {
    ctx.pendingEdits = new Map();
  }
  if (typeof ctx.wsReqNumber !== 'number') {
    ctx.wsReqNumber = 1;
  }
  if (typeof ctx.wsTaskNumber !== 'number') {
    ctx.wsTaskNumber = 1;
  }

  // Try to get proper generateOfflineThreadingID from utils
  let offlineIdGen;
  try {
    const utils = require('../utils');
    offlineIdGen = utils.generateOfflineThreadingID || generateOfflineThreadingID;
  } catch (e) {
    offlineIdGen = generateOfflineThreadingID;
  }

  /**
   * Schedule ACK watchdog with proper cleanup
   */
  function scheduleEditAckWatch(messageID, settings, ctx, callback) {
    const { 
      ackTimeoutMs = 12000, 
      maxResendAttempts = 2, 
      editTTLms = 300000 
    } = settings;

    const timer = setTimeout(() => {
      const rec = ctx.pendingEdits.get(messageID);
      
      // Already acknowledged or removed
      if (!rec) {
        return;
      }

      const age = Date.now() - rec.ts;
      
      // Expired by TTL
      if (age > editTTLms) {
        ctx.pendingEdits.delete(messageID);
        if (ctx.health) {
          ctx.health.removePendingEdit(messageID);
          ctx.health.incPendingEditExpired();
        }
        // Notify caller of timeout
        if (callback && !rec.notified) {
          rec.notified = true;
          callback(new Error('Edit message timeout - no acknowledgment received'));
        }
        return;
      }

      // Max attempts reached
      if (rec.attempts >= maxResendAttempts) {
        ctx.pendingEdits.delete(messageID);
        if (ctx.health) {
          ctx.health.markEditFailed(messageID);
        }
        if (callback && !rec.notified) {
          rec.notified = true;
          callback(new Error('Edit message failed after max retry attempts'));
        }
        return;
      }

      // Resend attempt
      try {
        rec.attempts++;
        
        if (ctx.health) {
          ctx.health.markEditResent(messageID);
        }

        // Increment counters
        ctx.wsReqNumber += 1;
        ctx.wsTaskNumber += 1;

        const queryPayload = { 
          message_id: messageID, 
          text: rec.text 
        };
        
        const query = {
          failure_count: null,
          label: '742',
          payload: JSON.stringify(queryPayload),
          queue_name: 'edit_message',
          task_id: ctx.wsTaskNumber
        };
        
        const context = {
          app_id: '2220391788200892',
          payload: JSON.stringify({
            data_trace_id: null,
            epoch_id: parseInt(offlineIdGen()),
            tasks: [query],
            version_id: '6903494529735864'
          }),
          request_id: ctx.wsReqNumber,
          type: 3
        };

        ctx.mqttClient.publish(
          '/ls_req', 
          JSON.stringify(context), 
          { qos: 1, retain: false },
          (err) => {
            if (err) {
              if (ctx.health) ctx.health.onError('edit_resend_publish_fail');
              // Don't callback here, let next watchdog handle it
            }
          }
        );

        // Schedule next watch
        scheduleEditAckWatch(messageID, settings, ctx, callback);

      } catch (e) {
        if (ctx.health) ctx.health.onError('edit_resend_exception');
        ctx.pendingEdits.delete(messageID);
        if (callback && !rec.notified) {
          rec.notified = true;
          callback(new Error('Edit resend failed: ' + e.message));
        }
      }
    }, ackTimeoutMs);

    // Store timer reference for cleanup
    const rec = ctx.pendingEdits.get(messageID);
    if (rec) {
      rec.timer = timer;
    }
  }

  /**
   * Mark edit as acknowledged (call this from your MQTT message handler)
   */
  function acknowledgeEdit(messageID, success = true) {
    const rec = ctx.pendingEdits.get(messageID);
    if (!rec) return false;

    // Clear watchdog timer
    if (rec.timer) {
      clearTimeout(rec.timer);
    }

    ctx.pendingEdits.delete(messageID);
    
    if (ctx.health) {
      ctx.health.removePendingEdit(messageID);
      if (success) {
        ctx.health.markEditSuccess(messageID);
      }
    }

    return true;
  }

  // Expose acknowledge function to ctx for external use
  ctx.acknowledgeEdit = acknowledgeEdit;

  /**
   * Clean old pending edits (call periodically)
   */
  function cleanupOldEdits(maxAge = 300000) {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [msgID, rec] of ctx.pendingEdits.entries()) {
      if (now - rec.ts > maxAge) {
        if (rec.timer) clearTimeout(rec.timer);
        ctx.pendingEdits.delete(msgID);
        cleaned++;
      }
    }
    
    return cleaned;
  }

  // Auto cleanup every 5 minutes
  if (!ctx.editCleanupInterval) {
    ctx.editCleanupInterval = setInterval(() => {
      cleanupOldEdits();
    }, 300000);
  }

  /**
   * Main editMessage function
   */
  return function editMessage(text, messageID, callback) {
    // Promise support
    let promise;
    let resolved = false;
    
    if (typeof callback !== 'function') {
      promise = new Promise((resolve, reject) => {
        callback = (err, data) => {
          if (resolved) return; // Prevent double callback
          resolved = true;
          err ? reject(err) : resolve(data);
        };
      });
    } else {
      // Wrap callback to prevent multiple invocations
      const originalCb = callback;
      callback = (err, data) => {
        if (resolved) return;
        resolved = true;
        originalCb(err, data);
      };
    }

    // Default empty callback
    callback = callback || function() {};

    // Validation
    if (!ctx.mqttClient) {
      callback(new Error('Not connected to MQTT'));
      return promise;
    }

    if (!messageID || typeof messageID !== 'string') {
      callback(new Error('Invalid messageID: must be a non-empty string'));
      return promise;
    }

    if (typeof text !== 'string') {
      callback(new Error('Invalid text: must be a string'));
      return promise;
    }

    if (text.length > 20000) {
      callback(new Error('Text too long: maximum 20000 characters'));
      return promise;
    }

    // Settings with defaults
    const settings = ctx.globalOptions.editSettings || { 
      maxPendingEdits: 200, 
      editTTLms: 300000, 
      ackTimeoutMs: 12000, 
      maxResendAttempts: 2 
    };

    // Check if already editing this message
    if (ctx.pendingEdits.has(messageID)) {
      const existing = ctx.pendingEdits.get(messageID);
      // Update text and reset attempts
      existing.text = text;
      existing.ts = Date.now();
      existing.attempts = 0;
      if (existing.timer) {
        clearTimeout(existing.timer);
      }
      
      if (ctx.health) {
        ctx.health.incEditUpdated(messageID);
      }
      
      log.verbose("editMessage", `Updated pending edit for ${messageID}`);
    } else {
      // Capacity management - remove oldest if full
      if (ctx.pendingEdits.size >= settings.maxPendingEdits) {
        const firstKey = ctx.pendingEdits.keys().next().value;
        if (firstKey) { 
          const old = ctx.pendingEdits.get(firstKey);
          if (old && old.timer) clearTimeout(old.timer);
          ctx.pendingEdits.delete(firstKey); 
          if (ctx.health) ctx.health.incPendingEditDropped(); 
          log.warn("editMessage", `Dropped oldest pending edit: ${firstKey}`);
        }
      }

      // Add new pending edit
      const now = Date.now();
      ctx.pendingEdits.set(messageID, { 
        text, 
        ts: now, 
        attempts: 0,
        notified: false
      });
      
      if (ctx.health) {
        ctx.health.addPendingEdit(messageID, text);
      }
    }

    // Increment counters
    ctx.wsReqNumber += 1;
    ctx.wsTaskNumber += 1;

    // Build payload
    const queryPayload = { 
      message_id: messageID, 
      text: text 
    };
    
    const query = {
      failure_count: null,
      label: '742',
      payload: JSON.stringify(queryPayload),
      queue_name: 'edit_message',
      task_id: ctx.wsTaskNumber
    };
    
    const context = {
      app_id: '2220391788200892',
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id: parseInt(offlineIdGen()),
        tasks: [query],
        version_id: '6903494529735864'
      }),
      request_id: ctx.wsReqNumber,
      type: 3
    };

    // Publish
    try {
      ctx.mqttClient.publish(
        '/ls_req', 
        JSON.stringify(context), 
        { qos: 1, retain: false }, 
        (err) => {
          if (err) {
            if (ctx.health) ctx.health.onError('edit_publish_fail');
            
            // Remove from pending since publish failed immediately
            const rec = ctx.pendingEdits.get(messageID);
            if (rec && rec.timer) clearTimeout(rec.timer);
            ctx.pendingEdits.delete(messageID);
            if (ctx.health) ctx.health.removePendingEdit(messageID);
            
            return callback(new Error('Failed to publish edit: ' + err.message));
          }
          
          // Schedule ACK watchdog
          scheduleEditAckWatch(messageID, settings, ctx, callback);
          
          // Return immediately with queued status
          callback(null, { 
            success: true,
            queued: true, 
            messageID: messageID,
            requestId: ctx.wsReqNumber
          });
        }
      );
    } catch (e) {
      if (ctx.health) ctx.health.onError('edit_exception');
      
      // Cleanup on exception
      const rec = ctx.pendingEdits.get(messageID);
      if (rec && rec.timer) clearTimeout(rec.timer);
      ctx.pendingEdits.delete(messageID);
      if (ctx.health) ctx.health.removePendingEdit(messageID);
      
      callback(new Error('Edit message exception: ' + e.message));
    }

    return promise;
  };
};
