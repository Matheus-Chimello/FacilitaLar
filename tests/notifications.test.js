const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('node:child_process');
const { before, beforeEach, after, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'facilitalar-notifications-'));
process.env.FACILITALAR_DATABASE_PATH = path.join(temporaryDirectory, 'test.sqlite');
const app = require('../app');
const { db, all, get, run, transaction } = require('../src/db');
const { initializeNotifications, notifyMessage, notificationSummary } = require('../src/notifications');
const { dateNumber, localNow } = require('../src/scheduling');
let server;
let origin;
let customerId;
let strangerId;

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
      const saved = page.headers.getSetCookie()[0];
      if (saved) cookie = saved.split(';')[0];
      csrf = (await page.text()).match(/name="csrf-token" content="([a-f0-9]{64})"/)?.[1] || '';
      assert.ok(csrf);
    }
    const response = await fetch(origin + pathname, {
      method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { Cookie: cookie, Accept: json ? 'application/json' : 'text/html' },
      ...(body ? { body: new URLSearchParams(includeCsrf ? { _csrf: csrf, ...body } : body) } : {}),
    });
    const saved = response.headers.getSetCookie()[0];
    if (saved) {
      const next = saved.split(';')[0];
      if (next !== cookie) csrf = '';
      cookie = next;
    }
    return response;
  };
}

const provider = client();
const customer = client();
const stranger = client();
const admin = client();
const inbox = (userId) => all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id', [userId]);
const unread = (userId) => inbox(userId).filter((notification) => notification.read_at === null);

function createRequest(ownerId = customerId, status = 'pending') {
  const inserted = run(`INSERT INTO service_requests (service_id, customer_id, provider_id, scheduled_date, address, status)
    VALUES (1, ?, 2, ?, 'Rua de teste, 100', ?)`, [ownerId, `${nextWeekday()}T09:00`, status]);
  return get('SELECT * FROM service_requests WHERE id = ?', [inserted.lastInsertRowid]);
}

before(async () => {
  const hash = bcrypt.hashSync('cliente123456', 10);
  for (const [name, email] of [['Cliente de teste', 'cliente@teste.local'], ['Outro cliente', 'outro@teste.local']]) {
    run("INSERT INTO users (name, email, password_hash, role, email_verified_at) VALUES (?, ?, ?, 'customer', CURRENT_TIMESTAMP)", [name, email, hash]);
  }
  customerId = get("SELECT id FROM users WHERE email = 'cliente@teste.local'").id;
  strangerId = get("SELECT id FROM users WHERE email = 'outro@teste.local'").id;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const [agent, email, password] of [[provider, 'ana@facilitalar.com', 'provider123'], [admin, 'admin@facilitalar.com', 'admin123'], [customer, 'cliente@teste.local', 'cliente123456'], [stranger, 'outro@teste.local', 'cliente123456']]) {
    assert.equal((await agent('/entrar', { email, password })).status, 302);
  }
});

beforeEach(() => { run('DELETE FROM service_requests'); });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('Booking and valid status changes notify only the counterpart, without retry duplicates', async () => {
  const values = { date: nextWeekday(), time: '09:00', address: 'Rua de teste' };
  assert.equal((await customer('/contratante/solicitar/1', values)).status, 302);
  const request = get('SELECT * FROM service_requests ORDER BY id DESC LIMIT 1');
  assert.equal(inbox(2).length, 1);
  assert.equal(inbox(2)[0].kind, 'request');
  assert.match(inbox(2)[0].body, /Cliente de teste solicitou Faxina residencial completa/);
  assert.equal(inbox(customerId).length, 0);
  assert.equal((await stranger('/contratante/solicitar/1', values)).status, 409);
  assert.equal(inbox(2).length, 1);
  const statusPath = `/prestador/solicitacoes/${request.id}/status`;
  assert.equal((await provider(statusPath, { status: 'accepted' })).status, 302);
  assert.equal(inbox(customerId)[0].title, 'Horário confirmado');
  await provider(statusPath, { status: 'accepted' });
  assert.equal(inbox(customerId).length, 1);
  await provider(statusPath, { status: 'in_progress' });
  await provider(statusPath, { status: 'completed' });
  assert.deepEqual(inbox(customerId).filter((item) => item.kind === 'status').map((item) => item.title), ['Horário confirmado', 'Atendimento iniciado', 'Atendimento concluído']);
  assert.equal(inbox(customerId).filter((item) => item.kind === 'review_invite').length, 1);
  assert.equal(inbox(2).length, 1);
  assert.equal(inbox(strangerId).length, 0);
});

