/* auth.js — owner-token gate with sliding-window rate limiting (in-memory only). */
const WINDOW_MS = 2 * 60 * 1000;       // count fails in last 2 minutes
const MAX_FAILS = 5;
const BLOCK_MS = 60 * 60 * 1000;      // 1 hour lockout
const buckets = new Map();             // ip -> { fails: number[], blockedUntil: number }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function pruneFails(b) {
  const cutoff = Date.now() - WINDOW_MS;
  b.fails = b.fails.filter(t => t > cutoff);
}

function dropBucketIfStale(ip, b) {
  if (b.fails.length === 0 && Date.now() >= b.blockedUntil) buckets.delete(ip);
}

function blockedResponse(res, blockedUntil) {
  const retrySec = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  const mins = Math.ceil(retrySec / 60);
  const label = mins >= 60 ? `${Math.ceil(mins / 60)} hour${mins >= 120 ? 's' : ''}` : `${mins} minute${mins === 1 ? '' : 's'}`;
  return res.status(429).json({
    error: 'rate_limited',
    message: `Too many failed token attempts. Try again in ${label}.`,
    retry_after: retrySec,
  });
}

function ownerAuth(token) {
  return (req, res, next) => {
    if (!token) return next();

    const ip = clientIp(req);
    let b = buckets.get(ip);
    if (!b) {
      b = { fails: [], blockedUntil: 0 };
      buckets.set(ip, b);
    }

    pruneFails(b);

    if (Date.now() < b.blockedUntil) return blockedResponse(res, b.blockedUntil);

    if (req.get('X-Owner-Token') === token) {
      buckets.delete(ip);
      return next();
    }

    b.fails.push(Date.now());
    pruneFails(b);

    if (b.fails.length >= MAX_FAILS) {
      b.blockedUntil = Date.now() + BLOCK_MS;
      b.fails = [];
      console.warn(`[auth] token lockout for ${ip} (${BLOCK_MS / 60000}m)`);
      return blockedResponse(res, b.blockedUntil);
    }

    dropBucketIfStale(ip, b);
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid owner token',
      attempts_remaining: MAX_FAILS - b.fails.length,
    });
  };
}

module.exports = { ownerAuth };
