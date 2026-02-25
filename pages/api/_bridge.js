export function withCommonJsHandler(handler) {
  return async function bridgedHandler(req, res) {
    try {
      return await handler(req, res);
    } catch (err) {
      console.error('API bridge error', err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message || 'internal_error' });
      }
    }
  };
}
