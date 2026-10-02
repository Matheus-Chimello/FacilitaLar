(() => {
  document.querySelectorAll('[data-image-picker]').forEach((picker) => {
    const select = picker.querySelector('select');
    const preview = picker.querySelector('[data-image-preview]');
    const status = picker.querySelector('[data-image-status]');
    const category = picker.closest('[data-service-image-picker]')?.querySelector('[name="category_id"]');

    function updatePreview() {
      const option = category ? category.selectedOptions[0] : select.selectedOptions[0];
      const image = select.value || option?.dataset.image;
      preview.hidden = !image;
      if (image) {
        preview.src = image;
        preview.alt = option?.textContent.trim() || 'Imagem do serviço';
        status.textContent = `Imagem selecionada: ${preview.alt}.`;
      } else {
        preview.removeAttribute('src');
        preview.alt = '';
        status.textContent = '';
      }
    }

    function updateOptions() {
      const option = category.selectedOptions[0];
      const image = option?.dataset.image;
      const selected = select.value;
      select.replaceChildren(new Option('Padrão da categoria', ''));
      if (image) {
        select.add(new Option(option.textContent.trim(), image));
        if (selected === image) select.value = image;
      }
      select.disabled = !image;
      updatePreview();
    }

    select.addEventListener('change', updatePreview);
    if (category) {
      category.addEventListener('change', updateOptions);
      updateOptions();
    } else {
      updatePreview();
    }
    preview.addEventListener('error', () => {
      preview.hidden = true;
      status.textContent = 'Não foi possível carregar a prévia da imagem.';
    });
  });
})();
