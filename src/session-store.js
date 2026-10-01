const session = require('express-session');
const { get, run } = require('./db');

const defaultLifetime = 12 * 60 * 60 * 1000;

function expiry(data) {
  const value = data.cookie?.expires ? new Date(data.cookie.expires).getTime() : NaN;
  return Number.isFinite(value) ? value : Date.now() + defaultLifetime;
}

class SqliteSessionStore extends session.Store {
  get(id, callback) {
    try {
      const row = get('SELECT data, expires_at FROM sessions WHERE id = ?', [id]);
      if (!row || row.expires_at <= Date.now()) {
        if (row) run('DELETE FROM sessions WHERE id = ?', [id]);
        return process.nextTick(callback, null, null);
      }
      return process.nextTick(callback, null, JSON.parse(row.data));
    } catch (error) {
      return process.nextTick(callback, error);
    }
  }

  set(id, data, callback) {
    try {
      run(`INSERT INTO sessions (id, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      [id, JSON.stringify(data), expiry(data)]);
      run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
      return process.nextTick(callback, null);
    } catch (error) {
      return process.nextTick(callback, error);
    }
  }

  touch(id, data, callback) {
    try {
      run('UPDATE sessions SET expires_at = ? WHERE id = ?', [expiry(data), id]);
      return process.nextTick(callback, null);
    } catch (error) {
      return process.nextTick(callback, error);
    }
  }

  destroy(id, callback) {
    try {
      run('DELETE FROM sessions WHERE id = ?', [id]);
      return process.nextTick(callback, null);
    } catch (error) {
      return process.nextTick(callback, error);
    }
  }
}

module.exports = SqliteSessionStore;
