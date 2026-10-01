const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { before, after, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'facilitalar-test-'));
process.env.FACILITALAR_DATABASE_PATH = path.join(temporaryDirectory, 'test.sqlite');
const app = require('../app');
const { db, get, run } = require('../src/db');
const { coordinates, nearbyServices } = require('../src/location');
const { CepError, formatCep, lookupCep } = require('../src/cep');
const { dateNumber, localNow, availabilityFromBody } = require('../src/scheduling');
const SqliteSessionStore = require('../src/session-store');
const { findOrCreateIdentity } = require('../src/oauth');
const { emailRequestAllowed, recordEmailRequest } = require('../src/security');
let server;
let origin;
let requestId;
let bookingDate;
const verificationLinks = new Map();
const resetLinks = new Map();

function nextWeekday() {
  let value = dateNumber(localNow().date) + 7 * 86400000;
  while ([0, 6].includes(new Date(value).getUTCDay())) value += 86400000;
  return new Date(value).toISOString().slice(0, 10);
}

function client() {
  let cookie = '';
  let csrf = '';
  return async (pathname, body, json = false, includeCsrf = true) => {
    if (body && includeCsrf && !csrf) {
      const page = await fetch(origin + '/', { headers: { Cookie: cookie } });
      const nextCookie = page.headers.getSetCookie()[0];
      if (nextCookie) cookie = nextCookie.split(';')[0];
      csrf = (await page.text()).match(/name="csrf-token" content="([a-f0-9]{64})"/)?.[1] || '';
      assert.ok(csrf, 'CSRF token must be present in the page');
    }
    const response = await fetch(origin + pathname, {
      method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { Cookie: cookie, Accept: json ? 'application/json' : 'text/html' },
      ...(body ? { body: new URLSearchParams(includeCsrf ? { _csrf: csrf, ...body } : body) } : {}),
    });
    const savedCookie = response.headers.getSetCookie()[0];
    if (savedCookie) {
      const nextCookie = savedCookie.split(';')[0];
      if (nextCookie !== cookie) csrf = '';
      cookie = nextCookie;
    }
    return response;
  };
}
const admin = client();
const provider = client();
const otherProvider = client();
const customer = client();
const stranger = client();

