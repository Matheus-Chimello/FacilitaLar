const express = require('express');
const { all, get, run, transaction } = require('./db');
const { requireAuth, setFlash, dashboardPath } = require('./auth');

const router = express.Router();
const pageSize = 20;
const filters = { todas: '', 'nao-lidas': ' AND read_at IS NULL', lidas: ' AND read_at IS NOT NULL' };
const currency = (amount) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
const preview = (text) => Array.from(String(text).replace(/\s+/g, ' ').trim()).slice(0, 180).join('');

function serviceTitle(request) {
  return request.service_title || get('SELECT title FROM services WHERE id = ?', [request.service_id]).title;
}

function createNotification(userId, request, kind, title, body) {
  const now = Date.now();
  run(`INSERT INTO notifications (user_id, request_id, kind, title, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, request.id, kind, title, preview(body), now, now]);
}

function notifyRequestCreated(request, customerName) {
  createNotification(request.provider_id, request, 'request', 'Nova solicitação de serviço', `${customerName} solicitou ${serviceTitle(request)}.`);
}

function notifyMessage(request, senderId, senderName, body) {
  const recipientId = senderId === request.customer_id ? request.provider_id : request.customer_id;
  const pending = get("SELECT id, occurrences FROM notifications WHERE user_id = ? AND request_id = ? AND kind = 'message' AND read_at IS NULL", [recipientId, request.id]);
  const occurrences = (pending?.occurrences || 0) + 1;
  const title = occurrences === 1 ? `Nova mensagem de ${senderName}` : `${occurrences} novas mensagens de ${senderName}`;
  if (pending) {
    run('UPDATE notifications SET title = ?, body = ?, occurrences = ?, version = version + 1, updated_at = ? WHERE id = ?',
      [title, preview(body), occurrences, Date.now(), pending.id]);
  } else {
    createNotification(recipientId, request, 'message', title, body);
  }
}

function notifyQuote(request, amount) {
  createNotification(request.customer_id, request, 'quote', 'Nova proposta de valor', `${serviceTitle(request)}: o prestador propôs ${currency(amount)}.`);
}

function notifyQuoteResponse(request, amount, decision) {
  const accepted = decision === 'accepted';
  createNotification(request.provider_id, request, 'quote_response', accepted ? 'Proposta aceita' : 'Proposta recusada',
    `${serviceTitle(request)}: o cliente ${accepted ? 'aceitou' : 'recusou'} a proposta de ${currency(amount)}.`);
}

function notifyStatus(request, actorId, status) {
  const titles = { accepted: 'Horário confirmado', in_progress: 'Atendimento iniciado', completed: 'Atendimento concluído', canceled: 'Atendimento cancelado' };
  for (const userId of new Set([request.customer_id, request.provider_id])) {
    if (userId !== actorId) createNotification(userId, request, 'status', titles[status], serviceTitle(request));
  }
  if (status === 'completed') notifyReviewInvite(request);
}

function notifyReviewInvite(request) {
  if (!get("SELECT 1 FROM notifications WHERE user_id = ? AND request_id = ? AND kind = 'review_invite'", [request.customer_id, request.id])) {
    createNotification(request.customer_id, request, 'review_invite', 'Como foi o atendimento?', `Avalie ${serviceTitle(request)} e compartilhe sua experiência.`);
  }
}

function notifyReviewPublished(request, rating) {
  createNotification(request.provider_id, request, 'review', 'Você recebeu uma avaliação', `${serviceTitle(request)} recebeu nota ${rating} de 5.`);
  run("UPDATE notifications SET read_at = ? WHERE request_id = ? AND user_id = ? AND kind = 'review_invite' AND read_at IS NULL", [Date.now(), request.id, request.customer_id]);
}

function notifyReviewResponse(request) {
  createNotification(request.customer_id, request, 'review_response', 'O prestador respondeu à sua avaliação', serviceTitle(request));
}

function notifyReviewModeration(request, target, action) {
  const title = action === 'hide' ? 'Conteúdo da avaliação moderado' : 'Conteúdo da avaliação restaurado';
  for (const userId of new Set([request.customer_id, request.provider_id])) {
    createNotification(userId, request, 'review_moderation', title, `${target === 'comment' ? 'Comentário' : 'Resposta'}: ${serviceTitle(request)}.`);
  }
}

function markConversationRead(userId, requestId, messagesOnly = false) {
  run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND request_id = ? AND read_at IS NULL${messagesOnly ? " AND kind = 'message'" : ''}`, [Date.now(), userId, requestId]);
}

function notificationSummary(userId) {
  const counts = get(`SELECT COUNT(*) AS total, COALESCE(SUM(read_at IS NULL), 0) AS unread,
    COALESCE(MAX(id), 0) AS latest, COALESCE(SUM(version), 0) AS versions FROM notifications WHERE user_id = ?`, [userId]);
  return {
    unreadCount: counts.unread,
    total: counts.total,
    revision: `${counts.total}:${counts.unread}:${counts.latest}:${counts.versions}`,
    items: all('SELECT * FROM notifications WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 5', [userId]),
  };
}

