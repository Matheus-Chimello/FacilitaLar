const express = require('express');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const { all, get, run, imageOptions, transaction } = require('./db');
const { categoryImage, defaultCategoryImage, imagesForCategory, genericImage } = require('./service-images');
const { dashboardPath, requireRole, setFlash } = require('./auth');
const { notifyRequestCreated, notifyStatus } = require('./notifications');
const { ratingSummary, reviewPage } = require('./reviews');
const { loginIsLimited, recordLoginFailure, clearLoginFailures, emailRequestAllowed, recordEmailRequest } = require('./security');
const { coordinates, radiusOptions, locationFilter, nearbyServices } = require('./location');
const { CepError, formatCep, lookupCep } = require('./cep');
const { issueVerification, verifyEmail, issuePasswordReset, resetTokenUser, resetPassword } = require('./email-verification');
const {
  weekdays, durationOptions, bookingWindowDays, localNow, dateNumber, withinWindow,
  availabilityFromBody, availableSlots, nextAvailableDate, canConfirm,
} = require('./scheduling');

const router = express.Router();
router.use((req, res, next) => {
  res.locals.categoryImage = categoryImage;
  res.locals.imagesForCategory = imagesForCategory;
  res.locals.imageOptions = imageOptions;
  next();
});
const dummyPasswordHash = bcrypt.hashSync('unregistered-account', 10);
const nextStatuses = {
  pending: ['accepted', 'canceled'],
  accepted: ['in_progress', 'canceled'],
  in_progress: ['completed', 'canceled'],
  completed: [],
  canceled: [],
};

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function serviceQuery({ q, category, includeInactive = false, providerId = null, location = null } = {}) {
  const params = [];
  const where = [];

  if (!includeInactive) {
    where.push('s.active = 1', 'u.active = 1', 'c.active = 1');
  }

  if (providerId) {
    where.push('s.provider_id = ?');
    params.push(providerId);
  }

  if (category) {
    where.push('c.id = ?');
    params.push(category);
  }

  const sql = `
    SELECT
      s.*,
      c.name AS category_name,
      c.icon AS category_icon,
      u.name AS provider_name,
      u.phone AS provider_phone,
      u.city AS provider_city,
      u.bio AS provider_bio,
      u.latitude AS provider_latitude,
      u.longitude AS provider_longitude,
      reputation.average AS provider_rating_average,
      COALESCE(reputation.count, 0) AS provider_rating_count
    FROM services s
    JOIN categories c ON c.id = s.category_id
    JOIN users u ON u.id = s.provider_id
    LEFT JOIN (SELECT r.provider_id, AVG(v.rating) AS average, COUNT(*) AS count FROM reviews v
      JOIN service_requests r ON r.id = v.request_id GROUP BY r.provider_id) reputation ON reputation.provider_id = u.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.created_at DESC
  `;

  const normalize = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const services = all(sql, params).filter((service) => !q || normalize([service.title, service.description, service.provider_name, service.category_name].join(' ')).includes(normalize(q)));
  return nearbyServices(services, location);
}

async function catalogFilters(req) {
  const radius = radiusOptions.includes(Number(req.query.radius)) ? Number(req.query.radius) : 1;
  const cep = String(req.query.cep || '').trim();
  let location = null;
  let locationError = '';
  let locationErrorStatus = 422;
  let locationLabel = '';

  if (cep) {
    try {
      const address = await (req.app.locals.lookupCep || lookupCep)(cep);
      if (!address.point) {
        locationError = 'Este CEP é válido, mas não possui uma posição para a busca por raio. Use sua localização atual.';
      } else {
        location = { ...address.point, radius };
        locationLabel = `Até ${radius} km do CEP ${address.cep}. Distância aproximada em linha reta.`;
      }
    } catch (error) {
      locationError = error instanceof CepError ? error.message : 'Não foi possível consultar o CEP agora. Tente novamente em instantes.';
      locationErrorStatus = error.status || 503;
    }
  } else {
    location = locationFilter(req.query);
    if (!location && (req.query.latitude || req.query.longitude)) locationError = 'Localização inválida. Use novamente sua localização.';
    if (location) locationLabel = `Até ${radius} km de você. Distância em linha reta.`;
  }

  return {
    q: String(req.query.q || '').trim(), category: Number(req.query.category) || null,
    providerId: Number(req.query.prestador) || null, location, cep,
    latitude: cep ? '' : location?.latitude ?? '', longitude: cep ? '' : location?.longitude ?? '',
    radius, locationError, locationErrorStatus, locationLabel,
  };
}

function catalogUrl(filters, changes = {}, pathname = '/') {
  const values = { q: filters.q, category: filters.category, prestador: filters.providerId, cep: filters.cep, latitude: filters.latitude, longitude: filters.longitude, radius: filters.radius, ...changes };
  const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([key, value]) => [key, String(value)]));
  return `${pathname}?${query}`;
}

function findService(id, includeInactive = false) {
  const services = serviceQuery({ includeInactive });
  return services.find((service) => Number(service.id) === Number(id));
}

function activeCategories() {
  return all('SELECT * FROM categories WHERE active = 1 ORDER BY name');
}

function renderWithForm(res, view, data = {}) {
  return res.render(view, { form: {}, ...data });
}