before(async () => {
  app.locals.sendVerificationEmail = async (email, url) => verificationLinks.set(email, url);
  app.locals.sendPasswordResetEmail = async (email, url) => resetLinks.set(email, url);
  const locations = {
    '01001000': { point: { latitude: 0, longitude: 0 } },
    '01001001': { point: { latitude: 0, longitude: 0.004 } },
    '01001002': { point: { latitude: 0, longitude: 0.02 } },
    '01001003': { point: null },
  };
  app.locals.lookupCep = async (input) => {
    const cep = formatCep(input);
    if (!cep) throw new CepError('Informe um CEP válido com 8 dígitos.');
    if (cep === '88888-888') throw new CepError('Não foi possível consultar o CEP agora. Tente novamente em instantes.', 503);
    const found = locations[cep.replace('-', '')];
    if (!found) throw new CepError('CEP não encontrado. Confira os números e tente novamente.');
    return { cep, city: 'São Paulo', state: 'SP', street: 'Rua de teste', neighborhood: 'Centro', ...found };
  };
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const [agent, email, password] of [[admin, 'admin@facilitalar.com', 'admin123'], [provider, 'ana@facilitalar.com', 'provider123'], [otherProvider, 'carlos@facilitalar.com', 'provider123']]) {
    assert.equal((await agent('/entrar', { email, password })).status, 302);
  }
  for (const [agent, name, email] of [[customer, 'Cliente de teste', 'cliente@teste.local'], [stranger, 'Outro cliente', 'outro@teste.local']]) {
    assert.equal((await agent('/cadastro', { name, email, password: 'cliente123456', role: 'customer', city: 'Fernandópolis' })).status, 302);
    assert.equal(get('SELECT email_verified_at FROM users WHERE email = ?', [email]).email_verified_at, null);
    const verification = new URL(verificationLinks.get(email));
    assert.equal((await agent(`${verification.pathname}${verification.search}`)).status, 302);
    assert.equal((await agent('/entrar', { email, password: 'cliente123456' })).status, 302);
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('Public pages and authenticated panels render with accents and service creation links', async () => {
  const guest = client();
  for (const route of ['/', '/prestadores', '/sobre', '/contato', '/cadastro', '/anunciar', '/entrar', '/servicos/1']) assert.equal((await guest(route)).status, 200, route);
  const providerSignup = await (await guest('/anunciar')).text();
  assert.match(providerSignup, /Criar conta de prestador/);
  assert.match(providerSignup, /\/entrar\?perfil=prestador/);
  assert.match(providerSignup, /name="_csrf"/);
  const home = await (await guest('/')).text();
  assert.match(home, /Anuncie seus serviços/);
  assert.doesNotMatch(home, /class="metric-row"/);
  assert.match(home, /href="#buscar-servicos"/);
  assert.match(home, /Limpeza pós-obra/);
  assert.ok(get('SELECT COUNT(*) AS count FROM categories').count >= 25);
  assert.match(await (await guest('/?q=hidraulica')).text(), /Reparos hidráulicos/);
  for (const route of ['/admin', '/admin/usuarios', '/admin/categorias', '/admin/servicos', '/admin/servicos/novo', '/admin/solicitacoes']) assert.equal((await admin(route)).status, 200, route);
  for (const route of ['/prestador', '/prestador/agenda', '/prestador/localizacao', '/prestador/servicos/novo', '/prestador/servicos/1/editar']) assert.equal((await provider(route)).status, 200, route);
  const locationForm = await (await provider('/prestador/localizacao')).text();
  assert.match(locationForm, /name="postal_code"/);
  assert.doesNotMatch(locationForm, /type="number"[^>]*name="latitude"/);
  assert.match(await (await admin('/admin/servicos/novo')).text(), /Prestador responsável/);
  assert.equal(get('SELECT name FROM categories WHERE id = 2').name, 'Hidráulica');
  assert.equal(get('SELECT city FROM users WHERE id = 2').city, 'Fernandópolis');
  assert.equal(get('SELECT name FROM categories WHERE id = 1').name, 'Limpeza residencial');
});

test('Service creation validates price, category and active provider, and enforces ownership', async () => {
  const values = { title: 'Organização de ambientes', description: 'Organização e cuidado com a casa.', category_id: '1', price: '150.50', duration_minutes: '90', service_area: 'Fernandópolis', provider_id: '2' };
  let response = await admin('/admin/servicos', { ...values, price: '-5' });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /Informe um preço/);
  assert.equal((await admin('/admin/servicos', { ...values, category_id: '9999' })).status, 422);
  assert.equal((await admin('/admin/servicos', { ...values, provider_id: '1' })).status, 422);
  assert.equal((await admin('/admin/servicos', values)).status, 302);
  const created = get('SELECT * FROM services WHERE title = ?', [values.title]);
  assert.equal(created.provider_id, 2);
  assert.equal(created.price, 150.5);
  assert.equal(created.duration_minutes, 90);
  assert.equal((await admin('/admin/servicos', { ...values, duration_minutes: '45' })).status, 422);
  assert.equal((await otherProvider(`/prestador/servicos/${created.id}`, { ...values, title: 'Alteração indevida' })).status, 302);
  assert.equal(get('SELECT title FROM services WHERE id = ?', [created.id]).title, values.title);
  assert.equal((await provider('/prestador/servicos', { ...values, title: 'Serviço do prestador', provider_id: '3' })).status, 302);
  assert.equal(get('SELECT provider_id FROM services WHERE title = ?', ['Serviço do prestador']).provider_id, 2);
  assert.equal((await customer('/admin/servicos', values)).status, 302);
});

test('CEP lookup validates the address and handles missing coordinates', async () => {
  assert.equal(formatCep('01001000'), '01001-000');
  assert.equal(formatCep('01001-000'), '01001-000');
  assert.equal(formatCep('0100100x'), null);
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    assert.equal(url, 'https://brasilapi.com.br/api/cep/v2/09642020');
    return { ok: true, status: 200, json: async () => ({ cep: '09642020', city: 'São Bernardo do Campo', state: 'SP', street: 'Rua Nelson Patrizzi', location: { coordinates: { latitude: '-23.6495165', longitude: '-46.57562' } } }) };
  };
  const address = await lookupCep('09642-020', fakeFetch);
  assert.equal(address.city, 'São Bernardo do Campo');
  assert.deepEqual(address.point, { latitude: -23.6495165, longitude: -46.57562 });
  assert.deepEqual(await lookupCep('09642020', fakeFetch), address);
  assert.equal(calls, 1);
  await assert.rejects(lookupCep('123', fakeFetch), { status: 422 });
  await assert.rejects(lookupCep('99999999', async () => ({ status: 404, ok: false })), { status: 422 });
  await assert.rejects(lookupCep('88888888', async () => { throw new Error('offline'); }), { status: 503 });
  const withoutPoint = await lookupCep('01001003', async () => ({ ok: true, status: 200, json: async () => ({ cep: '01001003', city: 'São Paulo', state: 'SP', location: { coordinates: {} } }) }));
  assert.equal(withoutPoint.point, null);
});

