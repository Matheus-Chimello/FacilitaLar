const { all, get } = require('./db');

const timeZone = 'America/Sao_Paulo';
const bookingWindowDays = 60;
const durationOptions = [30, 60, 90, 120, 180, 240];
const weekdays = [
  { id: 1, name: 'Segunda-feira' }, { id: 2, name: 'Terça-feira' },
  { id: 3, name: 'Quarta-feira' }, { id: 4, name: 'Quinta-feira' },
  { id: 5, name: 'Sexta-feira' }, { id: 6, name: 'Sábado' },
  { id: 0, name: 'Domingo' },
];

function localNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function dateNumber(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value ? date.getTime() : null;
}

function withinWindow(date, maxDays = bookingWindowDays, now = new Date()) {
  const target = dateNumber(date);
  const today = dateNumber(localNow(now).date);
  return target !== null && target >= today && target <= today + maxDays * 86400000;
}

function minutes(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value))) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function timeLabel(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function availabilityFromBody(body) {
  const periods = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const dayPeriods = [];
    for (let period = 0; period < 2; period += 1) {
      const startTime = String(body[`start_${weekday}_${period}`] || '').trim();
      const endTime = String(body[`end_${weekday}_${period}`] || '').trim();
      if (!startTime && !endTime) continue;
      const start = minutes(startTime);
      const end = minutes(endTime);
      if (start === null || end === null || start % 30 !== 0 || end % 30 !== 0 || start >= end) {
        return { error: 'Informe períodos completos, em intervalos de 30 minutos, com o fim após o início.' };
      }
      dayPeriods.push({ weekday, period, start_time: startTime, end_time: endTime, start, end });
    }
    dayPeriods.sort((a, b) => a.start - b.start);
    if (dayPeriods.length === 2 && dayPeriods[0].end > dayPeriods[1].start) {
      return { error: 'Os períodos do mesmo dia não podem se sobrepor.' };
    }
    periods.push(...dayPeriods);
  }
  return { periods };
}

function busyRequests(providerId, date, excludeId = null) {
  const previousDate = new Date(dateNumber(date) - 86400000).toISOString().slice(0, 10);
  return all(`SELECT id, scheduled_date, duration_minutes, status FROM service_requests
    WHERE provider_id = ? AND substr(scheduled_date, 1, 10) IN (?, ?)
      AND status IN ('pending', 'accepted', 'in_progress', 'completed')
      AND (? IS NULL OR id != ?)`, [providerId, date, previousDate, excludeId, excludeId]);
}

function overlaps(start, duration, request, date) {
  const busyStart = minutes(String(request.scheduled_date).slice(11, 16));
  if (busyStart === null) return false;
  const offset = String(request.scheduled_date).slice(0, 10) === date ? 0 : -1440;
  return start < busyStart + offset + Number(request.duration_minutes || 60) && busyStart + offset < start + duration;
}

function withinHours(providerId, date, start, duration) {
  if (get('SELECT 1 FROM provider_days_off WHERE provider_id = ? AND date = ?', [providerId, date])) return false;
  const weekday = new Date(dateNumber(date)).getUTCDay();
  return all('SELECT start_time, end_time FROM provider_hours WHERE provider_id = ? AND weekday = ?', [providerId, weekday])
    .some((period) => start >= minutes(period.start_time) && start + duration <= minutes(period.end_time));
}

function availableSlots(service, date, now = new Date()) {
  if (!withinWindow(date, bookingWindowDays, now)) return [];
  const current = localNow(now);
  const duration = Number(service.duration_minutes || 60);
  const weekday = new Date(dateNumber(date)).getUTCDay();
  if (get('SELECT 1 FROM provider_days_off WHERE provider_id = ? AND date = ?', [service.provider_id, date])) return [];
  const periods = all('SELECT start_time, end_time FROM provider_hours WHERE provider_id = ? AND weekday = ? ORDER BY start_time', [service.provider_id, weekday]);
  const busy = busyRequests(service.provider_id, date);
  const slots = [];
  for (const period of periods) {
    for (let start = minutes(period.start_time); start + duration <= minutes(period.end_time); start += 30) {
      if (date === current.date && start < current.minutes + 60) continue;
      if (!busy.some((request) => overlaps(start, duration, request, date))) slots.push(timeLabel(start));
    }
  }
  return [...new Set(slots)].sort();
}

function nextAvailableDate(service, now = new Date()) {
  if (!get('SELECT 1 FROM provider_hours WHERE provider_id = ? LIMIT 1', [service.provider_id])) return null;
  const today = dateNumber(localNow(now).date);
  for (let offset = 0; offset <= bookingWindowDays; offset += 1) {
    const date = new Date(today + offset * 86400000).toISOString().slice(0, 10);
    if (availableSlots(service, date, now).length) return date;
  }
  return null;
}

function canConfirm(request, now = new Date()) {
  const date = String(request.scheduled_date).slice(0, 10);
  const start = minutes(String(request.scheduled_date).slice(11, 16));
  if (dateNumber(date) === null || start === null) return false;
  const current = localNow(now);
  if (date < current.date || (date === current.date && start <= current.minutes)) return false;
  if (!withinHours(request.provider_id, date, start, Number(request.duration_minutes || 60))) return false;
  return !busyRequests(request.provider_id, date, request.id)
    .filter((other) => ['accepted', 'in_progress', 'completed'].includes(other.status))
    .some((other) => overlaps(start, Number(request.duration_minutes || 60), other, date));
}

module.exports = {
  weekdays, durationOptions, bookingWindowDays, localNow, dateNumber, withinWindow,
  minutes, availabilityFromBody, availableSlots, nextAvailableDate, canConfirm,
};
