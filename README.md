# Facilita Lar

Aplicação web para contratação e gestão de serviços domésticos.

## Tecnologias

- Node.js
- Express
- EJS
- SQLite nativo do Node
- Bootstrap
- OpenID Connect (Google e Microsoft, quando configurados)
- SMTP para confirmação de e-mail

## Como rodar

```bash
npm install
npm start
```

Acesse:

```text
http://localhost:3000
```

Para testar integrações locais, copie `.env.example` para `.env` e configure as variáveis necessárias. O arquivo `.env` não é enviado ao Git. O passo a passo para criar as credenciais está em [docs/CREDENCIAIS.md](docs/CREDENCIAIS.md).

## Contas de demonstração (somente desenvolvimento)

Administrador:

```text
admin@facilitalar.com
admin123
```

Prestador:

```text
ana@facilitalar.com
provider123
```

Também é possível criar novas contas como contratante ou prestador em `/cadastro`.
Novas contas criadas por e-mail e senha só podem entrar após confirmar o link de verificação. Sem SMTP, o link aparece na página de confirmação apenas em desenvolvimento.

## Funcionalidades

- Catálogo público de serviços com busca e filtro por categoria.
- Categorias comuns do mercado já cadastradas, sem sobrescrever as personalizações do administrador.
- Cadastro e login de usuários.
- Entrada com Google ou Microsoft quando as credenciais OpenID Connect estão configuradas.
- Confirmação de e-mail antes do primeiro acesso por senha e limitação de tentativas de login.
- Recuperação de senha por link temporário, que encerra as sessões antigas.
- Convite para prestadores em `/anunciar`, com acesso ao cadastro e ao login.
- Perfis de administrador, prestador e contratante.
- Contratante pode solicitar serviços e acompanhar status.
- Prestador pode cadastrar, editar, pausar e ativar serviços.
- Prestador pode atualizar o status das solicitações recebidas.
- Prestador configura até dois períodos de trabalho por dia e bloqueia datas em `/prestador/agenda`.
- Cada serviço tem duração prevista; o cliente escolhe apenas horários livres nos próximos 60 dias.
- Solicitações aguardam confirmação do prestador, e intervalos sobrepostos são bloqueados entre todos os seus serviços.
- Administrador pode gerenciar usuários, categorias, serviços e solicitações.
- Administrador também pode cadastrar serviços, vinculando cada um a um prestador ativo.
- Cliente e prestador conversam em cada solicitação, com histórico e avisos de mensagens não lidas.
- Prestador envia propostas de valor; o cliente pode aceitar ou recusar. O valor aceito fica registrado no atendimento.
- Busca de serviços e prestadores por proximidade, com raios de 1, 3, 5, 10, 20 e 50 km.
- Cadastro do CEP do ponto de atendimento do prestador em `/prestador/localizacao`.
- Interface responsiva com a logo original do projeto e degradês.

## Busca por proximidade

O prestador informa e valida o CEP do ponto de atendimento no painel, em **Minha localização**. O cliente pode pesquisar por CEP no catálogo ou na página de prestadores, escolher o raio ou usar **Usar minha localização**. Apenas profissionais com um ponto cadastrado aparecem na busca por raio. A distância é aproximada e calculada em linha reta, sem estimativa de deslocamento.

A consulta usa a API CEP v2 da BrasilAPI. O ponto retornado pelo CEP pode ser aproximado; para maior precisão, o prestador pode usar a localização do navegador junto do CEP validado. Alguns CEPs válidos não retornam coordenadas, caso em que a localização do navegador é necessária para cadastrar o ponto. Se o CEP da busca não tiver coordenadas, o site pede a localização do navegador em vez de exibir resultados imprecisos. A consulta requer acesso à internet.

A localização do navegador requer autorização do usuário e funciona em `localhost` ou em um domínio com HTTPS. As contas de demonstração não recebem coordenadas fictícias.

## Conversas e propostas

O botão **Conversar** fica junto de cada solicitação nos painéis. As mensagens são atualizadas automaticamente a cada quatro segundos. A administração pode consultar o histórico; o envio de mensagens e as propostas ficam restritos aos envolvidos. Aceitar uma proposta de valor não confirma o horário: a confirmação cabe ao prestador. Atendimentos concluídos ou cancelados mantêm o histórico disponível para consulta.

## Agenda e solicitações

Os prestadores de demonstração começam com horários de segunda a sexta, das 8h às 12h e das 13h às 18h. Novos prestadores configuram a própria agenda antes de receber solicitações. O prestador pode confirmar ou recusar um horário solicitado; o cliente pode cancelar uma solicitação ainda não concluída. Solicitações não canceladas ocupam o intervalo, inclusive entre serviços diferentes do mesmo prestador. O cancelamento libera o horário. A agenda usa o horário de São Paulo.

## Testes

```bash
npm test
```

Os testes usam um banco temporário, separado dos cadastros do projeto. A variável `FACILITALAR_DATABASE_PATH` permite selecionar outro arquivo SQLite.

## Banco de dados

O banco SQLite é criado automaticamente em:

```text
database/facilitalar.sqlite
```

As tabelas principais são:

- `users`
- `categories`
- `services`
- `service_requests`
- `request_messages`
- `request_quotes`
- `provider_hours`
- `provider_days_off`
- `sessions`
- `login_failures`
- `email_verification_tokens`
- `password_reset_tokens`
- `email_requests`
- `oauth_identities`

## Preparação para publicação

Use Node.js 24 ou superior e um domínio com HTTPS. Em produção (`NODE_ENV=production`), a aplicação exige `SESSION_SECRET` com pelo menos 32 caracteres, `APP_BASE_URL` com a origem HTTPS, `SMTP_HOST` e `SMTP_FROM`. Gere um segredo aleatório com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` e guarde-o apenas nas variáveis do servidor. Configure `TRUST_PROXY=1` somente se houver exatamente um proxy reverso confiável terminando o HTTPS.

Em um banco de produção novo, configure `ADMIN_EMAIL` e `ADMIN_PASSWORD` (mínimo de 12 caracteres) para criar o primeiro administrador. A produção não cria prestadores ou serviços de demonstração e recusa iniciar se contas demo existentes ainda usarem as senhas padrão. Faça backup do SQLite e não reutilize o banco local de testes sem revisar as contas.

Para ativar o login Google, crie um cliente OAuth de aplicação web e configure `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. Cadastre exatamente `https://SEU-DOMINIO/auth/google/callback` como URI de redirecionamento (ou `http://localhost:3000/auth/google/callback` para teste local).

Para ativar o login Microsoft, registre uma aplicação web e configure `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` e `MICROSOFT_TENANT_ID` (`consumers` para contas pessoais). Cadastre `https://SEU-DOMINIO/auth/microsoft/callback` (ou `http://localhost:3000/auth/microsoft/callback` localmente). Os botões só aparecem quando cada par de credenciais está completo. Contas locais existentes não são vinculadas automaticamente por igualdade de e-mail.

Configure também `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` e `SMTP_FROM` conforme o provedor de e-mail. Em desenvolvimento sem SMTP, o link de confirmação aparece somente para quem fez o cadastro naquela sessão. Em produção, ele é enviado apenas por e-mail.
