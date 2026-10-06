import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** HTTP basic auth for the dashboard and admin API. Passing a null password disables it. */
export function basicAuth(user: string, password: string | null): RequestHandler {
  return (req, res, next) => {
    if (password === null) return next();
    const header = req.get('authorization') ?? '';
    const [scheme, encoded = ''] = header.split(' ');
    if (scheme === 'Basic') {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep >= 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="WhatsApp Lists", charset="UTF-8"').sendStatus(401);
  };
}
