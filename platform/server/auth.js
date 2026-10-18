import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isLoopback } from './config.js';
import { ApiError } from './errors.js';

export function createAuth(config) {
  const sessions = new Map();
  const attempts = new Map();
  const sameKey = (value) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(config.apiKey) && timingSafeEqual(Buffer.from(value), Buffer.from(config.apiKey));
  const cookieToken = (req) => /(?:^|;\s*)forte_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const sessionValid = (req) => (sessions.get(cookieToken(req)) || 0) > Date.now();
  const authenticated = (req) => sameKey(req.headers['x-api-key']) || sessionValid(req);
  const localAllowed = (req) => config.localAutoSession && isLoopback(config.host) && isLoopback(req.socket.remoteAddress);
  function protectOrigin(req, _res, next) {
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, ''); } catch { return next(new ApiError(400, 'INVALID_HOST', 'Некорректный адрес сервиса.')); }
    const publicUrl = config.publicOrigin ? new URL(config.publicOrigin) : null;
    if ((publicUrl && req.headers.host !== publicUrl.host) || (!publicUrl && !isLoopback(host))) return next(new ApiError(403, 'INVALID_HOST', 'Этот адрес сервиса не разрешён.'));
    const origin = req.headers.origin;
    const expected = config.publicOrigin || `${req.secure ? 'https' : 'http'}://${req.headers.host}`;
    if ((origin && origin !== expected) || req.headers['sec-fetch-site'] === 'cross-site') return next(new ApiError(403, 'ORIGIN_REJECTED', 'Запрос должен поступать с этого сайта.'));
    next();
  }
  function requireAuth(req, _res, next) {
    if (!authenticated(req)) return next(new ApiError(401, 'UNAUTHORIZED', 'Введите API-ключ сервиса в настройках подключения.'));
    next();
  }
  function login(req, res) {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let attempt = attempts.get(ip);
    if (attempt && attempt.until <= now) { attempts.delete(ip); attempt = null; }
    if (attempt?.count >= 10) { res.set('Retry-After', String(Math.ceil((attempt.until - now) / 1000))); throw new ApiError(429, 'RATE_LIMITED', 'Слишком много попыток входа. Повторите позже.'); }
    const explicitKey = req.body?.api_key;
    if (!(sameKey(explicitKey) || (explicitKey === undefined && localAllowed(req)))) {
      attempts.set(ip, { count: (attempt?.count || 0) + 1, until: attempt?.until || now + 15 * 60000 });
      throw new ApiError(401, 'UNAUTHORIZED', 'API-ключ не принят. Проверьте его в настройках сервиса.');
    }
    attempts.delete(ip);
    const old = cookieToken(req);
    if (old) sessions.delete(old);
    for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + config.sessionTtlMs);
    const secure = config.publicOrigin?.startsWith('https:') || req.secure;
    res.cookie('forte_session', token, { httpOnly: true, sameSite: 'strict', secure: Boolean(secure), path: '/', maxAge: config.sessionTtlMs });
    res.json({ authenticated: true, expires_at: new Date(now + config.sessionTtlMs).toISOString(), local_auto_session: localAllowed(req) });
  }
  function logout(req, res) {
    sessions.delete(cookieToken(req));
    res.clearCookie('forte_session', { httpOnly: true, sameSite: 'strict', path: '/', secure: Boolean(config.publicOrigin?.startsWith('https:') || req.secure) });
    res.status(204).end();
  }
  return { protectOrigin, requireAuth, login, logout, authenticated, localAllowed };
}
