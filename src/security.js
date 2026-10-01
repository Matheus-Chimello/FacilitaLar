const { randomBytes, timingSafeEqual } = require('node:crypto');
const { get, run } = require('./db');

const accountWindow = 15 * 60 * 1000;
const ipWindow = 24 * 60 * 60 * 1000;

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('hex');
    res.locals.csrfToken = req.session.csrfToken;
    return next();
  }

  const submitted = req.get('x-csrf-token') || req.body?._csrf;
  const expected = req.session.csrfToken;
  if (typeof submitted === 'string' && /^[a-f0-9]{64}$/.test(submitted) && expected &&
      timingSafeEqual(Buffer.from(submitted, 'hex'), Buffer.from(expected, 'hex'))) {
    res.locals.csrfToken = expected;
    return next();
  }
  if (req.get('accept')?.includes('application/json')) return res.status(403).json({ error: 'Sessão expirada. Atualize a página e tente novamente.' });
  return res.status(403).render('error', {
    title: 'Ação não autorizada',
    message: 'Sessão expirada. Atualize a página e tente novamente.',
  });
}

function loginIsLimited(ip, email, now = Date.now()) {
  const account = get('SELECT COUNT(*) AS count FROM login_failures WHERE ip = ? AND email = ? AND attempted_at > ?', [ip, email, now - accountWindow]);
  const source = get('SELECT COUNT(*) AS count FROM login_failures WHERE ip = ? AND attempted_at > ?', [ip, now - ipWindow]);
  return account.count >= 5 || source.count >= 100;
}

function recordLoginFailure(ip, email, now = Date.now()) {
  run('DELETE FROM login_failures WHERE attempted_at <= ?', [now - ipWindow]);
  run('INSERT INTO login_failures (ip, email, attempted_at) VALUES (?, ?, ?)', [ip, email, now]);
}

function clearLoginFailures(ip, email) {
  run('DELETE FROM login_failures WHERE ip = ? AND email = ?', [ip, email]);
}

function emailRequestAllowed(ip, now = Date.now()) {
  const recent = get('SELECT COUNT(*) AS count FROM email_requests WHERE ip = ? AND sent_at > ?', [ip, now - 60 * 60 * 1000]);
  return recent.count < 10;
}

function recordEmailRequest(ip, now = Date.now()) {
  run('DELETE FROM email_requests WHERE sent_at <= ?', [now - 60 * 60 * 1000]);
  run('INSERT INTO email_requests (ip, sent_at) VALUES (?, ?)', [ip, now]);
}

module.exports = {
  csrfProtection, loginIsLimited, recordLoginFailure, clearLoginFailures,
  emailRequestAllowed, recordEmailRequest,
};