test('CEP registration and radius search exclude unlocated providers and preserve filtering', async () => {
  assert.equal(coordinates('', ''), null);
  assert.equal(coordinates(91, 0), null);
  assert.deepEqual(coordinates(0, 0), { latitude: 0, longitude: 0 });
  assert.equal((await provider('/prestador/localizacao', { postal_code: '123', latitude: '0', longitude: '0' })).status, 422);
  assert.equal((await provider('/prestador/localizacao', { postal_code: '99999-999' })).status, 422);
  assert.equal((await provider('/prestador/localizacao', { postal_code: '88888-888' })).status, 503);
  assert.equal((await provider('/prestador/localizacao', { postal_code: '01001-003' })).status, 422);
  assert.equal(get('SELECT postal_code FROM users WHERE id = 2').postal_code, '');
  assert.equal((await provider('/prestador/localizacao', { postal_code: '01001-001', location_address: 'Ponto de teste' })).status, 302);
  assert.equal((await otherProvider('/prestador/localizacao', { postal_code: '01001-002' })).status, 302);
  assert.deepEqual({ ...get('SELECT postal_code, city, longitude FROM users WHERE id = 2') }, { postal_code: '01001-001', city: 'São Paulo', longitude: 0.004 });
  assert.equal((await provider('/prestador/localizacao', { postal_code: '01001-001', latitude: '0', longitude: '0.005' })).status, 302);
  assert.equal(get('SELECT longitude FROM users WHERE id = 2').longitude, 0.005);
  let html = await (await customer('/prestadores?cep=01001-000&radius=1')).text();
  assert.match(html, /Ana Silva/);
  assert.doesNotMatch(html, /Carlos Mendes|Marina Souza/);
  assert.match(html, /CEP 01001-000/);
  html = await (await customer('/prestadores?cep=01001-000&radius=3')).text();
  assert.ok(html.indexOf('Ana Silva') < html.indexOf('Carlos Mendes'));
  assert.doesNotMatch(html, /Marina Souza/);
  assert.match(await (await customer('/?cep=01001-000&radius=1&category=1')).text(), /distance-badge/);
  assert.match(await (await customer('/?cep=01001-000&radius=1')).text(), /cep=01001-000/);
  const invalidSearch = await customer('/prestadores?cep=123&radius=1');
  assert.equal(invalidSearch.status, 422);
  assert.doesNotMatch(await invalidSearch.text(), /Ana Silva/);
  assert.equal((await customer('/prestadores?cep=01001-003&radius=1')).status, 422);
  assert.equal((await customer('/prestadores?cep=88888-888&radius=1')).status, 503);
  assert.equal((await provider('/prestador/localizacao', { postal_code: '01001-003', latitude: '0', longitude: '0.004' })).status, 302);
  assert.equal(get('SELECT postal_code FROM users WHERE id = 2').postal_code, '01001-003');
  assert.equal((await provider('/prestador/localizacao/remover', {})).status, 302);
  assert.equal(get('SELECT postal_code FROM users WHERE id = 2').postal_code, '');
  const filtered = nearbyServices([{ id: 1, provider_latitude: 0, provider_longitude: 0.02 }, { id: 2, provider_latitude: 0, provider_longitude: 0.004 }, { id: 3, provider_latitude: null, provider_longitude: null }], { latitude: 0, longitude: 0, radius: 1 });
  assert.deepEqual(filtered.map((service) => service.id), [2]);
});

