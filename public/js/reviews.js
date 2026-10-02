(() => {
  const input = document.querySelector('.review-rating-input');
  if (input) {
    const choices = [...input.querySelectorAll('.review-rating-choice')];
    const output = input.querySelector('output');
    const selected = () => Number(input.querySelector('input:checked')?.value || 0);
    function paint(value) {
      choices.forEach((choice) => {
        const filled = Number(choice.querySelector('input').value) <= value;
        choice.querySelector('i').className = `fa ${filled ? 'fa-star' : 'fa-star-o'}`;
        choice.classList.toggle('is-filled', filled);
      });
    }
    choices.forEach((choice) => {
      choice.addEventListener('mouseenter', () => paint(Number(choice.querySelector('input').value)));
      choice.querySelector('input').addEventListener('change', () => {
        paint(selected());
        output.textContent = `${selected()} de 5 estrelas`;
      });
    });
    input.addEventListener('mouseleave', () => paint(selected()));
    paint(selected());
  }
  document.querySelectorAll('.moderation-form').forEach((form) => {
    const action = form.querySelector('[name="action"]');
    const reason = form.querySelector('[name="reason"]');
    function updateReason() {
      const restoring = action.value.endsWith(':restore');
      reason.disabled = restoring;
      reason.required = !restoring;
      reason.closest('label').hidden = restoring;
    }
    action.addEventListener('change', updateReason);
    updateReason();
  });
})();