test('Cancellation and administrator changes notify the affected participants once', async () => {
  const request = createRequest();
  const cancel = `/contratante/solicitacoes/${request.id}/cancelar`;
  await stranger(cancel, {});
  assert.equal(inbox(2).length, 0);
  await customer(cancel, {});
  await customer(cancel, {});
  assert.equal(inbox(2).length, 1);
  assert.equal(inbox(2)[0].title, 'Atendimento cancelado');
  assert.equal(inbox(customerId).length, 0);
  const second = createRequest();
  await admin(`/admin/solicitacoes/${second.id}/status`, { status: 'canceled' });
  assert.equal(inbox(2).length, 2);
  assert.equal(inbox(customerId).length, 1);
  assert.equal(inbox(1).length, 0);
});

test('Unread messages are grouped, escaped and marked only by the recipient', async () => {
  const request = createRequest();
  const messages = `/solicitacoes/${request.id}/mensagens`;
  for (const body of ['Olá!', 'Podemos conversar? <script>alert(1)</script>']) {
    assert.equal((await customer(messages, { body }, true)).status, 201);
  }
  assert.equal(unread(2).length, 1);
  assert.equal(inbox(2)[0].occurrences, 2);
  assert.equal(inbox(2)[0].version, 2);
  assert.match(inbox(2)[0].title, /2 novas mensagens/);
  assert.equal(inbox(customerId).length, 0);
  const summary = await (await provider('/notificacoes/resumo', undefined, true)).json();
  assert.equal(summary.unreadCount, 1);
  assert.match(summary.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(summary.html, /<script>/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'css', 'fontawesome.css'), 'utf8');
  for (const icon of summary.html.matchAll(/class="fa (fa-[a-z-]+)"/g)) assert.ok(css.includes(`.${icon[1]}:before`), `${icon[1]} must exist in the bundled icon library`);
  await provider('/notificacoes');
  assert.equal(unread(2).length, 1, 'Opening the inbox must not mark notifications read');
  await admin(`/solicitacoes/${request.id}/conversa`);
  await customer(messages, undefined, true);
  assert.equal(unread(2).length, 1);
  assert.equal((await stranger(messages, undefined, true)).status, 404);
  await provider(messages, undefined, true);
  assert.equal(unread(2).length, 0);
  assert.ok(get('SELECT read_at FROM request_messages WHERE request_id = ?', [request.id]).read_at);
  await customer(messages, { body: 'Outra mensagem' }, true);
  assert.equal(inbox(2).length, 2);
  assert.equal(unread(2)[0].occurrences, 1);
  await provider(`/solicitacoes/${request.id}/conversa`);
  assert.equal(unread(2).length, 0);
});

test('Quotes and responses notify the right account and do not repeat a stale decision', async () => {
  const request = createRequest();
  const quotes = `/solicitacoes/${request.id}/propostas`;
  assert.equal((await provider(quotes, { amount: '-1' }, true)).status, 422);
  assert.equal(inbox(customerId).length, 0);
  await provider(quotes, { amount: '110,50' });
  const first = get('SELECT * FROM request_quotes WHERE request_id = ?', [request.id]);
  assert.equal(inbox(customerId)[0].kind, 'quote');
  assert.match(inbox(customerId)[0].body, /110,50/);
  await customer(`${quotes}/${first.id}/responder`, { decision: 'rejected' });
  assert.equal(inbox(2)[0].title, 'Proposta recusada');
  assert.equal((await customer(`${quotes}/${first.id}/responder`, { decision: 'accepted' }, true)).status, 409);
  assert.equal(inbox(2).length, 1);
  await provider(quotes, { amount: '100' });
  const second = get('SELECT * FROM request_quotes WHERE request_id = ? ORDER BY id DESC', [request.id]);
  await customer(`${quotes}/${second.id}/responder`, { decision: 'accepted' });
  assert.equal(inbox(2)[1].title, 'Proposta aceita');
  assert.equal((await customer(`${quotes}/${second.id}/responder`, { decision: 'accepted' }, true)).status, 409);
  assert.equal(inbox(2).length, 2);
});

test('Notification endpoints enforce ownership, authentication, CSRF and safe destinations', async () => {
  const request = createRequest();
  await customer(`/solicitacoes/${request.id}/mensagens`, { body: 'Aviso privado' }, true);
  const item = unread(2)[0];
  const values = { version: item.version, return_to: 'https://example.com' };
  const guest = client();
  assert.equal((await guest('/notificacoes/resumo', undefined, true)).status, 401);
  assert.equal((await guest('/notificacoes')).headers.get('location'), '/entrar');
  for (const agent of [stranger, customer, admin]) {
    assert.equal((await agent(`/notificacoes/${item.id}/leitura`, values, true)).status, 404);
    assert.equal((await agent(`/notificacoes/${item.id}/abrir`, values, true)).status, 404);
    assert.doesNotMatch((await (await agent('/notificacoes/resumo', undefined, true)).json()).html, /Aviso privado/);
  }
  assert.equal((await provider(`/notificacoes/${item.id}/leitura`, values, true, false)).status, 403);
  assert.equal(unread(2).length, 1);
  assert.equal((await provider(`/notificacoes/${item.id}/leitura`, { version: 'invalid' }, true)).status, 422);
  const response = await provider(`/notificacoes/${item.id}/abrir`, values);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `/solicitacoes/${request.id}/conversa`);
  assert.equal(unread(2).length, 0);
  assert.equal((await provider('/notificacoes/resumo', undefined, true)).headers.get('cache-control'), 'no-store');
});