test('Weekly availability, blocked days and atomic booking prevent overlapping requests', async () => {
  bookingDate = nextWeekday();
  const weekday = new Date(dateNumber(bookingDate)).getUTCDay();
  const hours = { [`start_${weekday}_0`]: '09:00', [`end_${weekday}_0`]: '12:00', [`start_${weekday}_1`]: '13:00', [`end_${weekday}_1`]: '16:00' };
  assert.equal(availabilityFromBody({ [`start_${weekday}_0`]: '09:00', [`end_${weekday}_0`]: '09:15' }).error.includes('30 minutos'), true);
  assert.equal((await customer('/prestador/agenda')).status, 302);
  assert.equal((await provider('/prestador/agenda', { ...hours, [`start_${weekday}_1`]: '11:30' })).status, 422);
  assert.equal(get('SELECT COUNT(*) AS count FROM provider_hours WHERE provider_id = 2').count, 10);
  assert.equal((await provider('/prestador/agenda', hours)).status, 302);
  assert.equal(get('SELECT COUNT(*) AS count FROM provider_hours WHERE provider_id = 2').count, 2);

  const slotsPath = `/servicos/1/horarios?date=${bookingDate}`;
  assert.equal((await customer(`/servicos/1/horarios?date=2020-01-01`, undefined, true)).status, 422);
  assert.equal((await customer(slotsPath, undefined, true)).status, 200);
  let slots = (await (await customer(slotsPath, undefined, true)).json()).slots;
  assert.ok(slots.includes('09:00'));
  assert.ok(!slots.includes('12:00'));
  assert.equal((await provider('/prestador/agenda/bloqueios', { date: bookingDate })).status, 302);
  assert.deepEqual((await (await customer(slotsPath, undefined, true)).json()).slots, []);
  assert.equal((await provider(`/prestador/agenda/bloqueios/${bookingDate}/remover`, {})).status, 302);
  assert.equal((await customer('/contratante/solicitar/1')).status, 200);
  assert.match(await (await customer('/contratante/solicitar/1')).text(), /Horário disponível/);
  assert.equal((await customer('/contratante/solicitar/1', { date: bookingDate, time: '09:15', address: 'Rua de teste' })).status, 422);
  assert.equal((await customer('/contratante/solicitar/1', { date: bookingDate, time: '09:00', address: 'Rua de teste' })).status, 302);
  const firstId = get('SELECT id FROM service_requests ORDER BY id DESC LIMIT 1').id;
  assert.ok(!(await (await customer(slotsPath, undefined, true)).json()).slots.includes('09:30'));
  assert.equal((await stranger('/contratante/solicitar/5', { date: bookingDate, time: '09:30', address: 'Rua diferente' })).status, 409);
  assert.equal((await stranger('/contratante/solicitar/1', { date: bookingDate, time: '09:00', address: 'Rua diferente' })).status, 409);
  assert.equal((await provider('/prestador/agenda/bloqueios', { date: bookingDate })).status, 302);
  assert.equal(get('SELECT COUNT(*) AS count FROM provider_days_off WHERE provider_id = 2').count, 0);
  assert.equal((await customer(`/contratante/solicitacoes/${firstId}/cancelar`, {})).status, 302);
  slots = (await (await customer(slotsPath, undefined, true)).json()).slots;
  assert.ok(slots.includes('09:00'));
  assert.equal((await stranger('/contratante/solicitar/1', { date: bookingDate, time: '09:00', address: 'Rua diferente' })).status, 302);
  const secondId = get('SELECT id FROM service_requests ORDER BY id DESC LIMIT 1').id;
  assert.equal((await stranger(`/contratante/solicitacoes/${secondId}/cancelar`, {})).status, 302);
});

