/* push.js — web-push helpers. Silently no-ops if VAPID keys are missing. */
const webpush = require('web-push');
const { q } = require('./db');

let configured = false;
function init() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:owner@nimit.site', pub, priv);
    configured = true;
    console.log('[push] VAPID configured');
  } else {
    console.warn('[push] VAPID keys missing — push disabled (in-app briefings still work)');
  }
}

async function sendToAll(payload) {
  if (!configured) return { sent: 0, disabled: true };
  const subs = q.allSubs();
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      sent++;
    } catch (e) {
      // 404/410 = subscription expired: clean it out
      if (e.statusCode === 404 || e.statusCode === 410) q.deleteSub(sub.endpoint);
      else console.warn('[push] send failed:', e.statusCode || e.message);
    }
  }
  return { sent };
}

module.exports = { init, sendToAll, publicKey: () => process.env.VAPID_PUBLIC_KEY || '' };