function requestFormData(service, values = {}) {
  const today = localNow().date;
  const date = values.date || nextAvailableDate(service) || today;
  return {
    title: 'Solicitar serviço', service,
    form: { ...values, date },
    slots: availableSlots(service, date),
    minDate: today,
    maxDate: new Date(dateNumber(today) + bookingWindowDays * 86400000).toISOString().slice(0, 10),
  };
}

function agendaPageData(providerId, form = null) {
  const hours = all('SELECT * FROM provider_hours WHERE provider_id = ?', [providerId]);
  const values = form || Object.fromEntries(hours.flatMap((period) => [
    [`start_${period.weekday}_${period.period}`, period.start_time],
    [`end_${period.weekday}_${period.period}`, period.end_time],
  ]));
  const blockedDays = all('SELECT date FROM provider_days_off WHERE provider_id = ? AND date >= ? ORDER BY date', [providerId, localNow().date]);
  const upcoming = all(`SELECT r.*, s.title AS service_title, u.name AS customer_name
    FROM service_requests r JOIN services s ON s.id = r.service_id
    JOIN users u ON u.id = r.customer_id
    WHERE r.provider_id = ? AND substr(r.scheduled_date, 1, 10) >= ?
      AND r.status IN ('pending', 'accepted', 'in_progress')
    ORDER BY r.scheduled_date LIMIT 30`, [providerId, localNow().date]);
  const minDate = localNow().date;
  return {
    title: 'Minha agenda', weekdays, form: values, blockedDays, upcoming, minDate,
    maxOffDate: new Date(dateNumber(minDate) + 365 * 86400000).toISOString().slice(0, 10),
  };
}

router.get(['/index.html', '/products.html'], (req, res) => res.redirect('/'));
router.get('/about.html', (req, res) => res.redirect('/sobre'));
router.get('/contact.html', (req, res) => res.redirect('/contato'));

router.get('/', async (req, res) => {
  const filters = await catalogFilters(req);
  const categories = activeCategories();
  const services = filters.locationError ? [] : serviceQuery(filters);
  res.status(filters.locationError ? filters.locationErrorStatus : 200).render('home', {
    title: 'Serviços',
    services,
    categories,
    filters, radiusOptions,
    categoryUrl: (category) => catalogUrl(filters, { category }),
    selectedProvider: filters.providerId ? get("SELECT name FROM users WHERE id = ? AND role = 'provider'", [filters.providerId]) : null,
    servicesUrl: catalogUrl(filters),
    providersUrl: catalogUrl(filters, { prestador: null }, '/prestadores'),
  });
});

router.get('/prestadores', async (req, res) => {
  const filters = await catalogFilters(req);
  const providers = new Map();
  for (const service of filters.locationError ? [] : serviceQuery(filters)) {
    if (!providers.has(service.provider_id)) providers.set(service.provider_id, {
      id: service.provider_id, name: service.provider_name, city: service.provider_city,
      bio: service.provider_bio, image: service.image, distance: service.distance, services: [],
      rating_average: service.provider_rating_average, rating_count: service.provider_rating_count,
    });
    providers.get(service.provider_id).services.push(service);
  }
  res.status(filters.locationError ? filters.locationErrorStatus : 200).render('providers', {
    title: 'Prestadores', providers: [...providers.values()], filters, radiusOptions,
    categories: activeCategories(), providerUrl: (id) => catalogUrl(filters, { prestador: id }),
    servicesUrl: catalogUrl(filters), providersUrl: catalogUrl(filters, {}, '/prestadores'),
  });
});

router.get('/prestadores/:id', (req, res) => {
  const id = Number(req.params.id);
  const provider = Number.isSafeInteger(id) && id > 0 ? get("SELECT id, name, city, bio FROM users WHERE id = ? AND role = 'provider' AND active = 1", [id]) : null;
  if (!provider) return res.status(404).render('error', { title: 'Prestador não encontrado', message: 'Este prestador não está disponível.' });
  res.render('provider-profile', { title: provider.name, provider, services: serviceQuery({ providerId: id }), ...reviewPage(id, req.query.pagina) });
});

router.get('/sobre', (req, res) => {
  res.render('about', { title: 'Sobre' });
});

router.get('/contato', (req, res) => {
  res.render('contact', { title: 'Contato' });
});

router.get('/servicos/:id', (req, res) => {
  const service = findService(req.params.id);

  if (!service) {
    setFlash(req, 'warning', 'Serviço não encontrado ou indisponível.');
    return res.redirect('/');
  }

  const related = serviceQuery({ category: service.category_id })
    .filter((item) => item.id !== service.id)
    .slice(0, 3);

  return res.render('service-detail', {
    title: service.title,
    service,
    related,
  });
});

router.get('/servicos/:id/horarios', (req, res) => {
  const service = findService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Serviço indisponível.' });
  const date = String(req.query.date || '');
  res.set('Cache-Control', 'no-store');
  if (!withinWindow(date)) return res.status(422).json({ error: 'Escolha uma data dentro dos próximos 60 dias.' });
  return res.json({ date, slots: availableSlots(service, date), durationMinutes: service.duration_minutes });
});

router.get('/entrar', (req, res) => {
  if (req.user) return res.redirect(dashboardPath(req.user.role));
  const providerEntry = req.query.perfil === 'prestador';
  return renderWithForm(res, 'login', { title: 'Entrar', providerEntry });
});