function notificationAge(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Agora';
  if (seconds < 3600) return `Há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `Há ${Math.floor(seconds / 3600)} h`;
  const days = Math.floor(seconds / 86400);
  return days === 1 ? 'Há 1 dia' : `Há ${days} dias`;
}

function context(req, res, next) {
  res.locals.notificationSummary = req.user ? notificationSummary(req.user.id) : null;
  res.locals.notificationAge = notificationAge;
  res.locals.notificationDate = (timestamp) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(timestamp);
  res.locals.notificationIcon = (kind) => ({ request: 'fa-calendar-o', message: 'fa-comment-o', quote: 'fa-file-text-o', quote_response: 'fa-thumbs-o-up', status: 'fa-check-circle-o', review_invite: 'fa-star-o', review: 'fa-star', review_response: 'fa-comment-o', review_moderation: 'fa-shield' }[kind]);
  next();
}

function pageLocation(body) {
  const filter = Object.hasOwn(filters, body.filtro) ? body.filtro : 'todas';
  const page = Number(body.pagina);
  return `/notificacoes?filtro=${filter}&pagina=${Number.isSafeInteger(page) && page > 0 ? page : 1}`;
}

function errorResponse(req, res, status, message) {
  if (req.get('accept')?.includes('application/json')) return res.status(status).json({ error: message });
  setFlash(req, 'warning', message);
  return res.redirect(303, '/notificacoes');
}

router.use('/notificacoes', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user && req.get('accept')?.includes('application/json')) return res.status(401).json({ error: 'Entre na sua conta para ver as notificações.' });
  return requireAuth(req, res, next);
});

function sendSummary(req, res, next) {
  const summary = notificationSummary(req.user.id);
  return res.render('notifications/preview', { notificationSummary: summary }, (error, html) => {
    if (error) return next(error);
    return res.json({ unreadCount: summary.unreadCount, revision: summary.revision, html });
  });
}

router.get('/notificacoes/resumo', sendSummary);

router.get('/notificacoes', (req, res) => {
  const filter = Object.hasOwn(filters, req.query.filtro) ? req.query.filtro : 'todas';
  const where = `user_id = ?${filters[filter]}`;
  const total = get(`SELECT COUNT(*) AS count FROM notifications WHERE ${where}`, [req.user.id]).count;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rawPage = Number(req.query.pagina || 1);
  const page = Math.min(pageCount, Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1);
  const notifications = all(`SELECT * FROM notifications WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, [req.user.id, pageSize, (page - 1) * pageSize]);
  res.render('notifications/index', { title: 'Notificações', notifications, filter, page, pageCount, total, backPath: dashboardPath(req.user.role) });
});

router.post('/notificacoes/ler-todas', (req, res, next) => {
  run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [Date.now(), req.user.id]);
  if (req.get('accept')?.includes('application/json')) return sendSummary(req, res, next);
  return res.redirect(303, pageLocation(req.body));
});

router.post('/notificacoes/:id/:action', (req, res, next) => {
  if (!['abrir', 'leitura'].includes(req.params.action)) return errorResponse(req, res, 404, 'Ação não encontrada.');
  const id = Number(req.params.id);
  const notification = Number.isSafeInteger(id) && id > 0 ? get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, req.user.id]) : null;
  if (!notification) return errorResponse(req, res, 404, 'Notificação não encontrada.');
  const version = Number(req.body.version);
  if (!Number.isSafeInteger(version) || version < 1) return errorResponse(req, res, 422, 'Versão de notificação inválida.');
  // A preview must not mark a newer, unseen message in the same group as read.
  const marked = run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND version = ?', [Date.now(), id, req.user.id, version]);
  if (req.params.action === 'abrir') return res.redirect(303, `/solicitacoes/${notification.request_id}/${notification.kind.startsWith('review') ? 'avaliacao' : 'conversa'}`);
  if (!marked.changes) return errorResponse(req, res, 409, 'Esta notificação recebeu uma atualização. Atualize a lista antes de marcar como lida.');
  if (req.get('accept')?.includes('application/json')) return sendSummary(req, res, next);
  return res.redirect(303, pageLocation(req.body));
});

function initializeNotifications() {
  if (get('SELECT 1 FROM schema_migrations WHERE name = ?', ['notification-inbox-v1'])) return;
  transaction(() => {
    for (const request of all(`SELECT r.*, u.name AS customer_name FROM service_requests r
      JOIN users u ON u.id = r.customer_id WHERE r.status = 'pending'`)) {
      notifyRequestCreated(request, request.customer_name);
    }
    const unread = all(`SELECT m.*, u.name AS sender_name FROM request_messages m JOIN users u ON u.id = m.sender_id
      WHERE m.kind = 'message' AND m.read_at IS NULL ORDER BY m.id`);
    for (const message of unread) {
      const request = get('SELECT * FROM service_requests WHERE id = ?', [message.request_id]);
      if ([request.customer_id, request.provider_id].includes(message.sender_id)) notifyMessage(request, message.sender_id, message.sender_name, message.body);
    }
    for (const quote of all(`SELECT q.* FROM request_quotes q JOIN service_requests r ON r.id = q.request_id
      WHERE q.status = 'pending' AND r.status IN ('pending', 'accepted') AND r.agreed_price IS NULL`)) {
      notifyQuote(get('SELECT * FROM service_requests WHERE id = ?', [quote.request_id]), quote.amount);
    }
    run('INSERT INTO schema_migrations (name) VALUES (?)', ['notification-inbox-v1']);
  });
}

module.exports = { router, context, initializeNotifications, notificationSummary, markConversationRead, notifyReviewInvite, notifyReviewPublished, notifyReviewResponse, notifyReviewModeration,
  notifyRequestCreated, notifyMessage, notifyQuote, notifyQuoteResponse, notifyStatus };
