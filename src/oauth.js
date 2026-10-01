const express = require('express');
const bcrypt = require('bcryptjs');
const validator = require('validator');
const { randomBytes } = require('node:crypto');
const { get, run, transaction } = require('./db');
const { dashboardPath, setFlash } = require('./auth');
const { baseUrl, issueVerification } = require('./email-verification');
const { emailRequestAllowed, recordEmailRequest } = require('./security');

const router = express.Router();
const configCache = new Map();
let openidPromise;
const microsoftConsumerTenant = '9188040d-6c67-4c5b-b112-36a304b66dad';
const microsoftTenant = process.env.MICROSOFT_TENANT_ID || 'consumers';
if (microsoftTenant !== 'consumers' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(microsoftTenant)) {
  throw new Error('MICROSOFT_TENANT_ID deve ser consumers ou o ID de um tenant Microsoft.');
}

const providers = {
  google: {
    label: 'Google', icon: 'fa-google', issuer: 'https://accounts.google.com',
    clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
  microsoft: {
    label: 'Microsoft', icon: 'fa-windows',
    issuer: `https://login.microsoftonline.com/${microsoftTenant === 'consumers' ? microsoftConsumerTenant : microsoftTenant}/v2.0`,
    clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  },
};

function availableProviders() {
  return Object.entries(providers).filter(([, value]) => value.clientId && value.clientSecret)
    .map(([id, value]) => ({ id, label: value.label, icon: value.icon }));
}

async function openid() {
  if (!openidPromise) openidPromise = import('openid-client');
  return openidPromise;
}

async function oidcConfig(provider) {
  if (!configCache.has(provider)) {
    const client = await openid();
    const settings = providers[provider];
    const pending = client.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret);
    configCache.set(provider, pending);
    pending.catch(() => configCache.delete(provider));
  }
  return configCache.get(provider);
}

function clientFor(req) {
  return req.app.locals.openidClient || openid();
}

function configFor(req, provider) {
  return req.app.locals.oidcConfig ? req.app.locals.oidcConfig(provider) : oidcConfig(provider);
}

function callbackUrl(provider) {
  return `${baseUrl()}/auth/${provider}/callback`;
}

function findOrCreateIdentity(provider, claims, role) {
  if (typeof claims?.iss !== 'string' || typeof claims?.sub !== 'string' || !claims.sub) {
    return { error: 'O provedor não informou uma identidade válida.' };
  }
  const linked = get(`SELECT u.* FROM oauth_identities i JOIN users u ON u.id = i.user_id
    WHERE i.provider = ? AND i.issuer = ? AND i.subject = ?`, [provider, claims.iss, claims.sub]);
  if (linked) return linked.active ? { user: linked } : { error: 'Esta conta está desativada.' };

  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  if (!validator.isEmail(email, { allow_utf8_local_part: false })) {
    return { error: 'O provedor não forneceu um e-mail válido. Use o cadastro por e-mail e senha.' };
  }
  if (get('SELECT id FROM users WHERE email = ?', [email])) {
    return { error: 'Este e-mail já possui conta. Entre com e-mail e senha; por segurança, as contas não são vinculadas automaticamente.' };
  }

  const name = String(claims.name || email.split('@')[0]).trim().slice(0, 120);
  const passwordHash = bcrypt.hashSync(randomBytes(32).toString('hex'), 10);
  const verified = claims.email_verified === true;
  const userId = transaction(() => {
    const result = run(`INSERT INTO users (name, email, password_hash, role, email_verified_at)
      VALUES (?, ?, ?, ?, ${verified ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
    [name || 'Usuário', email, passwordHash, role]);
    run('INSERT INTO oauth_identities (provider, issuer, subject, user_id) VALUES (?, ?, ?, ?)',
      [provider, claims.iss, claims.sub, result.lastInsertRowid]);
    return result.lastInsertRowid;
  });
  return { user: get('SELECT * FROM users WHERE id = ?', [userId]), created: true };
}

router.get('/auth/:provider', async (req, res, next) => {
  const provider = req.params.provider;
  if (!availableProviders().some((item) => item.id === provider)) return res.status(404).render('error', { title: 'Acesso indisponível', message: 'Este provedor de acesso ainda não está configurado.' });
  if (req.user) return res.redirect(dashboardPath(req.user.role));
  try {
    const client = await clientFor(req);
    const config = await configFor(req, provider);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const redirect = client.buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl(provider), scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256', state, nonce,
    });
    req.session.oauthFlow = {
      provider, codeVerifier, state, nonce,
      role: req.query.perfil === 'prestador' ? 'provider' : 'customer',
      createdAt: Date.now(),
    };
    return req.session.save((error) => error ? next(error) : res.redirect(redirect.href));
  } catch (error) {
    return next(error);
  }
});

router.get('/auth/:provider/callback', async (req, res, next) => {
  const provider = req.params.provider;
  const flow = req.session.oauthFlow;
  delete req.session.oauthFlow;
  if (!flow || flow.provider !== provider || flow.createdAt < Date.now() - 10 * 60_000 ||
      typeof req.query.state !== 'string' || req.query.state !== flow.state) {
    return res.status(400).render('error', { title: 'Acesso interrompido', message: 'A autenticação expirou. Tente entrar novamente.' });
  }
  if (req.query.error) {
    setFlash(req, 'warning', 'O acesso externo não foi concluído.');
    return res.redirect('/entrar');
  }
  try {
    const client = await clientFor(req);
    const config = await configFor(req, provider);
    const tokens = await client.authorizationCodeGrant(config, new URL(req.originalUrl, baseUrl()), {
      pkceCodeVerifier: flow.codeVerifier, expectedState: flow.state,
      expectedNonce: flow.nonce, idTokenExpected: true,
    });
    let claims = tokens.claims();
    if (!claims) throw new Error('ID Token não retornado pelo provedor.');
    if (!claims.email && tokens.access_token) {
      const profile = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
      claims = {
        ...claims,
        email: profile.email || claims.preferred_username || profile.preferred_username,
        email_verified: profile.email_verified,
        name: claims.name || profile.name,
      };
    }
    const identity = findOrCreateIdentity(provider, claims, flow.role);
    if (identity.error) {
      setFlash(req, 'warning', identity.error);
      return res.redirect('/entrar');
    }
    if (!identity.user.email_verified_at) {
      if (identity.created && emailRequestAllowed(req.ip || 'unknown')) {
        recordEmailRequest(req.ip || 'unknown');
        try {
          const devUrl = await issueVerification(identity.user.id, identity.user.email, req.app.locals.sendVerificationEmail);
          if (devUrl) req.session.devVerification = { email: identity.user.email, url: devUrl };
        } catch (error) {
          console.error('Falha ao enviar confirmação de e-mail:', error);
        }
      }
      setFlash(req, 'warning', 'Confirme seu e-mail antes de entrar.');
      return res.redirect(`/verificacao-pendente?email=${encodeURIComponent(identity.user.email)}`);
    }
    return req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = identity.user.id;
      setFlash(req, 'success', `Olá, ${identity.user.name}.`);
      return res.redirect(dashboardPath(identity.user.role));
    });
  } catch (error) {
    console.error('Falha na autenticação externa:', error);
    setFlash(req, 'danger', 'Não foi possível entrar com este provedor agora. Tente novamente.');
    return res.redirect('/entrar');
  }
});

module.exports = { router, availableProviders, findOrCreateIdentity };
