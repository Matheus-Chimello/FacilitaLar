const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('node:child_process');
const { before, beforeEach, after, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'facilitalar-reviews-'));
process.env.FACILITALAR_DATABASE_PATH = path.join(temporaryDirectory, 'test.sqlite');
const app = require('../app');
const { db, all, get, run } = require('../src/db');
const { initializeReviews, ratingSummary, reviewPage } = require('../src/reviews');
let server;
let origin;
let customerId;
let strangerId;

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

const customer = client();
const stranger = client();
const provider = client();
const otherProvider = client();
const admin = client();
const guest = client();
const reviewPath = (request) => `/solicitacoes/${request.id}/avaliacao`;
const notifications = (kind) => all('SELECT * FROM notifications WHERE kind = ? ORDER BY id', [kind]);

function createRequest(status = 'completed', owner = customerId) {
  const inserted = run(`INSERT INTO service_requests (service_id, customer_id, provider_id, scheduled_date, address, notes, status)
    VALUES (1, ?, 2, '2026-10-15T09:00', 'Endereço privado do cliente', 'Observação privada do pedido', ?)`, [owner, status]);
  return get('SELECT * FROM service_requests WHERE id = ?', [inserted.lastInsertRowid]);
}

async function publish(request, rating = '4', comment = 'Atendimento pontual e cuidadoso.') {
  assert.equal((await customer(reviewPath(request), { rating, comment })).status, 303);
  return get('SELECT * FROM reviews WHERE request_id = ?', [request.id]);
}

before(async () => {
  const hash = bcrypt.hashSync('cliente123456', 10);
  for (const [name, email] of [['Mariana Oliveira', 'cliente@teste.local'], ['Outra Pessoa', 'outro@teste.local']]) {
    run("INSERT INTO users (name, email, password_hash, role, email_verified_at) VALUES (?, ?, ?, 'customer', CURRENT_TIMESTAMP)", [name, email, hash]);
  }
  customerId = get("SELECT id FROM users WHERE email = 'cliente@teste.local'").id;
  strangerId = get("SELECT id FROM users WHERE email = 'outro@teste.local'").id;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const [agent, email, password] of [[customer, 'cliente@teste.local', 'cliente123456'], [stranger, 'outro@teste.local', 'cliente123456'], [provider, 'ana@facilitalar.com', 'provider123'], [otherProvider, 'carlos@facilitalar.com', 'provider123'], [admin, 'admin@facilitalar.com', 'admin123']]) {
    assert.equal((await agent('/entrar', { email, password })).status, 302);
  }
});

beforeEach(() => { run('DELETE FROM service_requests'); });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('Completion invites the customer once and the notification opens the review form', async () => {
  const request = createRequest('in_progress');
  assert.doesNotMatch(await (await customer(reviewPath(request))).text(), /id="review-form"/);
  await provider(`/prestador/solicitacoes/${request.id}/status`, { status: 'completed' });
  await provider(`/prestador/solicitacoes/${request.id}/status`, { status: 'completed' });
  const invite = notifications('review_invite')[0];
  assert.equal(notifications('review_invite').length, 1);
  assert.equal(invite.user_id, customerId);
  const open = await customer(`/notificacoes/${invite.id}/abrir`, { version: invite.version });
  assert.equal(open.headers.get('location'), reviewPath(request));
  const html = await (await customer(reviewPath(request))).text();
  assert.match(html, /id="review-form"/);
  assert.equal((html.match(/type="radio" name="rating"/g) || []).length, 5);
  assert.match(await (await customer('/contratante')).text(), /> Avaliar<\/a>/);
  await publish(request);
  assert.ok(get('SELECT read_at FROM notifications WHERE id = ?', [invite.id]).read_at);
  assert.equal(notifications('review')[0].user_id, 2);
  assert.match(await (await customer('/contratante')).text(), /Nota 4\/5/);
  assert.match(await (await customer(reviewPath(request))).text(), /Avaliação do atendimento/);
});

