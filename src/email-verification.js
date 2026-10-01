const { randomBytes, createHash } = require('node:crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const { all, get, run, transaction } = require('./db');

const lifetime = 24 * 60 * 60 * 1000;
let transport;

function mailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function baseUrl() {
  const value = process.env.APP_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
  let url;
  try { url = new URL(value); } catch { throw new Error('Defina APP_BASE_URL com a URL pública do site.'); }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('APP_BASE_URL deve usar HTTPS em produção.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('APP_BASE_URL deve conter apenas a origem do site.');
  }
  return url.origin;
}

function emailTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: process.env.NODE_ENV === 'production' && process.env.SMTP_SECURE !== 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
  }
  return transport;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function deliver(email, url, subject, text, sendMail) {
  if (sendMail) await sendMail(email, url);
  else if (mailConfigured()) {
    await emailTransport().sendMail({ from: process.env.SMTP_FROM, to: email, subject, text });
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('SMTP não configurado para envio de e-mail.');
  }
  return process.env.NODE_ENV === 'production' || mailConfigured() || sendMail ? null : url;
}

async function issueVerification(userId, email, sendMail = null) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const url = `${baseUrl()}/verificar-email?token=${token}`;
  transaction(() => {
    run(`INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, sent_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      token_hash = excluded.token_hash, expires_at = excluded.expires_at, sent_at = excluded.sent_at`,
    [userId, tokenHash(token), now + lifetime, now]);
  });

  return deliver(email, url, 'Confirme seu e-mail | Facilita Lar',
    `Confirme seu e-mail para acessar o Facilita Lar:\n\n${url}\n\nO link vence em 24 horas. Se você não criou esta conta, ignore esta mensagem.`, sendMail);
}

function verifyEmail(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token))) return false;
  return transaction(() => {
    const record = get('SELECT user_id, expires_at FROM email_verification_tokens WHERE token_hash = ?', [tokenHash(token)]);
    if (!record || record.expires_at <= Date.now()) return false;
    run('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?', [record.user_id]);
    run('DELETE FROM email_verification_tokens WHERE user_id = ?', [record.user_id]);
    return true;
  });
}

async function issuePasswordReset(userId, email, sendMail = null) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const url = `${baseUrl()}/redefinir-senha?token=${token}`;
  transaction(() => {
    run(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, sent_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      token_hash = excluded.token_hash, expires_at = excluded.expires_at, sent_at = excluded.sent_at`,
    [userId, tokenHash(token), now + 60 * 60 * 1000, now]);
  });
  return deliver(email, url, 'Redefina sua senha | Facilita Lar',
    `Use este link para redefinir sua senha:\n\n${url}\n\nO link vence em uma hora. Se você não solicitou a troca, ignore esta mensagem.`, sendMail);
}

function resetTokenUser(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token))) return null;
  return get('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?', [tokenHash(token), Date.now()]);
}

function resetPassword(token, password) {
  const record = resetTokenUser(token);
  if (!record) return false;
  const passwordHash = bcrypt.hashSync(password, 10);
  return transaction(() => {
    const fresh = resetTokenUser(token);
    if (!fresh) return false;
    run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, fresh.user_id]);
    run('DELETE FROM password_reset_tokens WHERE user_id = ?', [fresh.user_id]);
    for (const session of all('SELECT id, data FROM sessions')) {
      try {
        if (JSON.parse(session.data).userId === fresh.user_id) run('DELETE FROM sessions WHERE id = ?', [session.id]);
      } catch { run('DELETE FROM sessions WHERE id = ?', [session.id]); }
    }
    return true;
  });
}

module.exports = { baseUrl, mailConfigured, issueVerification, verifyEmail, issuePasswordReset, resetTokenUser, resetPassword };
