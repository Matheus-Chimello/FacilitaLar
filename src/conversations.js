const express = require('express');
const { all, get, run, transaction } = require('./db');
const { requireRole, setFlash, dashboardPath } = require('./auth');
const { markConversationRead, notificationSummary, notifyMessage, notifyQuote, notifyQuoteResponse } = require('./notifications');

const router = express.Router();
const closedStatuses = ['completed', 'canceled'];
const currency = (amount) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
const canNegotiate = (request) => ['pending', 'accepted'].includes(request.status) && request.agreed_price === null;
const conversationPath = (request) => `/solicitacoes/${request.id}/conversa`;

function failure(req, res, status, message) {
  if (req.get('accept')?.includes('application/json')) return res.status(status).json({ error: message });
  setFlash(req, 'warning', message);
  return res.redirect(req.conversation ? conversationPath(req.conversation) : dashboardPath(req.user.role));
}

router.use('/solicitacoes/:id', requireRole('customer', 'provider', 'admin'), (req, res, next) => {
  const id = Number(req.params.id);
  const request = Number.isSafeInteger(id) && id > 0 ? get(
    `SELECT r.*, s.title AS service_title, s.image, s.price AS listed_price,
       customer.name AS customer_name, provider.name AS provider_name
     FROM service_requests r
     JOIN services s ON s.id = r.service_id
     JOIN users customer ON customer.id = r.customer_id
     JOIN users provider ON provider.id = r.provider_id
     WHERE r.id = ?`, [id]
  ) : null;

  if (!request || (req.user.role !== 'admin' && ![request.customer_id, request.provider_id].includes(req.user.id))) {
    if (req.get('accept')?.includes('application/json')) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    return res.status(404).render('error', { title: 'Solicitação não encontrada', message: 'Não foi possível encontrar esta solicitação.' });
  }
  req.conversation = request;
  return next();
});

function threadData(req, after = 0) {
  const request = req.conversation;
  const messages = all(
    `SELECT m.*, u.name AS sender_name FROM request_messages m
     JOIN users u ON u.id = m.sender_id WHERE m.request_id = ? AND m.id > ? ORDER BY m.id`,
    [request.id, after]
  );
  if (req.user.role !== 'admin') {
    run(`UPDATE request_messages SET read_at = CURRENT_TIMESTAMP
         WHERE request_id = ? AND sender_id != ? AND read_at IS NULL`, [request.id, req.user.id]);
    markConversationRead(req.user.id, request.id, true);
  }
  const quotes = all('SELECT * FROM request_quotes WHERE request_id = ? ORDER BY id DESC', [request.id]);
  const review = get('SELECT id, rating FROM reviews WHERE request_id = ?', [request.id]);
  return {
    request, messages, quotes, review,
    canSend: req.user.role !== 'admin' && !closedStatuses.includes(request.status),
    canNegotiate: req.user.role !== 'admin' && canNegotiate(request),
    signature: JSON.stringify([request.status, request.agreed_price, quotes.map((quote) => [quote.id, quote.status])]),
    backPath: dashboardPath(req.user.role),
  };
}

router.get('/solicitacoes/:id/conversa', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const data = threadData(req);
  if (req.user.role !== 'admin') markConversationRead(req.user.id, req.conversation.id);
  res.locals.notificationSummary = notificationSummary(req.user.id);
  res.render('requests/conversation', { title: 'Conversa e negociação', ...data });
});

router.get('/solicitacoes/:id/mensagens', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const after = Number(req.query.after || 0);
  if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: 'Marcador de mensagens inválido.' });
  const data = threadData(req, after);
  return res.render('requests/negotiation', data, (error, html) => {
    if (error) return next(error);
    return res.json({
      messages: data.messages,
      signature: data.signature,
      negotiationHtml: html,
      canSend: data.canSend,
      status: req.conversation.status,
      statusLabel: res.locals.statusLabel(req.conversation.status),
      statusClass: res.locals.statusClass(req.conversation.status),
      priceLabel: currency(req.conversation.agreed_price ?? req.conversation.listed_price),
      agreed: req.conversation.agreed_price !== null,
      reviewed: Boolean(data.review),
    });
  });
});

