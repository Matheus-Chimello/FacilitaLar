const express = require('express');
const { all, get, run, transaction } = require('./db');
const { requireRole, setFlash, dashboardPath } = require('./auth');
const { notifyReviewInvite, notifyReviewPublished, notifyReviewResponse, notifyReviewModeration, notificationSummary } = require('./notifications');

const router = express.Router();
const pageSize = 10;
const moderationReasons = { offensive_content: 'Conteúdo ofensivo ou abusivo', personal_data: 'Exposição de dados pessoais', spam: 'Spam ou conteúdo sem relação com o atendimento', reviewed: 'Conteúdo revisado e restaurado' };
const joinedReviewSql = `SELECT v.*, r.provider_id, r.customer_id, s.title AS service_title,
  customer.name AS customer_name, provider.name AS provider_name
  FROM reviews v JOIN service_requests r ON r.id = v.request_id
  JOIN services s ON s.id = r.service_id JOIN users customer ON customer.id = r.customer_id
  JOIN users provider ON provider.id = r.provider_id`;

function ratingSummary(providerId) {
  return get(`SELECT COUNT(*) AS count, AVG(v.rating) AS average FROM reviews v
    JOIN service_requests r ON r.id = v.request_id WHERE r.provider_id = ?`, [providerId]);
}

function reviewPage(providerId, rawPage) {
  const summary = ratingSummary(providerId);
  const pages = Math.max(1, Math.ceil(summary.count / pageSize));
  const input = Number(rawPage || 1);
  const page = Math.min(pages, Number.isSafeInteger(input) && input > 0 ? input : 1);
  const reviews = all(`${joinedReviewSql} WHERE r.provider_id = ? ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?`, [providerId, pageSize, (page - 1) * pageSize]);
  return { reviews, summary, page, pages };
}

function requestForReview(id) {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return get(`SELECT r.*, s.title AS service_title, u.name AS provider_name FROM service_requests r
    JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.provider_id WHERE r.id = ?`, [value]);
}

function reviewAccess(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.user) {
    if (req.get('accept')?.includes('application/json')) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
    return res.redirect('/entrar');
  }
  const request = requestForReview(req.params.id);
  if (!request || (req.user.role !== 'admin' && ![request.customer_id, request.provider_id].includes(req.user.id))) {
    if (req.get('accept')?.includes('application/json')) return res.status(404).json({ error: 'Atendimento não encontrado.' });
    return res.status(404).render('error', { title: 'Atendimento não encontrado', message: 'Não foi possível encontrar este atendimento.' });
  }
  req.reviewRequest = request;
  next();
}

function renderReview(req, res, status = 200, form = {}, error = '') {
  const request = req.reviewRequest;
  const review = get(`${joinedReviewSql} WHERE v.request_id = ?`, [request.id]);
  return res.status(status).render('reviews/request', { title: 'Avaliação do atendimento', request, review,
    form, error, backPath: dashboardPath(req.user.role), moderationReasons,
    history: review ? all('SELECT * FROM review_moderation WHERE review_id = ? ORDER BY id DESC LIMIT 10', [review.id]) : [],
  });
}

function fail(req, res, status, message, form = {}) {
  if (req.get('accept')?.includes('application/json')) return res.status(status).json({ error: message });
  return renderReview(req, res, status, form, message);
}

router.get('/solicitacoes/:id/avaliacao', reviewAccess, (req, res) => {
  run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND request_id = ? AND kind LIKE 'review%' AND read_at IS NULL", [Date.now(), req.user.id, req.reviewRequest.id]);
  res.locals.notificationSummary = notificationSummary(req.user.id);
  return renderReview(req, res);
});

router.post('/solicitacoes/:id/avaliacao', reviewAccess, (req, res) => {
  if (req.user.role !== 'customer' || req.user.id !== req.reviewRequest.customer_id) return fail(req, res, 403, 'Somente o cliente deste atendimento pode avaliar.');
  const rawRating = typeof req.body.rating === 'string' ? req.body.rating : '';
  const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
  const form = { rating: rawRating, comment };
  if (!/^[1-5]$/.test(rawRating) || comment.length > 1500) return fail(req, res, 422, 'Escolha uma nota de 1 a 5 e use até 1.500 caracteres no comentário.', form);
  const result = transaction(() => {
    const request = requestForReview(req.params.id);
    if (request.status !== 'completed') return 'unfinished';
    if (get('SELECT 1 FROM reviews WHERE request_id = ?', [request.id])) return 'duplicate';
    run('INSERT INTO reviews (request_id, rating, comment, created_at) VALUES (?, ?, ?, ?)', [request.id, Number(rawRating), comment, Date.now()]);
    notifyReviewPublished(request, Number(rawRating));
    return 'created';
  });
  if (result !== 'created') return fail(req, res, 409, result === 'duplicate' ? 'Este atendimento já foi avaliado.' : 'A avaliação fica disponível após a conclusão do atendimento.', form);
  setFlash(req, 'success', 'Avaliação publicada. Obrigado por compartilhar sua experiência!');
  return res.redirect(303, `/solicitacoes/${req.reviewRequest.id}/avaliacao`);
});

