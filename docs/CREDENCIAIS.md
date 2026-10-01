# Ativar login externo e envio de e-mail

Este guia começa pelo teste local. Você precisa de acesso às suas contas Google e Microsoft para criar as credenciais: o projeto não pode criá-las sem a sua autorização nesses serviços. **Não envie IDs secretos, senhas SMTP ou o arquivo `.env` pelo chat nem para o GitHub.**

## 1. Preparar o arquivo local

No PowerShell, dentro de `C:\Projetos\FacilitaLar`:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Abra `.env` e coloque o resultado do segundo comando em `SESSION_SECRET`. Mantenha `APP_BASE_URL=http://localhost:3000` para o teste local. O `.env` já está no `.gitignore`.

## 2. Criar credenciais do Google

1. Abra o [Google Auth Platform](https://console.cloud.google.com/auth/overview) e crie ou selecione um projeto.
2. Configure **Branding** com o nome `Facilita Lar`, e-mail de suporte e as informações solicitadas. Em **Audience**, escolha público externo se o site aceitar qualquer conta Google. Enquanto o aplicativo estiver em teste, inclua sua conta em **Test users**.
3. Em [Clients](https://console.cloud.google.com/auth/clients), escolha **Create client** e o tipo **Web application**.
4. Em **Authorized redirect URIs**, adicione exatamente `http://localhost:3000/auth/google/callback`. Quando tiver domínio público, adicione também `https://SEU-DOMINIO/auth/google/callback` no cliente usado em produção.
5. Copie **Client ID** para `GOOGLE_CLIENT_ID` e **Client secret** para `GOOGLE_CLIENT_SECRET` no `.env`. Guarde o segredo em local seguro.

O aplicativo solicita apenas `openid`, `email` e `profile`. Consulte o [guia oficial do Google para aplicativos web](https://developers.google.com/identity/protocols/oauth2/web-server) se a interface do painel mudar.

## 3. Criar credenciais da Microsoft

1. Entre no [Microsoft Entra admin center](https://entra.microsoft.com/) com uma conta que possa registrar aplicativos.
2. Vá em **Entra ID > App registrations > New registration** e dê o nome `Facilita Lar`.
3. Para usar contas pessoais como Outlook.com e Hotmail, selecione **Personal accounts only**. Deixe `MICROSOFT_TENANT_ID=consumers` no `.env`. Se quiser apenas contas de uma organização, use o ID real desse tenant em vez de `consumers`.
4. Em **Authentication**, adicione uma plataforma **Web** com `http://localhost:3000/auth/microsoft/callback`. Quando tiver domínio, adicione `https://SEU-DOMINIO/auth/microsoft/callback` ao aplicativo de produção.
5. Na página **Overview**, copie **Application (client) ID** para `MICROSOFT_CLIENT_ID`.
6. Em **Certificates & secrets > Client secrets > New client secret**, crie um segredo e copie o campo **Value** para `MICROSOFT_CLIENT_SECRET`. Não confunda **Value** com **Secret ID**; anote também quando ele expira.

Veja os guias oficiais de [registro do aplicativo](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [URI de retorno](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri) e [criação do segredo](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).

## 4. Configurar o envio de e-mail

Para testes locais, você pode deixar `SMTP_HOST` e `SMTP_FROM` vazios. O link de confirmação aparecerá somente na sessão do navegador que fez o cadastro. **Isso não serve para produção.**

Para publicar, obtenha de um serviço de e-mail SMTP os dados abaixo e configure no servidor:

| Variável | O que colocar |
| --- | --- |
| `SMTP_HOST` | Endereço do servidor SMTP fornecido pelo serviço. |
| `SMTP_PORT` | Normalmente `587` (STARTTLS) ou `465` (TLS direto). |
| `SMTP_SECURE` | `false` para 587; `true` para 465. |
| `SMTP_USER` | Usuário SMTP fornecido pelo serviço. |
| `SMTP_PASSWORD` | Senha ou chave SMTP, nunca sua senha de login do site. |
| `SMTP_FROM` | Remetente autorizado pelo serviço, por exemplo `Facilita Lar <contato@seudominio.com>`. |

Em produção, o envio pela porta 587 exige STARTTLS. Consulte as [opções SMTP do Nodemailer](https://nodemailer.com/smtp/) e as instruções do seu provedor. O domínio e o remetente podem precisar de validação no provedor antes que as mensagens sejam entregues.

## 5. Testar

1. Reinicie o servidor com `npm start` após alterar `.env`.
2. Acesse `http://localhost:3000/entrar`. Cada botão social aparece quando o par de credenciais daquele provedor está completo.
3. Teste o login com uma conta sua. Se a Microsoft não informar um e-mail confirmado, o Facilita Lar solicitará confirmação por link antes do acesso.
4. Cadastre uma conta por e-mail e senha para testar confirmação, recuperação de senha e o recebimento de mensagens.

Para publicar, ajuste `APP_BASE_URL` para a origem HTTPS real, configure `NODE_ENV=production`, `SESSION_SECRET`, SMTP e as credenciais no ambiente do servidor. Use um banco de produção separado e defina `ADMIN_EMAIL` e `ADMIN_PASSWORD` para o primeiro administrador. A confirmação de e-mail **não é** verificação em duas etapas; o segundo fator ainda não foi implementado.
