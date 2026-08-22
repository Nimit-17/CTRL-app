/* auth.js — optional owner-token gate with brute-force rate limiting. */
const MAX_FAILS = 5;
const BLOCK_MS = 5 * 60 * 1000;
const buckets = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function bucketFor(req) {
  const ip = clientIp(req);
  if (!buckets.has(ip)) buckets.set(ip, { fails: 0, blockedUntil: 0 });
  return buckets.get(ip);
}

function blockedResponse(res, blockedUntil) {
  const retrySec = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  const mins = Math.ceil(retrySec / 60);
  return res.status(429).json({
    error: 'rate_limited',
    message: `Too many failed token attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    retry_after: retrySec,
  });
}

function ownerAuth(token) {
  return (req, res, next) => {
    if (!token) return next();

    const b = bucketFor(req);
    if (Date.now() < b.blockedUntil) return blockedResponse(res, b.blockedUntil);

    if (req.get('X-Owner-Token') === token) {
      b.fails = 0;
      b.blockedUntil = 0;
      return next();
    }

    b.fails += 1;
    if (b.fails >= MAX_FAILS) {
      b.blockedUntil = Date.now() + BLOCK_MS;
      b.fails = 0;
      console.warn(`[auth] token lockout for ${clientIp(req)} (${BLOCK_MS / 60000}m)`);
      return blockedResponse(res, b.blockedUntil);
    }

    return res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid owner token',
      attempts_remaining: MAX_FAILS - b.fails,
    });
  };
}

module.exports = { ownerAuth };