test('Only the actual customer can review a completed request, with bounded integer ratings', async () => {
  const request = createRequest();
  for (const rating of ['0', '6', '-1', '4.5', '1e0', 'true', '', ' 5 ']) {
    assert.equal((await customer(reviewPath(request), { rating }, true)).status, 422, rating);
  }
  assert.equal((await customer(reviewPath(request), { rating: '5', comment: 'x'.repeat(1501) }, true)).status, 422);
  for (const status of ['pending', 'accepted', 'in_progress', 'canceled']) {
    const unfinished = createRequest(status);
    assert.equal((await customer(reviewPath(unfinished), { rating: '5' }, true)).status, 409, status);
  }
  assert.equal((await stranger(reviewPath(request), { rating: '5', customer_id: customerId }, true)).status, 404);
  assert.equal((await otherProvider(reviewPath(request), { rating: '5' }, true)).status, 404);
  for (const agent of [provider, admin]) assert.equal((await agent(reviewPath(request), { rating: '5' }, true)).status, 403);
  assert.equal((await guest(reviewPath(request), { rating: '5' }, true)).status, 401);
  assert.equal((await stranger(reviewPath(request))).status, 404);
  assert.equal((await customer('/solicitacoes/NaN/avaliacao')).status, 404);
  assert.equal((await customer(reviewPath(request), { rating: '5' }, true, false)).status, 403);
  assert.equal(get('SELECT COUNT(*) AS count FROM reviews').count, 0);
  await publish(request, '5', '');
  assert.equal(ratingSummary(2).count, 1);
  assert.throws(() => run('INSERT INTO reviews (request_id,rating,created_at) VALUES (?,1.5,?)', [createRequest().id, Date.now()]), /CHECK/);
});

test('Concurrent submissions create only one review and one notification', async () => {
  const request = createRequest();
  await customer(reviewPath(request), { rating: '0' }, true);
  const replies = await Promise.all([customer(reviewPath(request), { rating: '2', comment: 'Poderia melhorar.' }, true), customer(reviewPath(request), { rating: '5', comment: 'Outra avaliação.' }, true)]);
  assert.deepEqual(replies.map((response) => response.status).sort(), [303, 409]);
  assert.equal(get('SELECT COUNT(*) AS count FROM reviews').count, 1);
  assert.equal(notifications('review').length, 1);
  assert.equal((await customer(reviewPath(request), { rating: '5' }, true)).status, 409);
  assert.throws(() => run('INSERT INTO reviews (request_id,rating,created_at) VALUES (?,5,?)', [request.id, Date.now()]), /UNIQUE/);
});

test('Public reputation aggregates actual ratings and escapes text without leaking request details', async () => {
  const first = createRequest();
  await publish(first, '5', '<script>alert(1)</script> Ótimo atendimento!');
  await publish(createRequest(), '3', 'Atrasou um pouco, mas resolveu o problema.');
  assert.deepEqual({ ...ratingSummary(2) }, { count: 2, average: 4 });
  for (const route of ['/', '/prestadores', '/servicos/1', '/prestadores/2']) {
    const response = await guest(route);
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), /4,0/);
  }
  const html = await (await guest('/prestadores/2')).text();
  assert.match(html, /2 avaliações/);
  assert.match(html, /Mariana O\./);
  assert.match(html, /Atendimento verificado/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  for (const privateValue of ['Mariana Oliveira', 'cliente@teste.local', 'Endereço privado do cliente', 'Observação privada do pedido']) assert.ok(!html.includes(privateValue), privateValue);
  assert.match(await (await guest('/prestadores/3')).text(), /Sem avaliações/);
  assert.equal((await guest('/prestadores/1')).status, 404);
});