test('Conversation access is private and unread messages are cleared only by the recipient', async () => {
  assert.equal((await customer('/contratante/solicitar/1', { date: bookingDate, time: '10:00', address: 'Rua de teste, 100', notes: 'Combinar o atendimento.' })).status, 302);
  requestId = get('SELECT id FROM service_requests ORDER BY id DESC LIMIT 1').id;
  const messagesPath = `/solicitacoes/${requestId}/mensagens`;
  assert.equal((await stranger(messagesPath, undefined, true)).status, 404);
  assert.equal((await otherProvider(messagesPath, { body: 'Indevida' }, true)).status, 404);
  assert.equal((await admin(messagesPath, { body: 'Indevida' }, true)).status, 403);
  assert.equal((await customer(messagesPath, { body: ' ' }, true)).status, 422);
  assert.equal((await customer(messagesPath, { body: 'x'.repeat(2001) }, true)).status, 422);
  assert.equal((await customer(messagesPath, { body: 'Olá! Podemos combinar o preço? <script>teste</script>' }, true)).status, 201);
  assert.match(await (await provider('/prestador')).text(), /unread-badge/);
  assert.equal((await admin(`/solicitacoes/${requestId}/conversa`)).status, 200);
  assert.equal(get('SELECT read_at FROM request_messages WHERE request_id = ?', [requestId]).read_at, null);
  const html = await (await provider(`/solicitacoes/${requestId}/conversa`)).text();
  assert.match(html, /&lt;script&gt;teste&lt;\/script&gt;/);
  assert.ok(get('SELECT read_at FROM request_messages WHERE request_id = ?', [requestId]).read_at);
  assert.equal((await provider(messagesPath, { body: 'Olá! Posso fazer por R$ 110.' }, true)).status, 201);
  const data = await (await customer(messagesPath, undefined, true)).json();
  assert.equal(data.messages.length, 2);
  assert.equal(data.canSend, true);
});

test('Quote negotiation accepts only the client decision, records the amount and prevents stale acceptance', async () => {
  const quotesPath = `/solicitacoes/${requestId}/propostas`;
  assert.equal((await customer(quotesPath, { amount: '110' }, true)).status, 403);
  assert.equal((await provider(quotesPath, { amount: '-1' }, true)).status, 422);
  assert.equal((await provider(quotesPath, { amount: '110,50', note: 'Inclui os materiais.' })).status, 302);
  const first = get('SELECT id FROM request_quotes WHERE request_id = ? ORDER BY id DESC', [requestId]);
  assert.equal((await provider(quotesPath, { amount: '105' })).status, 302);
  assert.equal((await customer(`${quotesPath}/${first.id}/responder`, { decision: 'accepted' }, true)).status, 409);
  let pending = get("SELECT * FROM request_quotes WHERE request_id = ? AND status = 'pending'", [requestId]);
  assert.equal((await provider(`${quotesPath}/${pending.id}/responder`, { decision: 'accepted' }, true)).status, 403);
  assert.equal((await customer(`${quotesPath}/${pending.id}/responder`, { decision: 'rejected' })).status, 302);
  assert.equal((await provider(quotesPath, { amount: '100.50' })).status, 302);
  pending = get("SELECT * FROM request_quotes WHERE request_id = ? AND status = 'pending'", [requestId]);
  assert.equal((await customer(`${quotesPath}/${pending.id}/responder`, { decision: 'accepted' })).status, 302);
  const request = get('SELECT * FROM service_requests WHERE id = ?', [requestId]);
  assert.equal(request.agreed_price, 100.5);
  assert.equal(request.status, 'pending');
  assert.equal((await customer(`${quotesPath}/${pending.id}/responder`, { decision: 'accepted' }, true)).status, 409);
  assert.equal((await provider(quotesPath, { amount: '200' }, true)).status, 409);
  assert.match(await (await customer('/contratante')).text(), /100,50/);
  assert.match(await (await provider(`/solicitacoes/${requestId}/conversa`)).text(), /Valor combinado/);
  const conflict = run(`INSERT INTO service_requests (service_id, customer_id, provider_id, scheduled_date, duration_minutes, address, status)
    VALUES (5, ?, 2, ?, 60, 'Rua de teste', 'accepted')`, [get('SELECT id FROM users WHERE email = ?', ['outro@teste.local']).id, `${bookingDate}T10:00`]);
  assert.equal((await provider(`/prestador/solicitacoes/${requestId}/status`, { status: 'accepted' })).status, 302);
  assert.equal(get('SELECT status FROM service_requests WHERE id = ?', [requestId]).status, 'pending');
  run("UPDATE service_requests SET status = 'canceled' WHERE id = ?", [conflict.lastInsertRowid]);
  assert.equal((await provider(`/prestador/solicitacoes/${requestId}/status`, { status: 'accepted' })).status, 302);
  assert.equal(get('SELECT status FROM service_requests WHERE id = ?', [requestId]).status, 'accepted');
  assert.equal((await provider(`/prestador/solicitacoes/${requestId}/status`, { status: 'pending' })).status, 302);
  assert.equal(get('SELECT status FROM service_requests WHERE id = ?', [requestId]).status, 'accepted');
});

