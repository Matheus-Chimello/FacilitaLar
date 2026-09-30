const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.FACILITALAR_DATABASE_PATH || path.join(__dirname, '..', 'database', 'facilitalar.sqlite');
const databaseDir = path.dirname(databasePath);

fs.mkdirSync(databaseDir, { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON');

const imageOptions = [
  '/assets/images/faxineira.png',
  '/assets/images/encanador.jpg',
  '/assets/images/eletricista.jpg',
  '/assets/images/baba.jpg',
  '/assets/images/jardineiro.jpg',
  '/assets/images/limpador de piscina.jpg',
  '/assets/images/montador de móveis.jpg',
  '/assets/images/Limpador de Calha.jpg',
];

const imageLabels = ['Limpeza residencial', 'Encanamento', 'Eletricista', 'Cuidados familiares', 'Jardinagem', 'Piscina', 'Montagem de móveis', 'Limpeza de calhas'];

function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'provider', 'customer')),
      phone TEXT,
      city TEXT,
      bio TEXT,
      latitude REAL,
      longitude REAL,
      postal_code TEXT NOT NULL DEFAULT '',
      location_address TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      icon TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      price REAL NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      image TEXT,
      service_area TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS service_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      provider_id INTEGER NOT NULL,
      scheduled_date TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      address TEXT NOT NULL,
      notes TEXT,
      agreed_price REAL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'canceled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS service_requests_provider_schedule ON service_requests(provider_id, scheduled_date, status);

    CREATE TABLE IF NOT EXISTS request_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
      kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'system')),
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS request_messages_thread ON request_messages(request_id, id);

    CREATE TABLE IF NOT EXISTS request_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
      amount REAL NOT NULL CHECK (amount > 0),
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS request_quotes_pending ON request_quotes(request_id) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS provider_hours (
      provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      period INTEGER NOT NULL CHECK (period IN (0, 1)),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      PRIMARY KEY (provider_id, weekday, period)
    );

    CREATE TABLE IF NOT EXISTS provider_days_off (
      provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      PRIMARY KEY (provider_id, date)
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  if (!all('PRAGMA table_info(service_requests)').some((column) => column.name === 'agreed_price')) {
    db.exec('ALTER TABLE service_requests ADD COLUMN agreed_price REAL');
  }
  if (!all('PRAGMA table_info(service_requests)').some((column) => column.name === 'duration_minutes')) {
    db.exec('ALTER TABLE service_requests ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 60');
  }
  if (!all('PRAGMA table_info(services)').some((column) => column.name === 'duration_minutes')) {
    db.exec('ALTER TABLE services ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 60');
  }
  const userColumns = all('PRAGMA table_info(users)');
  for (const [name, type] of [['latitude', 'REAL'], ['longitude', 'REAL'], ['postal_code', "TEXT NOT NULL DEFAULT ''"], ['location_address', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!userColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
}

function seedDatabase() {
  const adminCount = get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").count;

  if (adminCount === 0) {
    run(
      `INSERT INTO users (name, email, password_hash, role, phone, city, bio)
       VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
      [
        'Administrador Facilita Lar',
        'admin@facilitalar.com',
        bcrypt.hashSync('admin123', 10),
        '(17) 99624-6898',
        'Fernandópolis',
        'Conta administrativa inicial do sistema.',
      ]
    );
  }

  const categoryCount = get('SELECT COUNT(*) AS count FROM categories').count;
  if (categoryCount === 0) {
    const categories = [
      ['Limpeza residencial', 'Faxina, organização e limpeza recorrente.', 'fa-home'],
      ['Hidráulica', 'Consertos, vazamentos e instalações hidráulicas.', 'fa-tint'],
      ['Elétrica', 'Instalações, reparos e manutenção elétrica.', 'fa-bolt'],
      ['Cuidados', 'Babysitter, cuidadores e acompanhamento familiar.', 'fa-heart'],
      ['Jardinagem', 'Poda, manutenção e cuidado de áreas verdes.', 'fa-leaf'],
      ['Piscina', 'Limpeza e manutenção de piscinas residenciais.', 'fa-life-ring'],
      ['Montagem', 'Montagem e desmontagem de móveis.', 'fa-wrench'],
    ];

    categories.forEach((category) => {
      run('INSERT INTO categories (name, description, icon) VALUES (?, ?, ?)', category);
    });
  }

  const providerCount = get("SELECT COUNT(*) AS count FROM users WHERE role = 'provider'").count;
  if (providerCount === 0) {
    const providers = [
      ['Ana Silva', 'ana@facilitalar.com', 'provider123', 'Limpeza cuidadosa, pontual e com foco nos detalhes.'],
      ['Carlos Mendes', 'carlos@facilitalar.com', 'provider123', 'Atendimento técnico para reparos residenciais urgentes.'],
      ['Marina Souza', 'marina@facilitalar.com', 'provider123', 'Cuidados familiares com experiência e referências.'],
    ];

    providers.forEach((provider) => {
      run(
        `INSERT INTO users (name, email, password_hash, role, phone, city, bio)
         VALUES (?, ?, ?, 'provider', ?, ?, ?)`,
        [
          provider[0],
          provider[1],
          bcrypt.hashSync(provider[2], 10),
          '(17) 90000-0000',
          'Fernandópolis',
          provider[3],
        ]
      );
    });
  }

  const serviceCount = get('SELECT COUNT(*) AS count FROM services').count;
  if (serviceCount === 0) {
    const ana = get("SELECT id FROM users WHERE email = 'ana@facilitalar.com'");
    const carlos = get("SELECT id FROM users WHERE email = 'carlos@facilitalar.com'");
    const marina = get("SELECT id FROM users WHERE email = 'marina@facilitalar.com'");

    const categoryByName = all('SELECT id, name FROM categories').reduce((acc, category) => {
      acc[category.name] = category.id;
      return acc;
    }, {});

    const services = [
      [ana.id, categoryByName['Limpeza residencial'], 'Faxina residencial completa', 'Limpeza geral de ambientes, organização leve e finalização com checklist.', 120, imageOptions[0], 'Fernandópolis e região'],
      [carlos.id, categoryByName.Hidráulica, 'Reparos hidráulicos', 'Conserto de vazamentos, troca de torneiras, registros e manutenções simples.', 280, imageOptions[1], 'Fernandópolis'],
      [carlos.id, categoryByName.Elétrica, 'Manutenção elétrica residencial', 'Troca de tomadas, luminárias, disjuntores e avaliação de pontos elétricos.', 200, imageOptions[2], 'Fernandópolis'],
      [marina.id, categoryByName.Cuidados, 'Babysitter e cuidador familiar', 'Acompanhamento por hora com atenção, cuidado e comunicação com a família.', 90, imageOptions[3], 'Fernandópolis'],
      [ana.id, categoryByName.Jardinagem, 'Jardinagem residencial', 'Poda leve, limpeza de jardim e manutenção de áreas externas.', 200, imageOptions[4], 'Fernandópolis e região'],
      [carlos.id, categoryByName.Piscina, 'Limpeza de piscina', 'Limpeza, aspiração, tratamento básico e orientação de manutenção.', 280, imageOptions[5], 'Fernandópolis e região'],
    ];

    services.forEach((service) => {
      run(
        `INSERT INTO services
         (provider_id, category_id, title, description, price, image, service_area)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        service
      );
    });
  }
}

function migrateSeedAccents() {
  if (get('SELECT name FROM schema_migrations WHERE name = ?', ['seed-accents-v1'])) return;
  const corrections = [
    ['Limpeza Residencial', 'Limpeza residencial'],
  [
    "Fernandopolis",
    "Fernandópolis"
  ],
  [
    "Faxina, organizacao e limpeza recorrente.",
    "Faxina, organização e limpeza recorrente."
  ],
  [
    "Hidraulica",
    "Hidráulica"
  ],
  [
    "Consertos, vazamentos e instalacoes hidraulicas.",
    "Consertos, vazamentos e instalações hidráulicas."
  ],
  [
    "Eletrica",
    "Elétrica"
  ],
  [
    "Instalacoes, reparos e manutencao eletrica.",
    "Instalações, reparos e manutenção elétrica."
  ],
  [
    "Poda, manutencao e cuidado de areas verdes.",
    "Poda, manutenção e cuidado de áreas verdes."
  ],
  [
    "Limpeza e manutencao de piscinas residenciais.",
    "Limpeza e manutenção de piscinas residenciais."
  ],
  [
    "Montagem e desmontagem de moveis.",
    "Montagem e desmontagem de móveis."
  ],
  [
    "Atendimento tecnico para reparos residenciais urgentes.",
    "Atendimento técnico para reparos residenciais urgentes."
  ],
  [
    "Cuidados familiares com experiencia e referencias.",
    "Cuidados familiares com experiência e referências."
  ],
  [
    "Limpeza geral de ambientes, organizacao leve e finalizacao com checklist.",
    "Limpeza geral de ambientes, organização leve e finalização com checklist."
  ],
  [
    "Fernandopolis e regiao",
    "Fernandópolis e região"
  ],
  [
    "Reparos hidraulicos",
    "Reparos hidráulicos"
  ],
  [
    "Conserto de vazamentos, troca de torneiras, registros e manutencoes simples.",
    "Conserto de vazamentos, troca de torneiras, registros e manutenções simples."
  ],
  [
    "Manutencao eletrica residencial",
    "Manutenção elétrica residencial"
  ],
  [
    "Troca de tomadas, luminarias, disjuntores e avaliacao de pontos eletricos.",
    "Troca de tomadas, luminárias, disjuntores e avaliação de pontos elétricos."
  ],
  [
    "Acompanhamento por hora com atencao, cuidado e comunicacao com a familia.",
    "Acompanhamento por hora com atenção, cuidado e comunicação com a família."
  ],
  [
    "Poda leve, limpeza de jardim e manutencao de areas externas.",
    "Poda leve, limpeza de jardim e manutenção de áreas externas."
  ],
  [
    "Limpeza, aspiracao, tratamento basico e orientacao de manutencao.",
    "Limpeza, aspiração, tratamento básico e orientação de manutenção."
  ]
];
  const fields = [
    ['users', ['city', 'bio']],
    ['categories', ['name', 'description']],
    ['services', ['title', 'description', 'service_area']],
  ];

  // Correct only exact original demo values, preserving customized descriptions.
  transaction(() => {
    for (const [table, columns] of fields) {
      for (const column of columns) {
        for (const [original, corrected] of corrections) {
          const uniqueGuard = table === 'categories' && column === 'name'
            ? ' AND NOT EXISTS (SELECT 1 FROM categories WHERE name = ?)'
            : '';
          run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?${uniqueGuard}`,
            uniqueGuard ? [corrected, original, corrected] : [corrected, original]);
        }
      }
    }
    run('INSERT INTO schema_migrations (name) VALUES (?)', ['seed-accents-v1']);
  });
}

function seedDemoAvailability() {
  if (get('SELECT name FROM schema_migrations WHERE name = ?', ['demo-availability-v1'])) return;
  transaction(() => {
    for (const email of ['ana@facilitalar.com', 'carlos@facilitalar.com', 'marina@facilitalar.com']) {
      const provider = get("SELECT id FROM users WHERE email = ? AND role = 'provider'", [email]);
      if (!provider || get('SELECT 1 FROM provider_hours WHERE provider_id = ? LIMIT 1', [provider.id])) continue;
      for (let weekday = 1; weekday <= 5; weekday += 1) {
        run('INSERT INTO provider_hours (provider_id, weekday, period, start_time, end_time) VALUES (?, ?, 0, ?, ?)', [provider.id, weekday, '08:00', '12:00']);
        run('INSERT INTO provider_hours (provider_id, weekday, period, start_time, end_time) VALUES (?, ?, 1, ?, ?)', [provider.id, weekday, '13:00', '18:00']);
      }
    }
    run('INSERT INTO schema_migrations (name) VALUES (?)', ['demo-availability-v1']);
  });
}

initSchema();
migrateSeedAccents();
seedDatabase();
seedDemoAvailability();

module.exports = {
  db,
  run,
  get,
  all,
  imageOptions,
  imageLabels,
  transaction,
};
