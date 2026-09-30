const { get, imageOptions, imageLabels } = require('./db');
const { formatDistance } = require('./location');

const roleLabels = {
  admin: 'Administrador',
  provider: 'Prestador',
  customer: 'Contratante',
};

function setFlash(req, type, message) {
  req.session.flash = { type, message };
  if (req.res) req.res.locals.flash = req.session.flash;
}

function loadCurrentUser(req, res, next) {
  const userId = req.session.userId;
  const user = userId
    ? get('SELECT id, name, email, role, phone, city, bio, active, latitude, longitude, postal_code, location_address FROM users WHERE id = ?', [userId])
    : null;

  if (user && user.active) {
    req.user = user;
    res.locals.currentUser = user;
  } else {
    delete req.session.userId;
    req.user = null;
    res.locals.currentUser = null;
  }

  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  res.locals.roleLabels = roleLabels;
  res.locals.imageLabel = (value) => imageLabels[imageOptions.indexOf(value)] || 'Imagem do serviço';
  res.locals.formatDistance = formatDistance;
  res.locals.formatCurrency = (value) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
  res.locals.formatDate = (value) => {
    if (!value) return '';
    const localAppointment = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (localAppointment) return `${localAppointment[3]}/${localAppointment[2]}/${localAppointment[1]}, ${localAppointment[4]}:${localAppointment[5]}`;
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: value.includes('T') ? 'short' : undefined,
    }).format(new Date(value.includes(' ') ? `${value.replace(' ', 'T')}Z` : value));
  };
  res.locals.formatMessageDate = (value) => new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(`${value.replace(' ', 'T')}Z`));
  res.locals.statusLabel = (status) =>
    ({
      pending: 'Aguardando confirmação',
      accepted: 'Confirmado',
      in_progress: 'Em andamento',
      completed: 'Concluído',
      canceled: 'Cancelado',
    }[status] || status);
  res.locals.statusClass = (status) =>
    ({
      pending: 'warning',
      accepted: 'info',
      in_progress: 'primary',
      completed: 'success',
      canceled: 'secondary',
    }[status] || 'secondary');

  delete req.session.flash;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    setFlash(req, 'warning', 'Entre na sua conta para continuar.');
    return res.redirect('/entrar');
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      setFlash(req, 'warning', 'Entre na sua conta para continuar.');
      return res.redirect('/entrar');
    }

    if (!roles.includes(req.user.role)) {
      setFlash(req, 'danger', 'Seu perfil não tem acesso a esta área.');
      return res.redirect(dashboardPath(req.user.role));
    }

    return next();
  };
}

function dashboardPath(role) {
  if (role === 'admin') return '/admin';
  if (role === 'provider') return '/prestador';
  return '/contratante';
}

module.exports = {
  roleLabels,
  setFlash,
  loadCurrentUser,
  requireAuth,
  requireRole,
  dashboardPath,
};