test('A stale message preview cannot clear a newer message; mark-all is account-scoped', async () => {
  const request = createRequest();
  const messages = `/solicitacoes/${request.id}/mensagens`;
  await customer(messages, { body: 'Primeira' }, true);
  const first = unread(2)[0];
  await customer(messages, { body: 'Segunda' }, true);
  assert.equal((await provider(`/notificacoes/${first.id}/leitura`, { version: first.version }, true)).status, 409);
  assert.equal(unread(2).length, 1);
  await provider(messages, { body: 'Resposta' }, true);
  assert.equal(unread(customerId).length, 1);
  assert.equal((await provider('/notificacoes/ler-todas', {}, true, false)).status, 403);
  const summary = await (await provider('/notificacoes/ler-todas', {}, true)).json();
  assert.equal(summary.unreadCount, 0);
  assert.equal(unread(customerId).length, 1);
  assert.equal((await provider(`/notificacoes/${first.id}/leitura`, { version: 2 }, true)).status, 200);
});

test('Read filters and pagination are bounded and preserve read state', async () => {
  const request = createRequest();
  const now = Date.now();
  for (let index = 0; index < 23; index++) {
    run(`INSERT INTO notifications (user_id, request_id, kind, title, body, read_at, created_at, updated_at)
      VALUES (2, ?, 'status', ?, 'Atendimento', ?, ?, ?)`, [request.id, `Aviso ${index + 1}`, index < 3 ? now : null, now, now + index]);
  }
  let html = await (await provider('/notificacoes')).text();
  assert.match(html, /Página 1 de 2/);
  assert.match(html, /data-notification-unread-count>20/);
  assert.equal((html.match(/class="notification-row [^"]* "/g) || []).length, 20);
  html = await (await provider('/notificacoes?pagina=99999')).text();
  assert.match(html, /Página 2 de 2/);
  html = await (await provider('/notificacoes?filtro=lidas')).text();
  assert.match(html, /Aviso 1/);
  assert.doesNotMatch(html.split('<main')[1], /Aviso 23/);
  html = await (await provider('/notificacoes?filtro=nao-lidas')).text();
  assert.doesNotMatch(html.split('<main')[1], /<strong>Aviso 1<\/strong>/);
  assert.equal(unread(2).length, 20);
  const item = unread(2)[0];
  await provider(`/notificacoes/${item.id}/leitura`, { version: item.version, filtro: 'nao-lidas', pagina: '1' });
  assert.equal(unread(2).length, 19);
  assert.match(await (await stranger('/notificacoes?filtro=unknown&pagina=-1')).text(), /Nenhuma notificação/);
});

test('Existing actionable events migrate once and notifications survive a process restart', () => {
  const request = createRequest();
  run('INSERT INTO request_messages (request_id, sender_id, body) VALUES (?, ?, ?)', [request.id, customerId, 'Mensagem anterior']);
  run('INSERT INTO request_messages (request_id, sender_id, body) VALUES (?, ?, ?)', [request.id, customerId, 'Outra mensagem anterior']);
  run("INSERT INTO request_messages (request_id, sender_id, body, kind) VALUES (?, 1, 'Sistema', 'system')", [request.id]);
  run('INSERT INTO request_quotes (request_id, amount) VALUES (?, 150)', [request.id]);
  run('DELETE FROM schema_migrations WHERE name = ?', ['notification-inbox-v1']);
  initializeNotifications();
  initializeNotifications();
  assert.equal(inbox(2).length, 2);
  assert.equal(inbox(2)[1].occurrences, 2);
  assert.equal(inbox(customerId).length, 1);
  const result = spawnSync(process.execPath, ['-e', "const {get,db}=require('./src/db');console.log(get('SELECT COUNT(*) AS count FROM notifications').count);db.close()"], {
    cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '3');
  assert.throws(() => transaction(() => { notifyMessage(request, customerId, 'Cliente', 'Não persistir'); throw new Error('rollback'); }), /rollback/);
  assert.equal(inbox(2)[1].occurrences, 2);
  assert.equal(notificationSummary(2).unreadCount, 2);
});