router.post('/solicitacoes/:id/mensagens', (req, res) => {
  const request = req.conversation;
  if (req.user.role === 'admin') return failure(req, res, 403, 'A administração pode apenas consultar esta conversa.');
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 2000) return failure(req, res, 422, 'Escreva uma mensagem de até 2.000 caracteres.');
  const result = transaction(() => {
    const current = get('SELECT status FROM service_requests WHERE id = ?', [request.id]);
    if (closedStatuses.includes(current.status)) return null;
    const inserted = run('INSERT INTO request_messages (request_id, sender_id, body) VALUES (?, ?, ?)', [request.id, req.user.id, body]);
    notifyMessage(request, req.user.id, req.user.name, body);
    return inserted;
  });
  if (!result) return failure(req, res, 409, 'A conversa deste atendimento foi encerrada.');
  if (req.get('accept')?.includes('application/json')) return res.status(201).json({ id: result.lastInsertRowid });
  return res.redirect(conversationPath(request));
});

router.post('/solicitacoes/:id/propostas', (req, res) => {
  const request = req.conversation;
  if (req.user.id !== request.provider_id) return failure(req, res, 403, 'Somente o prestador pode enviar uma proposta de valor.');
  const rawAmount = String(req.body.amount || '').trim();
  const amount = Number(rawAmount.replace(',', '.'));
  const note = String(req.body.note || '').trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(rawAmount) || !Number.isFinite(amount) || amount <= 0 || amount > 1000000 || note.length > 500) {
    return failure(req, res, 422, 'Informe um valor entre R$ 0,01 e R$ 1.000.000,00 e uma observação de até 500 caracteres.');
  }
  const created = transaction(() => {
    const current = get('SELECT status, agreed_price FROM service_requests WHERE id = ?', [request.id]);
    if (!canNegotiate(current)) return false;
    run("UPDATE request_quotes SET status = 'superseded', responded_at = CURRENT_TIMESTAMP WHERE request_id = ? AND status = 'pending'", [request.id]);
    run('INSERT INTO request_quotes (request_id, amount, note) VALUES (?, ?, ?)', [request.id, Math.round(amount * 100) / 100, note]);
    run("INSERT INTO request_messages (request_id, sender_id, body, kind) VALUES (?, ?, ?, 'system')", [request.id, req.user.id, `Proposta enviada: ${currency(amount)}.`]);
    notifyQuote(request, amount);
    return true;
  });
  if (!created) return failure(req, res, 409, 'Este atendimento não está mais disponível para negociação.');
  setFlash(req, 'success', 'Proposta enviada ao cliente.');
  return res.redirect(conversationPath(request));
});

router.post('/solicitacoes/:id/propostas/:quoteId/responder', (req, res) => {
  const request = req.conversation;
  if (req.user.id !== request.customer_id) return failure(req, res, 403, 'Somente o cliente pode responder à proposta.');
  const decision = req.body.decision;
  if (!['accepted', 'rejected'].includes(decision)) return failure(req, res, 422, 'Escolha aceitar ou recusar a proposta.');
  const quoteId = Number(req.params.quoteId);
  if (!Number.isSafeInteger(quoteId)) return failure(req, res, 404, 'Proposta não encontrada.');
  const updated = transaction(() => {
    const current = get('SELECT status, agreed_price FROM service_requests WHERE id = ?', [request.id]);
    const quote = get("SELECT * FROM request_quotes WHERE id = ? AND request_id = ? AND status = 'pending'", [quoteId, request.id]);
    if (!quote || !canNegotiate(current)) return false;
    run('UPDATE request_quotes SET status = ?, responded_at = CURRENT_TIMESTAMP WHERE id = ?', [decision, quote.id]);
    if (decision === 'accepted') {
      run('UPDATE service_requests SET agreed_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [quote.amount, request.id]);
    }
    run("INSERT INTO request_messages (request_id, sender_id, body, kind) VALUES (?, ?, ?, 'system')", [request.id, req.user.id, `Proposta de ${currency(quote.amount)} ${decision === 'accepted' ? 'aceita' : 'recusada'} pelo cliente.`]);
    notifyQuoteResponse(request, quote.amount, decision);
    return true;
  });
  if (!updated) return failure(req, res, 409, 'Esta proposta já foi respondida ou não está mais disponível.');
  setFlash(req, 'success', decision === 'accepted' ? 'Proposta aceita. Valor combinado registrado no atendimento.' : 'Proposta recusada. Você pode continuar a conversa com o prestador.');
  return res.redirect(conversationPath(request));
});

module.exports = router;