test('Completed requests keep the conversation history and reject further messages or proposals', async () => {
  assert.equal((await provider(`/prestador/solicitacoes/${requestId}/status`, { status: 'in_progress' })).status, 302);
  assert.equal((await provider(`/prestador/solicitacoes/${requestId}/status`, { status: 'completed' })).status, 302);
  assert.equal((await customer(`/solicitacoes/${requestId}/mensagens`, { body: 'Outra mensagem' }, true)).status, 409);
  assert.equal((await provider(`/solicitacoes/${requestId}/propostas`, { amount: '99' }, true)).status, 409);
  const response = await customer(`/solicitacoes/${requestId}/mensagens`, undefined, true);
  const data = await response.json();
  assert.equal(data.canSend, false);
  assert.equal(data.statusLabel, 'Concluído');
  assert.ok(data.messages.length >= 5);
  assert.match(await (await customer(`/solicitacoes/${requestId}/conversa`)).text(), /conversa deste atendimento foi encerrada/);
});

test('CSRF protection rejects missing or forged tokens and sets security headers', async () => {
  const guest = client();
  const page = await guest('/entrar');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal((await guest('/entrar', { email: 'ana@facilitalar.com', password: 'provider123' }, false, false)).status, 403);
  assert.equal((await guest('/entrar', { email: 'ana@facilitalar.com', password: 'provider123', _csrf: '0'.repeat(64) })).status, 403);
  assert.equal((await guest('/entrar', { email: 'ana@facilitalar.com', password: 'provider123' })).status, 302);
});

test('Registration verifies email ownership with a single-use link before login', async () => {
  const guest = client();
  const email = 'novo@teste.local';
  const values = { name: 'Novo prestador', email, role: 'provider', password: 'senha-segura-123' };
  assert.equal((await guest('/cadastro', { ...values, email: 'invalido' })).status, 422);
  assert.equal((await guest('/cadastro', { ...values, password: 'curta' })).status, 422);
  assert.equal((await guest('/cadastro?perfil=prestador', values)).status, 302);
  assert.equal(get('SELECT email_verified_at FROM users WHERE email = ?', [email]).email_verified_at, null);
  assert.equal((await guest('/entrar', { email, password: values.password })).headers.get('location'), `/verificacao-pendente?email=${encodeURIComponent(email)}`);
  const verification = new URL(verificationLinks.get(email));
  assert.equal((await guest(`/verificar-email?token=${'0'.repeat(64)}`)).status, 302);
  assert.equal((await guest('/reenviar-verificacao', { email })).status, 302);
  assert.equal(verificationLinks.get(email), verification.href);
  assert.equal((await guest(`${verification.pathname}${verification.search}`)).status, 302);
  assert.ok(get('SELECT email_verified_at FROM users WHERE email = ?', [email]).email_verified_at);
  assert.equal((await guest(`${verification.pathname}${verification.search}`)).headers.get('location'), '/verificacao-pendente');
  assert.equal((await guest('/entrar', { email, password: values.password })).headers.get('location'), '/prestador');
});