router.post('/entrar', (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const providerEntry = req.query.perfil === 'prestador';
  const ip = req.ip || 'unknown';
  if (loginIsLimited(ip, email)) {
    setFlash(req, 'danger', 'Muitas tentativas de acesso. Aguarde alguns minutos antes de tentar novamente.');
    return res.status(429).render('login', { title: 'Entrar', form: { email }, providerEntry });
  }
  const user = email.length <= 254 && validator.isEmail(email, { allow_utf8_local_part: false })
    ? get('SELECT * FROM users WHERE email = ?', [email]) : null;
  const passwordMatches = bcrypt.compareSync(password, user?.password_hash || dummyPasswordHash);

  if (!user || !user.active || password.length > 128 || !passwordMatches) {
    recordLoginFailure(ip, email);
    setFlash(req, 'danger', 'E-mail ou senha inválidos.');
    return res.status(401).render('login', {
      title: 'Entrar',
      form: { email },
      providerEntry,
    });
  }

  clearLoginFailures(ip, email);
  if (!user.email_verified_at) {
    setFlash(req, 'warning', 'Confirme seu e-mail antes de entrar.');
    return res.redirect(`/verificacao-pendente?email=${encodeURIComponent(email)}`);
  }
  return req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.userId = user.id;
    setFlash(req, 'success', `Olá, ${user.name}.`);
    return res.redirect(dashboardPath(user.role));
  });
});

router.get(['/cadastro', '/anunciar'], (req, res) => {
  if (req.user) return res.redirect(dashboardPath(req.user.role));
  const providerEntry = req.path === '/anunciar' || req.query.perfil === 'prestador';
  return renderWithForm(res, 'register', { title: 'Cadastro', providerEntry, form: { role: providerEntry ? 'provider' : 'customer' } });
});

