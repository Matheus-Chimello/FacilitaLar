const express = require('express');
const session = require('express-session');
const path = require('path');

const { loadCurrentUser } = require('./src/auth');
const routes = require('./src/routes');
const conversations = require('./src/conversations');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/vendor', express.static(path.join(__dirname, 'vendor')));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'facilita-lar-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

app.use(loadCurrentUser);
app.use(routes);
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
