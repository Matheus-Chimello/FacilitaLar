(() => {
  const root = document.getElementById('conversation');
  if (!root) return;
  const list = document.getElementById('message-list');
  const form = document.getElementById('message-form');
  const input = document.getElementById('message-body');
  const connection = document.getElementById('connection-status');
  const errorBox = document.getElementById('chat-error');
  const negotiation = document.getElementById('negotiation-panel');
  const endpoint = `/solicitacoes/${root.dataset.requestId}/mensagens`;
  let after = Number(root.dataset.after);
  let signature = root.dataset.signature;
  let refreshing = false;
  let sending = false;
  let canSend = input && !input.disabled;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function appendMessage(message) {
    if (list.querySelector(`[data-message-id="${message.id}"]`)) return;
    document.getElementById('chat-empty')?.remove();
    const article = document.createElement('article');
    article.className = `message ${message.kind === 'system' ? 'message-system' : message.sender_id === Number(root.dataset.userId) ? 'message-own' : 'message-other'}`;
    article.dataset.messageId = message.id;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('strong');
    sender.textContent = message.sender_name;
    const time = document.createElement('time');
    time.dateTime = `${message.created_at.replace(' ', 'T')}Z`;
    time.textContent = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(time.dateTime));
    const body = document.createElement('p');
    body.textContent = message.body;
    meta.append(sender, time);
    article.append(meta, body);
    list.append(article);
    after = Math.max(after, message.id);
  }

  async function refresh(forceScroll = false) {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch(`${endpoint}?after=${after}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (response.redirected) { window.location.assign(response.url); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível atualizar a conversa.');
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
      data.messages.forEach(appendMessage);
      if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
      if (data.signature !== signature && !negotiation.contains(document.activeElement)) {
        negotiation.innerHTML = data.negotiationHtml;
        signature = data.signature;
      }
      const status = document.getElementById('request-status');
      status.textContent = data.statusLabel;
      status.className = `badge badge-${data.statusClass}`;
      document.getElementById('request-price').textContent = data.priceLabel;
      document.getElementById('request-price-label').textContent = data.agreed ? 'Valor combinado' : 'Preço anunciado';
      if (form) {
        canSend = data.canSend;
        input.disabled = !canSend;
        form.querySelector('button').disabled = !canSend || sending;
        document.getElementById('chat-readonly').hidden = canSend;
      }
      connection.textContent = 'Atualizada';
    } catch (error) {
      connection.textContent = 'Reconectando...';
      if (forceScroll) showError(error.message);
    } finally {
      refreshing = false;
    }
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending || !canSend || !input.value.trim()) return;
    const body = input.value;
    sending = true;
    form.querySelector('button').disabled = true;
    showError('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) });
      if (response.redirected) { window.location.assign(response.url); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível enviar a mensagem.');
      if (input.value === body) input.value = '';
      await refresh(true);
      input.focus();
    } catch (error) {
      showError(error.message);
    } finally {
      sending = false;
      form.querySelector('button').disabled = !canSend;
    }
  });

  list.scrollTop = list.scrollHeight;
  async function poll() {
    if (!document.hidden) await refresh();
    window.setTimeout(poll, 4000);
  }
  poll();
})();
