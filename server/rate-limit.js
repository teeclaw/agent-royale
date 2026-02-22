/**
 * In-memory rate limiter
 * Tracks request counts per IP with sliding window cleanup.
 */

class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.clients = new Map();

    // Cleanup every minute
    setInterval(() => this._cleanup(), 60000);
  }

  /**
   * Check if request is allowed. Returns true if allowed, false if blocked.
   */
  check(key) {
    const now = Date.now();
    let client = this.clients.get(key);

    if (!client || now - client.windowStart > this.windowMs) {
      client = { windowStart: now, count: 0 };
      this.clients.set(key, client);
    }

    client.count++;
    return client.count <= this.maxRequests;
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, client] of this.clients) {
      if (now - client.windowStart > this.windowMs) {
        this.clients.delete(key);
      }
    }
  }
}

// Pre-configured limiters
const a2aLimiter = new RateLimiter(60 * 1000, 60);       // 60 req/min
const channelLimiter = new RateLimiter(3600 * 1000, 10);  // 10 opens/hour
const getLimiter = new RateLimiter(60 * 1000, 200);        // 200 req/min
const sseLimiter = new RateLimiter(60 * 1000, 5);          // 5 SSE connects/min

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function rateLimit(limiter, label) {
  return (req, res, next) => {
    const ip = getClientIP(req);
    if (!limiter.check(ip)) {
      return res.status(429).json({ error: `Rate limited: ${label}` });
    }
    next();
  };
}

module.exports = { RateLimiter, a2aLimiter, channelLimiter, getLimiter, sseLimiter, rateLimit, getClientIP };
