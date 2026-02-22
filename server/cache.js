/**
 * Simple TTL response cache.
 */

class ResponseCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data, ttlMs) {
    this.store.set(key, { data, expires: Date.now() + ttlMs });
  }
}

const cache = new ResponseCache();

/**
 * Express middleware: cache JSON responses.
 * @param {string} key - cache key (use route path)
 * @param {number} ttlMs - TTL in milliseconds
 */
function cacheMiddleware(key, ttlMs) {
  return (req, res, next) => {
    const cached = cache.get(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    const origJson = res.json.bind(res);
    res.json = (data) => {
      cache.set(key, data, ttlMs);
      res.setHeader('X-Cache', 'MISS');
      return origJson(data);
    };
    next();
  };
}

module.exports = { cache, cacheMiddleware };
