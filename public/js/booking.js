(() => {
  const date = document.getElementById('booking-date');
  const time = document.getElementById('booking-time');
  const status = document.getElementById('booking-status');
  if (!date || !time || !status) return;
  const submit = date.form.querySelector('[type="submit"]');
  let requestNumber = 0;

  date.addEventListener('change', async () => {
    const currentRequest = ++requestNumber;
    time.replaceChildren(new Option('Selecione', ''));
    time.disabled = true;
    submit.disabled = true;
    if (!date.value) { status.textContent = 'Escolha uma data.'; return; }
    status.textContent = 'Consultando horários...';
    try {
      const response = await fetch(`${time.dataset.endpoint}?date=${encodeURIComponent(date.value)}`, { cache: 'no-store' });
      const data = await response.json();
      if (currentRequest !== requestNumber) return;
      if (!response.ok) { status.textContent = data.error || 'Não foi possível consultar os horários.'; return; }
      for (const slot of data.slots) time.add(new Option(slot, slot));
      time.disabled = !data.slots.length;
      submit.disabled = !data.slots.length;
      status.textContent = data.slots.length ? `${data.slots.length} horários disponíveis nesta data.` : 'Nenhum horário disponível nesta data.';
    } catch {
      if (currentRequest === requestNumber) status.textContent = 'Não foi possível consultar os horários. Tente novamente.';
    }
  });
})();
