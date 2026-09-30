const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'facilitalar-preview-'));
process.env.FACILITALAR_DATABASE_PATH = path.join(directory, 'preview.sqlite');
const app = require('../app');
const { db, run } = require('../src/db');
const customer = run(`INSERT INTO users (name, email, password_hash, role, city) VALUES (?, ?, ?, 'customer', ?)`,
  ['Cliente de demonstração', 'cliente@preview.local', bcrypt.hashSync('cliente123', 10), 'Fernandópolis']);
run('UPDATE users SET latitude = -20.282, longitude = -50.247 WHERE id = 2');
run('UPDATE users SET latitude = -20.283, longitude = -50.27 WHERE id = 3');
const request = run(`INSERT INTO service_requests (service_id, customer_id, provider_id, scheduled_date, address, notes) VALUES (1, ?, 2, ?, ?, ?)`,
  [customer.lastInsertRowid, '2026-10-15T10:00', 'Endereço de demonstração', 'Combinar a limpeza dos ambientes.']);
run('INSERT INTO request_messages (request_id, sender_id, body) VALUES (?, ?, ?)', [request.lastInsertRowid, customer.lastInsertRowid, 'Olá, Ana! Você tem disponibilidade pela manhã?']);
const server = app.listen(0, () => console.log(`Prévia de testes: http://localhost:${server.address().port}; Solicitação: ${request.lastInsertRowid}`));

function shutdown() {
  server.close(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
