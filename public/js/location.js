(() => {
  const status = document.getElementById('location-status');
  document.querySelectorAll('[data-locate]').forEach((button) => {
    button.addEventListener('click', () => {
      const form = button.closest('form');
      if (!navigator.geolocation) { status.textContent = 'Seu navegador não disponibiliza a localização.'; return; }
      button.disabled = true;
      status.textContent = 'Buscando sua localização...';
      navigator.geolocation.getCurrentPosition((position) => {
        form.elements.latitude.value = position.coords.latitude.toFixed(6);
        form.elements.longitude.value = position.coords.longitude.toFixed(6);
        if (button.dataset.locate === 'search') form.elements.cep.value = '';
        status.textContent = 'Localização encontrada.';
        button.disabled = false;
        if (button.dataset.locate === 'search') form.requestSubmit();
      }, (error) => {
        status.textContent = error.code === 1 ? 'Permissão de localização negada. Libere o acesso no navegador para buscar por proximidade.' : 'Não foi possível obter a localização. Tente novamente.';
        button.disabled = false;
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  });
  document.querySelector('[data-clear-location]')?.addEventListener('click', (event) => {
    const form = event.currentTarget.closest('form');
    form.elements.cep.value = '';
    form.elements.latitude.value = '';
    form.elements.longitude.value = '';
    form.requestSubmit();
  });
  document.querySelectorAll('[data-cep]').forEach((input) => {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 8);
      input.value = digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
      if (input.form.id === 'catalog-filter' && digits) {
        input.form.elements.latitude.value = '';
        input.form.elements.longitude.value = '';
      }
    });
  });
})();
