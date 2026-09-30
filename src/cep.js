const { coordinates } = require('./location');

const cache = new Map();
const cacheLifetime = 12 * 60 * 60 * 1000;

class CepError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

function formatCep(value) {
  const input = String(value ?? '').trim();
  if (!/^\d{5}-?\d{3}$/.test(input)) return null;
  const digits = input.replace('-', '');
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

async function lookupCep(value, fetchImpl = fetch) {
  const cep = formatCep(value);
  if (!cep) throw new CepError('Informe um CEP válido com 8 dígitos.');

  const digits = cep.replace('-', '');
  const cached = cache.get(digits);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let response;
  try {
    response = await fetchImpl(`https://brasilapi.com.br/api/cep/v2/${digits}`, { signal: AbortSignal.timeout(7000) });
  } catch {
    throw new CepError('Não foi possível consultar o CEP agora. Tente novamente em instantes.', 503);
  }

  if (response.status === 404 || response.status === 400) throw new CepError('CEP não encontrado. Confira os números e tente novamente.');
  if (!response.ok) throw new CepError('Não foi possível consultar o CEP agora. Tente novamente em instantes.', 503);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new CepError('Não foi possível consultar o CEP agora. Tente novamente em instantes.', 503);
  }
  if (String(data?.cep || '').replace(/\D/g, '') !== digits || !data?.city || !data?.state) {
    throw new CepError('Não foi possível validar o CEP agora. Tente novamente em instantes.', 503);
  }

  const point = coordinates(data.location?.coordinates?.latitude, data.location?.coordinates?.longitude);
  const valueResult = {
    cep,
    city: String(data.city),
    state: String(data.state),
    street: String(data.street || ''),
    neighborhood: String(data.neighborhood || ''),
    point,
  };
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(digits, { value: valueResult, expiresAt: Date.now() + cacheLifetime });
  return valueResult;
}

module.exports = { CepError, formatCep, lookupCep };