test('SQLite sessions survive store recreation and expire cleanly', async () => {
  const store = new SqliteSessionStore();
  const call = (instance, method, ...args) => new Promise((resolve, reject) => instance[method](...args, (error, value) => error ? reject(error) : resolve(value)));
  const expires = new Date(Date.now() + 60_000).toISOString();
  await call(store, 'set', 'persist-test', { userId: 123, cookie: { expires } });
  const reloaded = new SqliteSessionStore();
  assert.equal((await call(reloaded, 'get', 'persist-test')).userId, 123);
  await call(reloaded, 'touch', 'persist-test', { cookie: { expires: new Date(Date.now() + 120_000).toISOString() } });
  assert.ok(get('SELECT expires_at FROM sessions WHERE id = ?', ['persist-test']).expires_at > Date.now() + 60_000);
  await call(reloaded, 'destroy', 'persist-test');
  assert.equal(await call(store, 'get', 'persist-test'), null);
  await call(store, 'set', 'expired-test', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(await call(reloaded, 'get', 'expired-test'), null);
});

test('Password reset links are single-use and invalidate earlier sessions', async () => {
  const guest = client();
  const email = 'cliente@teste.local';
  assert.equal((await guest('/esqueci-senha', { email })).status, 302);
  const reset = new URL(resetLinks.get(email));
  assert.equal((await guest(`${reset.pathname}${reset.search}`)).status, 200);
  assert.equal((await guest('/redefinir-senha', { token: reset.searchParams.get('token'), password: 'short', confirm_password: 'short' })).status, 422);
  assert.equal((await guest('/redefinir-senha', { token: reset.searchParams.get('token'), password: 'nova-senha-segura-123', confirm_password: 'nova-senha-segura-123' })).status, 302);
  assert.equal((await customer('/contratante')).headers.get('location'), '/entrar');
  assert.equal((await guest(`${reset.pathname}${reset.search}`)).headers.get('location'), '/esqueci-senha');
  assert.equal((await guest('/entrar', { email, password: 'cliente123456' })).status, 401);
  assert.equal((await guest('/entrar', { email, password: 'nova-senha-segura-123' })).headers.get('location'), '/contratante');
});

test('External identities use provider subject and never auto-link by email', () => {
  const google = { iss: 'https://accounts.google.com', sub: 'test-subject', email: 'oauth@teste.local', email_verified: true, name: 'Pessoa OAuth' };
  const created = findOrCreateIdentity('google', google, 'provider');
  assert.equal(created.user.role, 'provider');
  assert.ok(created.user.email_verified_at);
  assert.equal(findOrCreateIdentity('google', { ...google, email: 'changed@teste.local' }, 'customer').user.id, created.user.id);
  assert.match(findOrCreateIdentity('google', { ...google, sub: 'other-subject', email: 'ana@facilitalar.com' }, 'provider').error, /já possui conta/);
  const microsoft = findOrCreateIdentity('microsoft', { iss: 'https://login.microsoftonline.com/tenant/v2.0', sub: 'ms-subject', email: 'ms@teste.local' }, 'customer');
  assert.equal(microsoft.user.email_verified_at, null);
});

test('Production refuses missing configuration and never seeds demo accounts', () => {
  const productionDb = path.join(temporaryDirectory, 'production.sqlite');
  const env = {
    ...process.env, NODE_ENV: 'production', FACILITALAR_DATABASE_PATH: productionDb,
    SESSION_SECRET: 'a'.repeat(64), APP_BASE_URL: 'https://facilitalar.example',
    SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'contato@facilitalar.example',
    ADMIN_EMAIL: 'owner@example.test', ADMIN_PASSWORD: 'very-secure-admin-pass-123',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', MICROSOFT_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: '',
  };
  const launch = (changes) => spawnSync(process.execPath, ['-e', "require('./app')"], {
    cwd: path.join(__dirname, '..'), env: { ...env, ...changes }, encoding: 'utf8', timeout: 10_000,
  });
  assert.match(launch({ SESSION_SECRET: '' }).stderr, /SESSION_SECRET/);
  assert.match(launch({ SMTP_HOST: '' }).stderr, /SMTP_HOST/);
  const ready = launch({});
  assert.equal(ready.status, 0, ready.stderr);
  const production = new DatabaseSync(productionDb);
  assert.equal(production.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count, 1);
  assert.equal(production.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'provider'").get().count, 0);
  assert.equal(production.prepare('SELECT COUNT(*) AS count FROM services').get().count, 0);
  assert.ok(production.prepare('SELECT COUNT(*) AS count FROM categories').get().count >= 25);
  production.prepare("INSERT INTO categories (name, description) VALUES ('Categoria personalizada', 'Criada pelo administrador')").run();
  const categoryCount = production.prepare('SELECT COUNT(*) AS count FROM categories').get().count;
  production.close();
  assert.equal(launch({}).status, 0);
  const reopened = new DatabaseSync(productionDb);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM categories').get().count, categoryCount);
  assert.equal(reopened.prepare("SELECT description FROM categories WHERE name = 'Categoria personalizada'").get().description, 'Criada pelo administrador');
  reopened.close();
});

test('Repeated password failures are throttled for the account and IP', async () => {
  const guest = client();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await guest('/entrar', { email: 'ana@facilitalar.com', password: 'wrong-password' })).status, 401);
  }
  assert.equal((await guest('/entrar', { email: 'ana@facilitalar.com', password: 'provider123' })).status, 429);
});

test('Email delivery requests are limited per source IP', () => {
  const ip = '198.51.100.40';
  assert.equal(emailRequestAllowed(ip), true);
  for (let index = 0; index < 10; index += 1) recordEmailRequest(ip);
  assert.equal(emailRequestAllowed(ip), false);
});