router.post('/cadastro', async (req, res) => {
  const providerEntry = req.query.perfil === 'prestador';
  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const role = req.body.role === 'provider' ? 'provider' : 'customer';
  const phone = String(req.body.phone || '').trim();
  const city = String(req.body.city || '').trim();
  const bio = String(req.body.bio || '').trim();

  const form = { name, email, role, phone, city, bio };

  if (!name || name.length > 120 || email.length > 254 || !validator.isEmail(email, { allow_utf8_local_part: false }) || password.length < 12 || password.length > 128) {
    setFlash(req, 'danger', 'Informe nome, e-mail válido e uma senha entre 12 e 128 caracteres.');
    return res.status(422).render('register', { title: 'Cadastro', form, providerEntry });
  }
  if (!emailRequestAllowed(req.ip || 'unknown')) {
    setFlash(req, 'warning', 'Muitos cadastros foram solicitados. Tente novamente mais tarde.');
    return res.status(429).render('register', { title: 'Cadastro', form, providerEntry });
  }

  const existing = get('SELECT id, email_verified_at FROM users WHERE email = ?', [email]);
  if (existing) {
    setFlash(req, 'warning', 'Se esta conta ainda não foi confirmada, solicite um novo link de verificação.');
    return res.redirect(`/verificacao-pendente?email=${encodeURIComponent(email)}`);
  }

  const result = run(
    `INSERT INTO users (name, email, password_hash, role, phone, city, bio)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, email, bcrypt.hashSync(password, 10), role, phone, city, bio]
  );

  recordEmailRequest(req.ip || 'unknown');
  try {
    const devUrl = await issueVerification(result.lastInsertRowid, email, req.app.locals.sendVerificationEmail);
    if (devUrl) req.session.devVerification = { email, url: devUrl };
    setFlash(req, 'success', 'Cadastro recebido. Confirme seu e-mail para acessar a conta.');
  } catch (error) {
    console.error('Falha ao enviar confirmação de e-mail:', error);
    setFlash(req, 'warning', 'A conta foi criada, mas não foi possível enviar o link. Tente reenviá-lo em instantes.');
  }
  return res.redirect(`/verificacao-pendente?email=${encodeURIComponent(email)}`);
});

router.get('/verificacao-pendente', (req, res) => {
  const email = normalizeEmail(req.query.email);
  const devUrl = !res.locals.isProduction && req.session.devVerification?.email === email
    ? req.session.devVerification.url : null;
  res.render('verification-pending', { title: 'Confirme seu e-mail', email, devUrl });
});

router.post('/reenviar-verificacao', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const ip = req.ip || 'unknown';
  if (!emailRequestAllowed(ip)) {
    setFlash(req, 'warning', 'Muitas solicitações de e-mail. Tente novamente mais tarde.');
    return res.redirect(`/verificacao-pendente?email=${encodeURIComponent(email)}`);
  }
  recordEmailRequest(ip);
  const user = validator.isEmail(email, { allow_utf8_local_part: false })
    ? get('SELECT id, email_verified_at FROM users WHERE email = ?', [email]) : null;
  const last = user && get('SELECT sent_at FROM email_verification_tokens WHERE user_id = ?', [user.id]);
  if (user && !user.email_verified_at && (!last || last.sent_at <= Date.now() - 60_000)) {
    try {
      const devUrl = await issueVerification(user.id, email, req.app.locals.sendVerificationEmail);
      if (devUrl) req.session.devVerification = { email, url: devUrl };
    } catch (error) {
      console.error('Falha ao reenviar confirmação de e-mail:', error);
    }
  }
  setFlash(req, 'success', 'Se houver uma conta pendente para este e-mail, o link de confirmação será enviado.');
  return res.redirect(`/verificacao-pendente?email=${encodeURIComponent(email)}`);
});

router.get('/verificar-email', (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  if (!verifyEmail(req.query.token)) {
    setFlash(req, 'warning', 'Este link é inválido ou expirou. Solicite um novo.');
    return res.redirect('/verificacao-pendente');
  }
  delete req.session.devVerification;
  setFlash(req, 'success', 'E-mail confirmado. Agora você pode entrar.');
  return res.redirect('/entrar');
});

router.get('/esqueci-senha', (req, res) => {
  const email = normalizeEmail(req.query.email);
  const devUrl = !res.locals.isProduction && req.session.devReset?.email === email ? req.session.devReset.url : null;
  return res.render('forgot-password', { title: 'Redefinir senha', email, devUrl });
});

router.post('/esqueci-senha', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const ip = req.ip || 'unknown';
  if (!emailRequestAllowed(ip)) {
    setFlash(req, 'warning', 'Muitas solicitações de e-mail. Tente novamente mais tarde.');
    return res.redirect('/esqueci-senha');
  }
  recordEmailRequest(ip);
  const user = validator.isEmail(email, { allow_utf8_local_part: false })
    ? get('SELECT id, email_verified_at FROM users WHERE email = ?', [email]) : null;
  const last = user && get('SELECT sent_at FROM password_reset_tokens WHERE user_id = ?', [user.id]);
  if (user?.email_verified_at && (!last || last.sent_at <= Date.now() - 60_000)) {
    try {
      const devUrl = await issuePasswordReset(user.id, email, req.app.locals.sendPasswordResetEmail);
      if (devUrl) req.session.devReset = { email, url: devUrl };
    } catch (error) {
      console.error('Falha ao enviar redefinição de senha:', error);
    }
  }
  setFlash(req, 'success', 'Se houver uma conta confirmada com este e-mail, enviaremos um link de redefinição.');
  return res.redirect(`/esqueci-senha?email=${encodeURIComponent(email)}`);
});

router.get('/redefinir-senha', (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');
  const token = String(req.query.token || '');
  if (!resetTokenUser(token)) {
    setFlash(req, 'warning', 'Este link é inválido ou expirou. Solicite um novo.');
    return res.redirect('/esqueci-senha');
  }
  return res.render('reset-password', { title: 'Nova senha', token });
});

router.post('/redefinir-senha', (req, res, next) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 12 || password.length > 128 || password !== req.body.confirm_password) {
    setFlash(req, 'danger', 'Use uma senha entre 12 e 128 caracteres e confirme-a corretamente.');
    return res.status(422).render('reset-password', { title: 'Nova senha', token });
  }
  if (!resetPassword(token, password)) {
    setFlash(req, 'warning', 'Este link é inválido ou expirou. Solicite um novo.');
    return res.redirect('/esqueci-senha');
  }
  return req.session.regenerate((error) => {
    if (error) return next(error);
    setFlash(req, 'success', 'Senha atualizada. Entre novamente com a nova senha.');
    return res.redirect('/entrar');
  });
});

router.post('/sair', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('facilitalar.sid');
    return res.redirect('/');
  });
});

router.get('/contratante', requireRole('customer'), (req, res) => {
  const requests = all(
    `SELECT r.*, s.title AS service_title, s.image, COALESCE(r.agreed_price, s.price) AS price, u.name AS provider_name, u.phone AS provider_phone,
       (SELECT COUNT(*) FROM request_messages m WHERE m.request_id = r.id AND m.sender_id != r.customer_id AND m.read_at IS NULL) AS unread_count,
       v.id AS review_id, v.rating AS review_rating
     FROM service_requests r
     JOIN services s ON s.id = r.service_id
     JOIN users u ON u.id = r.provider_id
     LEFT JOIN reviews v ON v.request_id = r.id
     WHERE r.customer_id = ?
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );

  const stats = {
    open: requests.filter((request) => ['pending', 'accepted', 'in_progress'].includes(request.status)).length,
    completed: requests.filter((request) => request.status === 'completed').length,
    canceled: requests.filter((request) => request.status === 'canceled').length,
  };

  res.render('customer/dashboard', {
    title: 'Painel do contratante',
    requests,
    stats,
  });
});

router.get('/contratante/solicitar/:serviceId', requireRole('customer'), (req, res) => {
  const service = findService(req.params.serviceId);

  if (!service) {
    setFlash(req, 'warning', 'Serviço indisponível.');
    return res.redirect('/');
  }

  return res.render('customer/request-form', requestFormData(service, { date: String(req.query.date || '') }));
});

