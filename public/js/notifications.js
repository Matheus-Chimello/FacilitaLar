(() => {
  const root = document.getElementById('notification-bell');
  if (!root) return;
  const toggle = document.getElementById('notification-toggle');
  const popover = document.getElementById('notification-popover');
  const content = document.getElementById('notification-preview');
  const badge = document.getElementById('notification-badge');
  const errorBox = document.getElementById('notification-error');
  const center = document.getElementById('notification-center');
  let refreshing = false;
  let pendingHtml = null;
  let signedOut = false;
  let submitting = false;
  let refreshVersion = 0;

  function applySummary(data) {
    badge.hidden = data.unreadCount === 0;
    badge.textContent = data.unreadCount > 99 ? '99+' : data.unreadCount;
    toggle.setAttribute('aria-label', `Notificações, ${data.unreadCount} não ${data.unreadCount === 1 ? 'lida' : 'lidas'}`);
    document.querySelectorAll('[data-notification-unread-count]').forEach((element) => { element.textContent = data.unreadCount; });
    if (center) {
      center.querySelector('[data-notification-updates]').hidden = data.revision === center.dataset.revision;
      center.querySelector('[data-notification-unread-label]').textContent = `não ${data.unreadCount === 1 ? 'lida' : 'lidas'}`;
      center.querySelector('[data-notification-mark-all]').disabled = data.unreadCount === 0;
    }
    pendingHtml = data.html;
    if (!popover.contains(document.activeElement)) applyPreview();
  }

  function applyPreview() {
    if (pendingHtml !== null) {
      content.innerHTML = pendingHtml;
      pendingHtml = null;
    }
  }

  async function refresh() {
    if (refreshing || submitting || signedOut || document.hidden) return;
    refreshing = true;
    const version = ++refreshVersion;
    try {
      const response = await fetch('/notificacoes/resumo', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (response.status === 401) {
        signedOut = true;
        popover.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        return;
      }
      if (response.ok) {
        const data = await response.json();
        if (version === refreshVersion) applySummary(data);
      }
    } catch {
      // Keep the last successful inbox while the connection is unavailable.
    } finally {
      refreshing = false;
    }
  }

  function close() {
    popover.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', (event) => {
    if (signedOut) return;
    event.preventDefault();
    const opening = popover.hidden;
    if (opening) applyPreview();
    popover.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) refresh();
  });
  document.addEventListener('click', (event) => { if (!root.contains(event.target)) close(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !popover.hidden) { close(); toggle.focus(); }
  });
  popover.addEventListener('focusout', () => {
    window.setTimeout(() => { if (!popover.contains(document.activeElement) && !submitting) applyPreview(); }, 0);
  });
  popover.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!form.matches('[data-notification-action]')) return;
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    refreshVersion++;
    const button = form.querySelector('button');
    button.disabled = true;
    errorBox.hidden = true;
    try {
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível atualizar as notificações.');
      toggle.focus();
      applySummary(data);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
    } finally {
      submitting = false;
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', refresh);
  window.addEventListener('notifications:refresh', refresh);
  async function poll() {
    await refresh();
    window.setTimeout(poll, 8000);
  }
  poll();
})();
