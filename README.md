# Facilita Lar

Aplicação web para contratação e gestão de serviços domésticos.

## Tecnologias

- Node.js
- Express
- EJS
- SQLite nativo do Node
- Bootstrap

## Como rodar

```bash
npm install
npm start
```

Acesse:

```text
http://localhost:3000
```

## Contas iniciais

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

## Funcionalidades

- Catálogo público de serviços com busca e filtro por categoria.
- Cadastro e login de usuários.
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