router.post('/solicitacoes/:id/avaliacao/resposta', reviewAccess, (req, res) => {
  if (req.user.role !== 'provider' || req.user.id !== req.reviewRequest.provider_id) return fail(req, res, 403, 'Somente o prestador deste atendimento pode responder.');
  const response = typeof req.body.response === 'string' ? req.body.response.trim() : '';
  if (!response || response.length > 1500) return fail(req, res, 422, 'Escreva uma resposta de até 1.500 caracteres.', { response });
  const result = transaction(() => {
    const review = get('SELECT * FROM reviews WHERE request_id = ?', [req.reviewRequest.id]);
    if (!review) return 'missing';
    if (review.response) return 'duplicate';
    run('UPDATE reviews SET response = ?, responded_at = ? WHERE id = ?', [response, Date.now(), review.id]);
    notifyReviewResponse(req.reviewRequest);
    return 'created';
  });
  if (result !== 'created') return fail(req, res, 409, result === 'missing' ? 'Este atendimento ainda não recebeu uma avaliação.' : 'Esta avaliação já recebeu sua resposta.');
  setFlash(req, 'success', 'Resposta publicada.');
  return res.redirect(303, `/solicitacoes/${req.reviewRequest.id}/avaliacao`);
});

router.get('/prestador/avaliacoes', requireRole('provider'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.render('reviews/provider', { title: 'Minhas avaliações', ...reviewPage(req.user.id, req.query.pagina) });
});

router.get('/admin/avaliacoes', requireRole('admin'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const filter = req.query.filtro === 'ocultadas' ? 'ocultadas' : 'todas';
  const where = filter === 'ocultadas' ? ' WHERE v.comment_hidden = 1 OR v.response_hidden = 1' : '';
  const total = get(`SELECT COUNT(*) AS count FROM reviews v${where}`).count;
  const pages = Math.max(1, Math.ceil(total / 20));
  const input = Number(req.query.pagina || 1);
  const page = Math.min(pages, Number.isSafeInteger(input) && input > 0 ? input : 1);
  const reviews = all(`${joinedReviewSql}${where} ORDER BY v.created_at DESC, v.id DESC LIMIT 20 OFFSET ?`, [(page - 1) * 20]);
  for (const review of reviews) review.history = all(`SELECT m.*, u.name AS admin_name FROM review_moderation m
    JOIN users u ON u.id = m.admin_id WHERE m.review_id = ? ORDER BY m.id DESC LIMIT 5`, [review.id]);
  res.render('reviews/admin', { title: 'Moderação de avaliações', reviews, total, filter, page, pages, moderationReasons });
});

router.post('/admin/avaliacoes/:reviewId/moderar', requireRole('admin'), (req, res) => {
  const actions = { 'comment:hide': ['comment', 'hide'], 'comment:restore': ['comment', 'restore'], 'response:hide': ['response', 'hide'], 'response:restore': ['response', 'restore'] };
  const selected = typeof req.body.action === 'string' && Object.hasOwn(actions, req.body.action) ? actions[req.body.action] : null;
  const reviewId = Number(req.params.reviewId);
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  const reason = selected?.[1] === 'restore' ? 'reviewed' : req.body.reason;
  if (!selected || !Number.isSafeInteger(reviewId) || reviewId < 1 || note.length > 500 || !['offensive_content', 'personal_data', 'spam', 'reviewed'].includes(reason) || (selected[1] === 'hide' && reason === 'reviewed')) {
    if (req.get('accept')?.includes('application/json')) return res.status(422).json({ error: 'Selecione o conteúdo e um motivo válido para a moderação.' });
    setFlash(req, 'warning', 'Selecione o conteúdo e um motivo válido para a moderação.');
    return res.redirect(303, '/admin/avaliacoes');
  }
  const [target, action] = selected;
  const result = transaction(() => {
    const review = get('SELECT * FROM reviews WHERE id = ?', [reviewId]);
    if (!review) return 'missing';
    if (!review[target] || review[`${target}_hidden`] === Number(action === 'hide')) return 'unchanged';
    run(`UPDATE reviews SET ${target}_hidden = ? WHERE id = ?`, [Number(action === 'hide'), review.id]);
    run('INSERT INTO review_moderation (review_id, admin_id, target, action, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [review.id, req.user.id, target, action, reason, note, Date.now()]);
    notifyReviewModeration(requestForReview(review.request_id), target, action);
    return 'updated';
  });
  if (req.get('accept')?.includes('application/json')) return res.status(result === 'updated' ? 200 : result === 'missing' ? 404 : 409).json(result === 'updated' ? { updated: true } : { error: 'Conteúdo não encontrado ou já moderado.' });
  setFlash(req, result === 'updated' ? 'success' : 'warning', result === 'updated' ? 'Moderação registrada. A nota permanece no cálculo da reputação.' : 'Conteúdo não encontrado ou já moderado.');
  return res.redirect(303, '/admin/avaliacoes');
});

function initializeReviews() {
  if (get('SELECT 1 FROM schema_migrations WHERE name = ?', ['review-invites-v1'])) return;
  transaction(() => {
    for (const request of all(`SELECT r.* FROM service_requests r LEFT JOIN reviews v ON v.request_id = r.id
      WHERE r.status = 'completed' AND v.id IS NULL`)) notifyReviewInvite(request);
    run('INSERT INTO schema_migrations (name) VALUES (?)', ['review-invites-v1']);
  });
}

function context(req, res, next) {
  res.locals.formatRating = (average) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(average);
  res.locals.reviewDate = (value) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(value);
  res.locals.reviewerName = (name) => {
    const parts = name.trim().split(/\s+/);
    return parts.length > 1 ? `${parts[0]} ${Array.from(parts[parts.length - 1])[0]}.` : parts[0];
  };
  next();
}

module.exports = { router, context, initializeReviews, ratingSummary, reviewPage };