router.post('/contratante/solicitar/:serviceId', requireRole('customer'), (req, res) => {
  const service = findService(req.params.serviceId);

  if (!service) {
    setFlash(req, 'warning', 'Serviço indisponível.');
    return res.redirect('/');
  }

  const date = String(req.body.date || '').trim();
  const time = String(req.body.time || '').trim();
  const address = String(req.body.address || '').trim();
  const notes = String(req.body.notes || '').trim();
  const form = { date, time, address, notes };

  if (!withinWindow(date) || !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(time) || !address || address.length > 200 || notes.length > 2000) {
    setFlash(req, 'danger', 'Escolha uma data e um horário disponíveis e informe um endereço de até 200 caracteres.');
    return res.status(422).render('customer/request-form', requestFormData(service, form));
  }

  const result = transaction(() => {
    const current = get(`SELECT s.id, s.provider_id, s.duration_minutes FROM services s
      JOIN users u ON u.id = s.provider_id JOIN categories c ON c.id = s.category_id
      WHERE s.id = ? AND s.active = 1 AND u.active = 1 AND c.active = 1`, [service.id]);
    if (!current || !availableSlots(current, date).includes(time)) return false;
    const inserted = run(`INSERT INTO service_requests (service_id, customer_id, provider_id, scheduled_date, duration_minutes, address, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [service.id, req.user.id, service.provider_id, `${date}T${time}`, current.duration_minutes, address, notes]);
    notifyRequestCreated({ id: inserted.lastInsertRowid, provider_id: current.provider_id, service_title: service.title }, req.user.name);
    return true;
  });
  if (!result) {
    setFlash(req, 'warning', 'Este horário não está mais disponível. Escolha outro horário.');
    return res.status(409).render('customer/request-form', requestFormData(service, form));
  }

  setFlash(req, 'success', 'Horário solicitado. Aguarde a confirmação do prestador.');
  return res.redirect('/contratante');
});

router.post('/contratante/solicitacoes/:id/cancelar', requireRole('customer'), (req, res) => {
  const canceled = transaction(() => {
    const request = get('SELECT * FROM service_requests WHERE id = ? AND customer_id = ?', [req.params.id, req.user.id]);
    if (!request || ['completed', 'canceled'].includes(request.status)) return false;
    run("UPDATE service_requests SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [request.id]);
    run("UPDATE request_quotes SET status = 'superseded', responded_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'pending'", [request.id]);
    run("INSERT INTO request_messages (request_id, sender_id, body, kind) VALUES (?, ?, ?, 'system')", [request.id, req.user.id, 'Atendimento cancelado pelo cliente.']);
    notifyStatus(request, req.user.id, 'canceled');
    return true;
  });
  if (!canceled) {
    setFlash(req, 'warning', 'Esta solicitação não pode ser cancelada.');
    return res.redirect('/contratante');
  }

  setFlash(req, 'success', 'Solicitação cancelada.');
  return res.redirect('/contratante');
});

router.get('/prestador', requireRole('provider'), (req, res) => {
  const services = serviceQuery({ includeInactive: true, providerId: req.user.id });
  const requests = all(
    `SELECT r.*, s.title AS service_title, s.image, COALESCE(r.agreed_price, s.price) AS price, u.name AS customer_name, u.phone AS customer_phone,
       (SELECT COUNT(*) FROM request_messages m WHERE m.request_id = r.id AND m.sender_id != r.provider_id AND m.read_at IS NULL) AS unread_count
     FROM service_requests r
     JOIN services s ON s.id = r.service_id
     JOIN users u ON u.id = r.customer_id
     WHERE r.provider_id = ?
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );

  const stats = {
    services: services.length,
    activeServices: services.filter((service) => service.active).length,
    pending: requests.filter((request) => request.status === 'pending').length,
    completed: requests.filter((request) => request.status === 'completed').length,
  };

  res.render('provider/dashboard', {
    title: 'Painel do prestador',
    services,
    requests,
    stats,
    hasAvailability: Boolean(get('SELECT 1 FROM provider_hours WHERE provider_id = ? LIMIT 1', [req.user.id])),
    reputation: ratingSummary(req.user.id),
  });
});

router.get('/prestador/agenda', requireRole('provider'), (req, res) => {
  res.render('provider/agenda', agendaPageData(req.user.id));
});

router.post('/prestador/agenda', requireRole('provider'), (req, res) => {
  const parsed = availabilityFromBody(req.body);
  if (parsed.error) {
    setFlash(req, 'danger', parsed.error);
    return res.status(422).render('provider/agenda', agendaPageData(req.user.id, req.body));
  }
  transaction(() => {
    run('DELETE FROM provider_hours WHERE provider_id = ?', [req.user.id]);
    for (const period of parsed.periods) {
      run('INSERT INTO provider_hours (provider_id, weekday, period, start_time, end_time) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, period.weekday, period.period, period.start_time, period.end_time]);
    }
  });
  setFlash(req, 'success', 'Horários da agenda atualizados.');
  return res.redirect('/prestador/agenda');
});

router.post('/prestador/agenda/bloqueios', requireRole('provider'), (req, res) => {
  const date = String(req.body.date || '').trim();
  if (!withinWindow(date, 365)) {
    setFlash(req, 'danger', 'Escolha uma data futura dentro de um ano.');
    return res.redirect('/prestador/agenda');
  }
  const blocked = transaction(() => {
    const active = get(`SELECT 1 FROM service_requests WHERE provider_id = ?
      AND substr(scheduled_date, 1, 10) = ? AND status IN ('pending', 'accepted', 'in_progress') LIMIT 1`, [req.user.id, date]);
    if (active) return false;
    run('INSERT OR IGNORE INTO provider_days_off (provider_id, date) VALUES (?, ?)', [req.user.id, date]);
    return true;
  });
  if (!blocked) {
    setFlash(req, 'warning', 'Há um atendimento nesse dia. Resolva a solicitação antes de bloquear a data.');
    return res.redirect('/prestador/agenda');
  }
  setFlash(req, 'success', 'Dia bloqueado na agenda.');
  return res.redirect('/prestador/agenda');
});

router.post('/prestador/agenda/bloqueios/:date/remover', requireRole('provider'), (req, res) => {
  if (dateNumber(req.params.date) !== null) run('DELETE FROM provider_days_off WHERE provider_id = ? AND date = ?', [req.user.id, req.params.date]);
  setFlash(req, 'success', 'Bloqueio removido.');
  return res.redirect('/prestador/agenda');
});

router.get('/prestador/servicos/novo', requireRole('provider'), (req, res) => {
  renderWithForm(res, 'provider/service-form', {
    title: 'Novo serviço',
    service: null,
    categories: activeCategories(),
    imageOptions,
    durationOptions,
  });
});

router.get('/prestador/localizacao', requireRole('provider'), (req, res) => {
  res.render('account/location', { title: 'Minha localização', form: req.user });
});

router.post('/prestador/localizacao', requireRole('provider'), async (req, res) => {
  const postalCode = String(req.body.postal_code || '').trim();
  const locationAddress = String(req.body.location_address || '').trim();
  if (!formatCep(postalCode) || locationAddress.length > 200) {
    setFlash(req, 'danger', 'Informe um CEP válido com 8 dígitos e uma referência de até 200 caracteres.');
    return res.status(422).render('account/location', { title: 'Minha localização', form: req.body });
  }

  let address;
  try {
    address = await (req.app.locals.lookupCep || lookupCep)(postalCode);
  } catch (error) {
    setFlash(req, 'danger', error instanceof CepError ? error.message : 'Não foi possível consultar o CEP agora. Tente novamente em instantes.');
    return res.status(error.status || 503).render('account/location', { title: 'Minha localização', form: req.body });
  }

  const point = coordinates(req.body.latitude, req.body.longitude) || address.point;
  if (!point) {
    setFlash(req, 'danger', 'O CEP é válido, mas não possui posição para a busca por raio. Use sua localização atual e tente salvar novamente.');
    return res.status(422).render('account/location', { title: 'Minha localização', form: req.body });
  }

  run('UPDATE users SET latitude = ?, longitude = ?, postal_code = ?, location_address = ?, city = ? WHERE id = ?', [point.latitude, point.longitude, address.cep, locationAddress, address.city, req.user.id]);
  setFlash(req, 'success', 'Localização salva. Seus serviços estão disponíveis na busca por proximidade.');
  return res.redirect('/prestador');
});

router.post('/prestador/localizacao/remover', requireRole('provider'), (req, res) => {
  run("UPDATE users SET latitude = NULL, longitude = NULL, postal_code = '', location_address = '' WHERE id = ?", [req.user.id]);
  setFlash(req, 'success', 'Localização removida.');
  return res.redirect('/prestador/localizacao');
});

router.post('/prestador/servicos', requireRole('provider'), (req, res) => {
  const form = serviceFormData(req.body);

  const error = validateService(form);
  if (error) {
    setFlash(req, 'danger', error);
    return res.status(422).render('provider/service-form', {
      title: 'Novo serviço',
      service: null,
      categories: activeCategories(),
      imageOptions,
      durationOptions,
      form,
    });
  }

  run(
    `INSERT INTO services (provider_id, category_id, title, description, price, duration_minutes, image, service_area)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, form.category_id, form.title, form.description, form.price, form.duration_minutes, form.image, form.service_area]
  );

  setFlash(req, 'success', 'Serviço cadastrado.');
  return res.redirect('/prestador');
});

router.get('/prestador/servicos/:id/editar', requireRole('provider'), (req, res) => {
  const service = get('SELECT * FROM services WHERE id = ? AND provider_id = ?', [req.params.id, req.user.id]);

  if (!service) {
    setFlash(req, 'warning', 'Serviço não encontrado.');
    return res.redirect('/prestador');
  }

  return res.render('provider/service-form', {
    title: 'Editar serviço',
    service,
    categories: activeCategories(),
    imageOptions,
    durationOptions,
    form: service,
  });
});

router.post('/prestador/servicos/:id', requireRole('provider'), (req, res) => {
  const service = get('SELECT * FROM services WHERE id = ? AND provider_id = ?', [req.params.id, req.user.id]);

  if (!service) {
    setFlash(req, 'warning', 'Serviço não encontrado.');
    return res.redirect('/prestador');
  }

  const form = serviceFormData(req.body);

  const error = validateService(form);
  if (error) {
    setFlash(req, 'danger', error);
    return res.status(422).render('provider/service-form', {
      title: 'Editar serviço',
      service,
      categories: activeCategories(),
      imageOptions,
      durationOptions,
      form,
    });
  }

  run(
    `UPDATE services
     SET category_id = ?, title = ?, description = ?, price = ?, duration_minutes = ?, image = ?, service_area = ?
     WHERE id = ? AND provider_id = ?`,
    [form.category_id, form.title, form.description, form.price, form.duration_minutes, form.image, form.service_area, service.id, req.user.id]
  );

  setFlash(req, 'success', 'Serviço atualizado.');
  return res.redirect('/prestador');
});

router.post('/prestador/servicos/:id/status', requireRole('provider'), (req, res) => {
  const service = get('SELECT * FROM services WHERE id = ? AND provider_id = ?', [req.params.id, req.user.id]);

  if (service) {
    run('UPDATE services SET active = ? WHERE id = ? AND provider_id = ?', [service.active ? 0 : 1, service.id, req.user.id]);
    setFlash(req, 'success', service.active ? 'Serviço pausado.' : 'Serviço ativado.');
  }

  return res.redirect('/prestador');
});

router.post('/prestador/solicitacoes/:id/status', requireRole('provider'), (req, res) => {
  updateRequestStatus(req, res, 'provider');
});

router.get('/admin', requireRole('admin'), (req, res) => {
  const stats = {
    users: get('SELECT COUNT(*) AS count FROM users').count,
    providers: get("SELECT COUNT(*) AS count FROM users WHERE role = 'provider'").count,
    services: get('SELECT COUNT(*) AS count FROM services').count,
    requests: get('SELECT COUNT(*) AS count FROM service_requests').count,
  };

  const recentRequests = all(
    `SELECT r.*, s.title AS service_title, provider.name AS provider_name, customer.name AS customer_name
     FROM service_requests r
     JOIN services s ON s.id = r.service_id
     JOIN users provider ON provider.id = r.provider_id
     JOIN users customer ON customer.id = r.customer_id
     ORDER BY r.created_at DESC
     LIMIT 8`
  );

  res.render('admin/dashboard', {
    title: 'Administração',
    stats,
    recentRequests,
  });
});

router.get('/admin/usuarios', requireRole('admin'), (req, res) => {
  const users = all('SELECT id, name, email, role, phone, city, active, created_at FROM users ORDER BY created_at DESC');
  res.render('admin/users', { title: 'Usuários', users });
});

router.post('/admin/usuarios/:id/status', requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === Number(req.user.id)) {
    setFlash(req, 'warning', 'Você não pode desativar sua própria conta.');
    return res.redirect('/admin/usuarios');
  }

  const user = get('SELECT id, active FROM users WHERE id = ?', [req.params.id]);
  if (user) {
    run('UPDATE users SET active = ? WHERE id = ?', [user.active ? 0 : 1, user.id]);
    setFlash(req, 'success', user.active ? 'Usuário desativado.' : 'Usuário ativado.');
  }

  return res.redirect('/admin/usuarios');
});

router.get('/admin/categorias', requireRole('admin'), (req, res) => {
  const categories = all('SELECT * FROM categories ORDER BY name');
  res.render('admin/categories', {
    title: 'Categorias',
    categories,
    editing: null,
    form: {},
  });
});

router.post('/admin/categorias', requireRole('admin'), (req, res) => {
  const form = categoryFormData(req.body);

  if (!form.name) {
    setFlash(req, 'danger', 'Informe o nome da categoria.');
    const categories = all('SELECT * FROM categories ORDER BY name');
    return res.status(422).render('admin/categories', {
      title: 'Categorias',
      categories,
      editing: null,
      form,
    });
  }

  run('INSERT INTO categories (name, description, icon, image) VALUES (?, ?, ?, ?)', [form.name, form.description, form.icon, form.image]);
  setFlash(req, 'success', 'Categoria cadastrada.');
  return res.redirect('/admin/categorias');
});

router.get('/admin/categorias/:id/editar', requireRole('admin'), (req, res) => {
  const categories = all('SELECT * FROM categories ORDER BY name');
  const editing = get('SELECT * FROM categories WHERE id = ?', [req.params.id]);

  if (!editing) {
    setFlash(req, 'warning', 'Categoria não encontrada.');
    return res.redirect('/admin/categorias');
  }

  return res.render('admin/categories', {
    title: 'Editar categoria',
    categories,
    editing,
    form: editing,
  });
});

router.post('/admin/categorias/:id', requireRole('admin'), (req, res) => {
  const category = get('SELECT * FROM categories WHERE id = ?', [req.params.id]);

  if (!category) {
    setFlash(req, 'warning', 'Categoria não encontrada.');
    return res.redirect('/admin/categorias');
  }

  const form = categoryFormData(req.body, category);
  run('UPDATE categories SET name = ?, description = ?, icon = ?, image = ? WHERE id = ?', [
    form.name,
    form.description,
    form.icon,
    form.image,
    category.id,
  ]);
  setFlash(req, 'success', 'Categoria atualizada.');
  return res.redirect('/admin/categorias');
});

router.post('/admin/categorias/:id/status', requireRole('admin'), (req, res) => {
  const category = get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
  if (category) {
    run('UPDATE categories SET active = ? WHERE id = ?', [category.active ? 0 : 1, category.id]);
    setFlash(req, 'success', category.active ? 'Categoria desativada.' : 'Categoria ativada.');
  }
  return res.redirect('/admin/categorias');
});

router.get('/admin/servicos', requireRole('admin'), (req, res) => {
  const services = serviceQuery({ includeInactive: true });
  res.render('admin/services', { title: 'Serviços', services });
});

router.get('/admin/servicos/novo', requireRole('admin'), (req, res) => {
  res.render('provider/service-form', {
    title: 'Novo serviço', service: null, form: {}, categories: activeCategories(), imageOptions, durationOptions,
    providers: all("SELECT id, name FROM users WHERE role = 'provider' AND active = 1 ORDER BY name"),
  });
});

router.post('/admin/servicos', requireRole('admin'), (req, res) => {
  const form = serviceFormData(req.body);
  const provider = get("SELECT id FROM users WHERE id = ? AND role = 'provider' AND active = 1", [form.provider_id]);
  const error = validateService(form) || (!provider ? 'Selecione um prestador ativo para cadastrar o serviço.' : null);
  if (error) {
    setFlash(req, 'danger', error);
    return res.status(422).render('provider/service-form', {
      title: 'Novo serviço', service: null, form, categories: activeCategories(), imageOptions, durationOptions,
      providers: all("SELECT id, name FROM users WHERE role = 'provider' AND active = 1 ORDER BY name"),
    });
  }

  run(`INSERT INTO services (provider_id, category_id, title, description, price, duration_minutes, image, service_area)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [provider.id, form.category_id, form.title, form.description, form.price, form.duration_minutes, form.image, form.service_area]);
  setFlash(req, 'success', 'Serviço cadastrado com sucesso.');
  return res.redirect('/admin/servicos');
});

router.post('/admin/servicos/:id/status', requireRole('admin'), (req, res) => {
  const service = get('SELECT * FROM services WHERE id = ?', [req.params.id]);
  if (service) {
    run('UPDATE services SET active = ? WHERE id = ?', [service.active ? 0 : 1, service.id]);
    setFlash(req, 'success', service.active ? 'Serviço desativado.' : 'Serviço ativado.');
  }
  return res.redirect('/admin/servicos');
});

router.get('/admin/solicitacoes', requireRole('admin'), (req, res) => {
  const requests = all(
    `SELECT r.*, s.title AS service_title, provider.name AS provider_name, customer.name AS customer_name
     FROM service_requests r
     JOIN services s ON s.id = r.service_id
     JOIN users provider ON provider.id = r.provider_id
     JOIN users customer ON customer.id = r.customer_id
     ORDER BY r.created_at DESC`
  );
  res.render('admin/requests', { title: 'Solicitações', requests, nextStatuses });
});

router.post('/admin/solicitacoes/:id/status', requireRole('admin'), (req, res) => {
  updateRequestStatus(req, res, 'admin');
});

function serviceFormData(body) {
  return {
    provider_id: Number(body.provider_id || 0),
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    category_id: Number(body.category_id || 0),
    price: Number(String(body.price || '').replace(',', '.')),
    duration_minutes: Number(body.duration_minutes || 60),
    image: String(body.image || '').trim(),
    service_area: String(body.service_area || '').trim(),
  };
}

function validateService(form) {
  if (!form.title || !form.description || !form.service_area) {
    return 'Preencha título, descrição e área de atendimento.';
  }
  if (!Number.isFinite(form.price) || form.price < 0.01 || form.price > 1000000) {
    return 'Informe um preço entre R$ 0,01 e R$ 1.000.000,00.';
  }
  if (!durationOptions.includes(form.duration_minutes)) return 'Escolha uma duração válida para o serviço.';
  const category = Number.isSafeInteger(form.category_id) && get('SELECT * FROM categories WHERE id = ? AND active = 1', [form.category_id]);
  if (!category) {
    return 'Selecione uma categoria ativa.';
  }
  if (form.image && !imagesForCategory(category).includes(form.image)) {
    return 'Escolha uma imagem correspondente à categoria selecionada.';
  }
  form.image = form.image || categoryImage(category);
  if (form.title.length > 120 || form.description.length > 2000 || form.service_area.length > 160) {
    return 'Use até 120 caracteres no título, 2.000 na descrição e 160 na área de atendimento.';
  }
  form.price = Math.round(form.price * 100) / 100;
  return null;
}

function categoryFormData(body, existing = null) {
  return {
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim(),
    icon: String(body.icon || 'fa-tag').trim(),
    image: imageOptions.includes(body.image) || body.image === genericImage
      ? body.image : existing ? categoryImage(existing) : defaultCategoryImage(body.name),
  };
}

function updateRequestStatus(req, res, scope) {
  const status = String(req.body.status || '').trim();
  const destination = scope === 'admin' ? '/admin/solicitacoes' : req.body.return_to === '/prestador/agenda' ? '/prestador/agenda' : '/prestador';

  if (!['accepted', 'in_progress', 'completed', 'canceled'].includes(status)) {
    setFlash(req, 'danger', 'Status inválido.');
    return res.redirect(destination);
  }

  const params = scope === 'admin' ? [req.params.id] : [req.params.id, req.user.id];
  const sql = scope === 'admin'
    ? 'SELECT * FROM service_requests WHERE id = ?'
    : 'SELECT * FROM service_requests WHERE id = ? AND provider_id = ?';
  const result = transaction(() => {
    const request = get(sql, params);
    if (!request) return 'missing';
    if (!nextStatuses[request.status]?.includes(status)) return 'transition';
    if (status === 'accepted' && !canConfirm(request)) return 'conflict';
    run('UPDATE service_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, request.id]);
    if (['in_progress', 'completed', 'canceled'].includes(status)) {
      run("UPDATE request_quotes SET status = 'superseded', responded_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'pending'", [request.id]);
    }
    const messages = {
      accepted: 'Horário confirmado pelo prestador.',
      in_progress: 'Atendimento iniciado.',
      completed: 'Atendimento concluído.',
      canceled: 'Atendimento cancelado.',
    };
    run("INSERT INTO request_messages (request_id, sender_id, body, kind) VALUES (?, ?, ?, 'system')", [request.id, req.user.id, messages[status]]);
    notifyStatus(request, req.user.id, status);
    return 'updated';
  });

  if (result === 'missing') {
    setFlash(req, 'warning', 'Solicitação não encontrada.');
    return res.redirect(destination);
  }
  if (result === 'transition') setFlash(req, 'warning', 'Esta mudança de status não é permitida.');
  else if (result === 'conflict') setFlash(req, 'warning', 'O horário não pode ser confirmado: está indisponível ou fora da agenda atual.');
  else setFlash(req, 'success', status === 'accepted' ? 'Horário confirmado.' : 'Status atualizado.');
  return res.redirect(destination);
}

module.exports = router;
