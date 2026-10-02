const express = require('express');
const session = require('express-session');
const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? '' : 'facilita-lar-local-dev-secret');
if (isProduction && sessionSecret.length < 32) {
  throw new Error('Defina SESSION_SECRET com pelo menos 32 caracteres antes de iniciar em produção.');
}
for (const provider of ['GOOGLE', 'MICROSOFT']) {
  if (Boolean(process.env[`${provider}_CLIENT_ID`]) !== Boolean(process.env[`${provider}_CLIENT_SECRET`])) {
    throw new Error(`Configure ${provider}_CLIENT_ID e ${provider}_CLIENT_SECRET juntos.`);
  }
}
if (Boolean(process.env.SMTP_USER) !== Boolean(process.env.SMTP_PASSWORD)) {
  throw new Error('Configure SMTP_USER e SMTP_PASSWORD juntos.');
}
if (isProduction) {
  let publicUrl;
  try { publicUrl = new URL(process.env.APP_BASE_URL); } catch { throw new Error('Defina APP_BASE_URL em produção.'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('APP_BASE_URL deve ser a origem HTTPS pública do site.');
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
    throw new Error('Configure SMTP_HOST e SMTP_FROM para confirmar e-mails em produção.');
  }
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error('SMTP_PORT deve ser uma porta TCP válida.');
  }
}

const { loadCurrentUser } = require('./src/auth');
const { csrfProtection } = require('./src/security');
const SqliteSessionStore = require('./src/session-store');
const oauth = require('./src/oauth');
const routes = require('./src/routes');
const conversations = require('./src/conversations');
const notifications = require('./src/notifications');
const reviews = require('./src/reviews');
notifications.initializeNotifications();
reviews.initializeReviews();

const app = express();
const port = process.env.PORT || 3000;

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.locals.isProduction = isProduction;
  res.locals.oauthProviders = oauth.availableProviders();
  res.locals.csrfToken = '';
  next();
});
app.use(express.urlencoded({ extended: true, limit: '16kb' }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/vendor', express.static(path.join(__dirname, 'vendor')));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'facilitalar.sid',
    secret: sessionSecret,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 12 * 60 * 60 * 1000,
    },
  })
);

app.use(loadCurrentUser);
app.use(notifications.context);
app.use(reviews.context);
app.use(csrfProtection);
app.use(notifications.router);
app.use(oauth.router);
app.use(routes);
app.use(reviews.router);
app.use(conversations);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Página não encontrada',
    message: 'A página solicitada não existe.',
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render('error', {
    title: 'Erro interno',
    message: 'Não foi possível concluir a operação agora.',
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Facilita Lar rodando em http://localhost:${port}`);
  });
}

module.exports = app;
