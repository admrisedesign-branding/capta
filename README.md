# Capta

Formulário inteligente que fica **antes do link do WhatsApp**. A pessoa responde
nome + perguntas certas → é salva e pontuada → cai no WhatsApp já qualificada →
o dono vê tudo num painel. Sem CRM, sem API cara de WhatsApp.

```
capta/
├── capta.html              # formulário público (o que o lead preenche)
├── dashboard.html          # painel do cliente (lê dados reais via API)
├── api/capta-notify.js     # avisa o dono por e-mail a cada lead novo
├── api/capta-leads.js      # entrega/atualiza leads do painel (token)
├── supabase/schema.sql     # multi-tenant: tenants, perguntas, leads, scoring
└── package.json
```

## O modelo (o que você vende)

Você **não** vende "um formulário". Vende *pare de perder cliente no WhatsApp*:
captura + qualificação + pontuação de todo interessado, painel pra ver quem está
quente, aviso na hora. Empacotado como **assinatura mensal**.

- **A qualificação acontece NO formulário**, antes do WhatsApp — não é um robô
  digitando dentro do WhatsApp (isso exigiria a API oficial da Meta, com custo
  por conversa; fica como upsell futuro). O form pergunta, pontua e redireciona.
- **Quem cria as perguntas é a RISE**, sob medida pra cada negócio. É aí que mora
  o valor: as perguntas certas + a pontuação certa. Replicável e difícil de copiar.
- **Cada cliente = 1 tenant.** Tem o próprio link, perguntas, pontuação e painel.

Tiers naturais:
- **Capta puro** — form antes do link, sem landing. Ticket menor, ótimo pra quem
  já tem tráfego (anúncio, bio movimentada).
- **Capta + landing** — a landing convence (força de design da RISE), o form
  captura. Setup único da landing + assinatura. Ticket maior.

## Como funciona, por dentro

1. A pessoa abre `capta.html?t=<slug-do-cliente>` (o link que substitui o "chama no zap").
2. O form lê do Supabase o tenant + as perguntas e monta a tela.
3. Ela responde → grava em `capta_leads` → um **trigger pontua no servidor**
   (soma dos pontos escolhidos ÷ pontos máximos do funil) → Quente/Morno/Frio.
4. Redireciona pro `wa.me` do cliente com a mensagem pronta.
5. `capta-notify` manda e-mail pro dono com as respostas, score e link do painel.
6. O cliente acompanha tudo no `dashboard.html`.

## Deploy

### 1. Supabase
- Rode `supabase/schema.sql` no SQL Editor (ele já cria um tenant de exemplo:
  *Natação Aquática Manaus*, slug `natacao-manaus`).
- Pegue em *Settings → API*: **Project URL**, **anon key**, **service_role key**.

### 2. Preencher chaves públicas
No topo do `<script>` de **`capta.html`**:
```js
const SUPABASE_URL  = 'https://SEU-PROJETO.supabase.co';
const SUPABASE_ANON = 'SUA_ANON_KEY';
```
(O `dashboard.html` não precisa de chave — ele lê pela API.)

### 3. Variáveis na Vercel
```
SUPABASE_URL           = https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE  = sua_service_role_key   (NUNCA vai pro front)
RESEND_API_KEY         = re_...
RESEND_FROM            = Capta <leads@riseagencia.com>   (domínio verificado)
```

### 4. Subir
GitHub → importar na Vercel (ou `vercel --prod`). A Vercel instala as deps sozinha.
- Formulário: `/capta.html?t=natacao-manaus`
- Painel: pegue o `dashboard_token` do tenant na tabela e abra
  `/dashboard.html?t=natacao-manaus&k=<dashboard_token>`

### 5. Testar
Preencha o form com seu nome/WhatsApp → confira o lead na tabela `capta_leads`
(já com score/temperatura), o e-mail de aviso, e o lead aparecendo no painel.

## Cadastrar um novo cliente (onboarding)

Dois inserts no Supabase — em ~5 min você tem um cliente no ar:

```sql
-- 1) o negócio
insert into capta_tenants (slug, nome, whatsapp, headline, msg_template, owner_email)
values ('clinica-bella', 'Clínica Bella', '5592999990000',
        'Agende sua avaliação', 'Oi! Sou {nome}, quero agendar uma avaliação.',
        'dono@clinicabella.com')
returning id, dashboard_token;   -- guarde o token: é o acesso ao painel

-- 2) as perguntas do funil (troque <TENANT_ID> pelo id acima)
insert into capta_perguntas (tenant_id, ordem, texto, opcoes) values
('<TENANT_ID>',1,'Qual procedimento te interessa?',
 '[{"label":"Limpeza de pele","pontos":2},{"label":"Botox/preenchimento","pontos":3},{"label":"Só pesquisando","pontos":0}]'),
('<TENANT_ID>',2,'Quando pretende fazer?',
 '[{"label":"Esse mês","pontos":3},{"label":"Em alguns meses","pontos":1}]');
```
Entregue ao cliente o link `capta.html?t=clinica-bella` e o acesso ao painel.

## Segurança (notas de MVP)

- O **service_role** só roda nas funções da Vercel; nunca vai pro navegador.
- O painel é protegido por `dashboard_token` (link não-adivinhável). Para algo mais
  forte, o próximo passo é **Supabase Auth** (login do cliente) com RLS por tenant.
- `owner_email` e `dashboard_token` hoje são legíveis via anon na tabela `tenants`.
  Se quiser blindar, mova esses campos pra uma tabela `tenant_secrets` sem policy
  de leitura anon.
- O scoring confia nos pontos enviados pelo form. Para impedir manipulação,
  o trigger pode recalcular os pontos a partir das opções salvas em
  `capta_perguntas` (hardening — não é crítico, o lead só "burlaria" o próprio score).

## Roadmap

- **Checkout Mercado Pago** (assinatura recorrente) ligando pagamento ↔ acesso.
- **Supabase Auth** no painel (login por cliente).
- **WhatsApp API oficial** (conversa automática dentro do WhatsApp) como upsell premium.
- **Editor de perguntas** no painel, pra você montar funis sem mexer no SQL.
