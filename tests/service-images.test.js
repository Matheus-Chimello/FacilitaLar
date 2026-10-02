const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'facilitalar-images-'));
process.env.FACILITALAR_DATABASE_PATH = path.join(directory, 'test.sqlite');
const legacy = new DatabaseSync(process.env.FACILITALAR_DATABASE_PATH);
legacy.exec(`CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, icon TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
legacy.close();
const app = require('../app');
const { db, get, all, run } = require('../src/db');
const { serviceImages, categoryImage, defaultCategoryImage, genericImage } = require('../src/service-images');
let server;
let origin;

function client() {
  let cookie = '';
  let csrf = '';
  return async (route, body) => {
    if (body && !csrf) {
      const page = await fetch(origin + '/', { headers: { Cookie: cookie } });
      cookie = page.headers.getSetCookie()[0]?.split(';')[0] || cookie;
      csrf = (await page.text()).match(/name="csrf-token" content="([a-f0-9]{64})"/)?.[1];
      assert.ok(csrf);
    }
    const response = await fetch(origin + route, {
      method: body ? 'POST' : 'GET', redirect: 'manual', headers: { Cookie: cookie },
      ...(body ? { body: new URLSearchParams({ _csrf: csrf, ...body }) } : {}),
    });
    const nextCookie = response.headers.getSetCookie()[0]?.split(';')[0];
    if (nextCookie && nextCookie !== cookie) {
      cookie = nextCookie;
      csrf = '';
    }
    return response;
  };
}

const provider = client();
const admin = client();
const serviceForm = { title: 'Serviço de teste', description: 'Descrição do atendimento.', price: '180', duration_minutes: '60', service_area: 'Fernandópolis' };

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await provider('/entrar', { email: 'ana@facilitalar.com', password: 'provider123' })).status, 302);
  assert.equal((await admin('/entrar', { email: 'admin@facilitalar.com', password: 'admin123' })).status, 302);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Every market category has a persisted, existing and distinct applicable photo', async () => {
  const categories = all('SELECT * FROM categories');
  assert.equal(categories.length, 29);
  assert.ok(all('PRAGMA table_info(categories)').some(({ name }) => name === 'image'));
  assert.ok(get("SELECT 1 FROM schema_migrations WHERE name = 'category-images-v1'"));
  for (const category of categories) {
    assert.notEqual(category.image, genericImage, category.name);
    assert.equal(category.image, defaultCategoryImage(category.name));
    assert.ok(fs.existsSync(path.join(__dirname, '..', category.image)), category.name);
    assert.equal((await fetch(origin + encodeURI(category.image))).status, 200, category.name);
  }
  assert.equal(new Set(serviceImages.map(({ image }) => image)).size, serviceImages.length);
  assert.equal(defaultCategoryImage(' HIDRAULICA '), '/assets/images/encanador.jpg');
  assert.equal(categoryImage({ name: 'Categoria personalizada', image: 'https://invalid.test/photo.jpg' }), genericImage);
  assert.equal(get('SELECT image FROM services WHERE id = 1').image, '/assets/images/faxineira.png');
});

test('New provider and admin services resolve the correct default without JavaScript', async () => {
  const electrical = get("SELECT * FROM categories WHERE name = 'Elétrica'");
  const painting = get("SELECT * FROM categories WHERE name = 'Pintura'");
  assert.equal((await provider('/prestador/servicos', { ...serviceForm, title: 'Elétrica sem JavaScript', category_id: electrical.id })).status, 302);
  assert.equal(get("SELECT image FROM services WHERE title = 'Elétrica sem JavaScript'").image, electrical.image);
  assert.equal((await admin('/admin/servicos', { ...serviceForm, title: 'Pintura administrativa', provider_id: '2', category_id: painting.id, image: '' })).status, 302);
  assert.equal(get("SELECT image FROM services WHERE title = 'Pintura administrativa'").image, painting.image);
});

test('Create and update reject wrong-category photos, external URLs and forged paths', async () => {
  const category = get("SELECT * FROM categories WHERE name = 'Elétrica'");
  const count = get('SELECT COUNT(*) AS count FROM services').count;
  for (const image of ['/assets/images/jardineiro.jpg', 'https://example.com/image.jpg', '/assets/images/services/../private.jpg']) {
    const response = await provider('/prestador/servicos', { ...serviceForm, category_id: category.id, image });
    assert.equal(response.status, 422);
    assert.match(await response.text(), /imagem correspondente à categoria/);
  }
  assert.equal(get('SELECT COUNT(*) AS count FROM services').count, count);
  const original = get('SELECT * FROM services WHERE id = 1');
  assert.equal((await provider('/prestador/servicos/1', { ...serviceForm, category_id: category.id, image: original.image })).status, 422);
  assert.equal(get('SELECT image FROM services WHERE id = 1').image, original.image);
  assert.equal((await provider('/prestador/servicos/1', { ...serviceForm, category_id: category.id, image: '' })).status, 302);
  assert.equal(get('SELECT image FROM services WHERE id = 1').image, category.image);
  assert.equal((await admin('/admin/servicos', { ...serviceForm, provider_id: '2', category_id: category.id, image: original.image })).status, 422);
});

test('Service forms expose category photos and retain valid images on editing and validation errors', async () => {
  const service = get('SELECT * FROM services WHERE id = 1');
  const category = get('SELECT * FROM categories WHERE id = ?', [service.category_id]);
  const page = await (await provider('/prestador/servicos/1/editar')).text();
  assert.match(page, /data-service-image-picker/);
  assert.match(page, /data-image-preview/);
  assert.match(page, new RegExp(`data-image="${category.image}"`));
  assert.match(page, new RegExp(`value="${service.image}" selected`));
  const response = await provider('/prestador/servicos', { ...serviceForm, category_id: category.id, image: category.image, price: '-1' });
  assert.equal(response.status, 422);
  assert.match(await response.text(), new RegExp(`value="${category.image}" selected`));
  assert.match(await (await admin('/admin/servicos/novo')).text(), /data-service-image-picker/);
});

test('Admin category photo assignments survive renaming and apply to new services only', async () => {
  const category = get("SELECT * FROM categories WHERE name = 'Pintura'");
  const originalService = get("SELECT * FROM services WHERE title = 'Pintura administrativa'");
  const image = defaultCategoryImage('Manutenção geral');
  assert.equal((await admin(`/admin/categorias/${category.id}`, { name: 'Acabamentos personalizados', description: category.description, icon: category.icon, image })).status, 302);
  assert.equal(get('SELECT image FROM categories WHERE id = ?', [category.id]).image, image);
  assert.equal((await provider('/prestador/servicos', { ...serviceForm, title: 'Nova categoria renomeada', category_id: category.id })).status, 302);
  assert.equal(get("SELECT image FROM services WHERE title = 'Nova categoria renomeada'").image, image);
  assert.equal(get('SELECT image FROM services WHERE id = ?', [originalService.id]).image, originalService.image);
  assert.equal((await admin(`/admin/categorias/${category.id}`, { name: 'Outro nome', description: '', icon: 'fa-tag' })).status, 302);
  assert.equal(get('SELECT image FROM categories WHERE id = ?', [category.id]).image, image);
});

test('Custom categories have an administrator-selected photo or a safe general fallback', async () => {
  const image = defaultCategoryImage('Elétrica');
  assert.equal((await admin('/admin/categorias', { name: 'Automação residencial', icon: 'fa-home', description: '', image })).status, 302);
  const category = get("SELECT * FROM categories WHERE name = 'Automação residencial'");
  assert.equal(category.image, image);
  assert.equal((await provider('/prestador/servicos', { ...serviceForm, title: 'Automação cadastrada', category_id: category.id })).status, 302);
  assert.equal(get("SELECT image FROM services WHERE title = 'Automação cadastrada'").image, image);
  assert.equal((await admin('/admin/categorias', { name: 'Categoria sem foto', image: 'https://example.com/image.jpg' })).status, 302);
  assert.equal(get("SELECT image FROM categories WHERE name = 'Categoria sem foto'").image, genericImage);
  run('UPDATE categories SET active = 0 WHERE id = ?', [category.id]);
  assert.equal((await provider('/prestador/servicos', { ...serviceForm, category_id: category.id })).status, 422);
});