test('Only the responsible provider can publish one response; customer receives a linked notification', async () => {
  const request = createRequest();
  await publish(request);
  const responsePath = `${reviewPath(request)}/resposta`;
  assert.equal((await customer(responsePath, { response: 'Indevida' }, true)).status, 403);
  assert.equal((await admin(responsePath, { response: 'Indevida' }, true)).status, 403);
  assert.equal((await otherProvider(responsePath, { response: 'Indevida' }, true)).status, 404);
  for (const response of ['', 'x'.repeat(1501)]) assert.equal((await provider(responsePath, { response }, true)).status, 422);
  assert.equal((await provider(responsePath, { response: 'Obrigado! <img src=x onerror=alert(1)>' })).status, 303);
  assert.equal((await provider(responsePath, { response: 'Duplicada' }, true)).status, 409);
  const notice = notifications('review_response')[0];
  assert.equal(notifications('review_response').length, 1);
  assert.equal(notice.user_id, customerId);
  assert.equal((await customer(`/notificacoes/${notice.id}/abrir`, { version: notice.version })).headers.get('location'), reviewPath(request));
  assert.match(await (await guest('/prestadores/2')).text(), /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal((await provider(`${reviewPath(createRequest())}/resposta`, { response: 'Sem avaliação' }, true)).status, 409);
});

test('Moderation preserves negative ratings, records reasons and can restore comments and replies', async () => {
  const request = createRequest();
  const review = await publish(request, '1', 'O serviço atrasou e ficou incompleto.');
  await provider(`${reviewPath(request)}/resposta`, { response: 'Vamos conversar sobre o ocorrido.' });
  await publish(createRequest(), '5');
  const moderationPath = `/admin/avaliacoes/${review.id}/moderar`;
  const values = { action: 'comment:hide', reason: 'offensive_content', note: 'Registro interno de teste.', rating: '5' };
  assert.equal((await customer(moderationPath, values, true)).status, 302);
  assert.equal((await provider(moderationPath, values, true)).status, 302);
  assert.equal((await admin(moderationPath, values, true, false)).status, 403);
  for (const invalid of [{ ...values, reason: 'negative_rating' }, { ...values, action: 'rating:hide' }, { ...values, action: 'constructor' }, { ...values, note: 'x'.repeat(501) }]) {
    assert.equal((await admin(moderationPath, invalid, true)).status, 422);
  }
  assert.equal((await admin(moderationPath, values, true)).status, 200);
  assert.equal((await admin(moderationPath, values, true)).status, 409);
  let html = await (await guest('/prestadores/2')).text();
  assert.doesNotMatch(html, /O serviço atrasou e ficou incompleto/);
  assert.match(html, /Comentário ocultado pela moderação/);
  assert.equal(get('SELECT rating FROM reviews WHERE id = ?', [review.id]).rating, 1);
  assert.deepEqual({ ...ratingSummary(2) }, { count: 2, average: 3 });
  assert.equal((await admin(moderationPath, { action: 'response:hide', reason: 'personal_data' }, true)).status, 200);
  assert.doesNotMatch(await (await guest('/prestadores/2')).text(), /Vamos conversar sobre o ocorrido/);
  assert.match(await (await admin('/admin/avaliacoes?filtro=ocultadas')).text(), /Registro interno de teste/);
  assert.match(await (await customer(reviewPath(request))).text(), /Histórico de moderação/);
  assert.doesNotMatch(await (await customer(reviewPath(request))).text(), /Registro interno de teste/);
  for (const target of ['comment', 'response']) assert.equal((await admin(moderationPath, { action: `${target}:restore` }, true)).status, 200);
  html = await (await guest('/prestadores/2')).text();
  assert.match(html, /O serviço atrasou e ficou incompleto/);
  assert.match(html, /Vamos conversar sobre o ocorrido/);
  assert.equal(get('SELECT COUNT(*) AS count FROM review_moderation').count, 4);
  assert.equal(notifications('review_moderation').length, 8);
  assert.deepEqual({ ...ratingSummary(2) }, { count: 2, average: 3 });
});

test('Public and private lists paginate, support empty states and restrict inactive providers', async () => {
  assert.match(await (await provider('/prestador/avaliacoes')).text(), /Nenhuma avaliação ainda/);
  assert.match(await (await admin('/admin/avaliacoes')).text(), /Nenhuma avaliação encontrada/);
  for (let index = 0; index < 12; index++) {
    run('INSERT INTO reviews (request_id,rating,comment,created_at) VALUES (?,5,?,?)', [createRequest().id, `Avaliação ${index + 1}`, Date.now() + index]);
  }
  assert.equal(reviewPage(2, '999999').page, 2);
  assert.equal(reviewPage(2, '999999').reviews.length, 2);
  assert.equal(reviewPage(2, '-1').page, 1);
  for (const route of ['/prestadores/2?pagina=2', '/prestador/avaliacoes?pagina=2']) {
    const response = await (route.startsWith('/prestador/') ? provider : guest)(route);
    const html = await response.text();
    assert.match(html, /Página 2 de 2/);
    assert.equal((html.match(/class="review-item"/g) || []).length, 2);
  }
  assert.match(await (await provider('/prestador/avaliacoes')).text(), /Responder/);
  assert.equal((await customer('/prestador/avaliacoes')).status, 302);
  assert.equal((await customer('/admin/avaliacoes')).status, 302);
  run('UPDATE users SET active = 0 WHERE id = 2');
  assert.equal((await guest('/prestadores/2')).status, 404);
  run('UPDATE users SET active = 1 WHERE id = 2');
});

test('Existing completed requests get a single invitation; ratings and replies persist across restart', async () => {
  const unreviewed = createRequest();
  createRequest('pending');
  createRequest('canceled');
  const reviewed = createRequest();
  await publish(reviewed, '2', 'Avaliação persistente.');
  await provider(`${reviewPath(reviewed)}/resposta`, { response: 'Resposta persistente.' });
  run('DELETE FROM schema_migrations WHERE name = ?', ['review-invites-v1']);
  initializeReviews();
  initializeReviews();
  assert.equal(notifications('review_invite').length, 1);
  assert.equal(notifications('review_invite')[0].request_id, unreviewed.id);
  const result = spawnSync(process.execPath, ['-e', "const {db,get}=require('./src/db');const v=get('SELECT rating,comment,response FROM reviews');console.log(JSON.stringify(v));db.close()"], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { rating: 2, comment: 'Avaliação persistente.', response: 'Resposta persistente.' });
});

test('Legacy notification migration preserves data, indexes and sequence while enabling review events', () => {
  const legacyPath = path.join(temporaryDirectory, 'legacy.sqlite');
  const childEnv = { ...process.env, FACILITALAR_DATABASE_PATH: legacyPath };
  const prepare = spawnSync(process.execPath, ['-e', `
    const {db,run}=require('./src/db');
    const user=run("INSERT INTO users(name,email,password_hash,role) VALUES('Cliente','legado@teste.local','unused','customer')").lastInsertRowid;
    const request=run("INSERT INTO service_requests(service_id,customer_id,provider_id,scheduled_date,address,status) VALUES(1,?,2,'2026-10-15T09:00','Teste','completed')",[user]).lastInsertRowid;
    db.exec("DROP TABLE notifications;CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('request','message','quote','quote_response','status')),title TEXT NOT NULL,body TEXT NOT NULL,occurrences INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,read_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    run("INSERT INTO notifications VALUES(44,2,?,'message','Legado','Mensagem preservada',2,3,123,456,789)",[request]);
    run("INSERT INTO notifications VALUES(99,2,?,'status','Apagar','Teste',1,1,NULL,456,789)",[request]);
    run('DELETE FROM notifications WHERE id=99');
    run("DELETE FROM schema_migrations WHERE name='notification-review-kinds-v1'");db.close();
  `], { cwd: path.join(__dirname, '..'), env: childEnv, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr);
  const migrated = spawnSync(process.execPath, ['-e', `require('./app');const {db,get,all}=require('./src/db');console.log(JSON.stringify({legacy:get('SELECT * FROM notifications WHERE id=44'),invite:get("SELECT id FROM notifications WHERE kind='review_invite'"),indexes:all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications'")}));db.close()`], { cwd: path.join(__dirname, '..'), env: childEnv, encoding: 'utf8' });
  assert.equal(migrated.status, 0, migrated.stderr);
  const data = JSON.parse(migrated.stdout.trim());
  assert.equal(data.legacy.body, 'Mensagem preservada');
  assert.equal(data.legacy.version, 3);
  assert.equal(data.legacy.occurrences, 2);
  assert.equal(data.legacy.read_at, 123);
  assert.equal(data.legacy.created_at, 456);
  assert.equal(data.legacy.updated_at, 789);
  assert.ok(data.invite.id > 99);
  assert.ok(data.indexes.some((index) => index.name === 'notifications_message_group'));
});
