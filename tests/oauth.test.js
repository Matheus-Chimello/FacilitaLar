const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'facilitalar-oauth-'));
process.env.FACILITALAR_DATABASE_PATH = path.join(directory, 'oauth.sqlite');
process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
process.env.MICROSOFT_CLIENT_ID = 'test-microsoft-client';
process.env.MICROSOFT_CLIENT_SECRET = 'test-microsoft-secret';

const app = require('../app');
const { db, get } = require('../src/db');
let server;
let origin;
const mailLinks = new Map();

function browser() {
  let cookie = '';
  const visit = async (pathname) => {
    const response = await fetch(origin + pathname, { redirect: 'manual', headers: { Cookie: cookie } });
    const saved = response.headers.getSetCookie()[0];
    if (saved) cookie = saved.split(';')[0];
    return response;
  };
  visit.cookie = () => cookie;
  return visit;
}

before(async () => {
  app.locals.openidClient = {
    randomPKCECodeVerifier: () => 'test-verifier',
    randomState: () => 'test-state',
    randomNonce: () => 'test-nonce',
    calculatePKCECodeChallenge: async () => 'test-challenge',
    buildAuthorizationUrl: (config, params) => {
      const url = new URL('https://identity.example.test/authorize');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url;
    },
    authorizationCodeGrant: async (config, currentUrl, checks) => {
      assert.equal(checks.pkceCodeVerifier, 'test-verifier');
      assert.equal(checks.expectedState, 'test-state');
      assert.equal(checks.expectedNonce, 'test-nonce');
      assert.equal(currentUrl.searchParams.get('state'), 'test-state');
      const microsoft = currentUrl.pathname.includes('microsoft');
      return { claims: () => ({
        iss: microsoft ? 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' : 'https://accounts.google.com',
        sub: microsoft ? 'microsoft-subject' : 'google-subject',
        email: microsoft ? undefined : 'google-user@example.test',
        preferred_username: microsoft ? 'microsoft-user@example.test' : undefined,
        email_verified: !microsoft,
        name: microsoft ? 'Pessoa Microsoft' : 'Pessoa Google',
      }) };
    },
    fetchUserInfo: async () => ({ name: 'Pessoa Microsoft' }),
  };
  app.locals.oidcConfig = async () => ({});
  app.locals.sendVerificationEmail = async (email, url) => mailLinks.set(email, url);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = origin;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Configured providers appear and wrong OAuth state is rejected', async () => {
  const guest = browser();
  const html = await (await guest('/entrar')).text();
  assert.match(html, /Continuar com Google/);
  assert.match(html, /Continuar com Microsoft/);
  const start = await guest('/auth/google');
  assert.equal(start.status, 302);
  const redirect = new URL(start.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), 'test-state');
  assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await guest('/auth/google/callback?code=test&state=wrong')).status, 400);
  assert.equal((await guest('/auth/google/callback?code=test&state=test-state')).status, 400);
});

test('Google creates a verified provider account and rotates the session', async () => {
  const guest = browser();
  assert.equal((await guest('/auth/google?perfil=prestador')).status, 302);
  const originalCookie = guest.cookie();
  const callback = await guest('/auth/google/callback?code=test&state=test-state');
  assert.equal(callback.headers.get('location'), '/prestador');
  assert.notEqual(guest.cookie(), originalCookie);
  assert.equal((await guest('/prestador')).status, 200);
  const user = get('SELECT role, email_verified_at FROM users WHERE email = ?', ['google-user@example.test']);
  assert.equal(user.role, 'provider');
  assert.ok(user.email_verified_at);
});

test('Microsoft account requires email confirmation before login', async () => {
  const guest = browser();
  assert.equal((await guest('/auth/microsoft')).status, 302);
  const callback = await guest('/auth/microsoft/callback?code=test&state=test-state');
  assert.match(callback.headers.get('location'), /^\/verificacao-pendente/);
  assert.equal(get('SELECT email_verified_at FROM users WHERE email = ?', ['microsoft-user@example.test']).email_verified_at, null);
  const verification = new URL(mailLinks.get('microsoft-user@example.test'));
  assert.equal((await guest(`${verification.pathname}${verification.search}`)).status, 302);
  assert.equal((await guest('/auth/microsoft')).status, 302);
  assert.equal((await guest('/auth/microsoft/callback?code=test&state=test-state')).headers.get('location'), '/contratante');
  assert.equal((await guest('/contratante')).status, 200);
});
