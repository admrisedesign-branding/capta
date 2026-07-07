# Capta — Completar o deploy (funções que faltavam)

A auditoria do repositório mostrou: os HTMLs já estão no ar e corretos.
Faltavam as funções `/api`. Suba os arquivos abaixo na pasta `api/` do repositório.

## 1. Arquivos pra subir no GitHub (pasta `api/`)
- `api/capta-leads.js`         ← ESSENCIAL. Sem ele o painel do cliente fica só em modo demonstração.
- `api/capta-notify.js`        ← aviso de novo lead por e-mail (via Resend).
- `api/capta-perguntas-ia.js`  ← IA de perguntas (só liga com a chave da Anthropic; pode subir mesmo assim).

> No GitHub web: entre na pasta `api/` (ou crie, "Add file" → digite `api/capta-leads.js`) e cole o conteúdo de cada um.

## 2. Variáveis de ambiente no Vercel (Settings → Environment Variables)
Marque Production, Preview e Development:

- `SUPABASE_SERVICE_ROLE_KEY`  → **OBRIGATÓRIA**. Supabase → Settings → API → service_role.
  Sem ela o painel NÃO carrega leads reais (mesmo com a função no lugar).
- `RESEND_API_KEY`             → opcional. Sua chave do Resend, p/ o aviso de novo lead por e-mail.
- `CAPTA_FROM_EMAIL`           → opcional. Remetente verificado no Resend (ex: "Capta <capta@riseagencia.com>").
                                 Sem domínio verificado, o Resend só entrega e-mails de teste.
- `ANTHROPIC_API_KEY`          → opcional. Só p/ a IA de perguntas.

> Configure as env vars ANTES (ou faça um redeploy depois), pra o deploy nascer com elas.

## 3. Banco (confere no Supabase, caso ainda não tenha rodado)
- `freemium.sql`    → coluna `plano`.
- `integracao.sql`  → coluna `integracao`.
- (RLS do admin já foi feito.)

## 4. Testar (com um tenant real)
1. Cadastre/abra um cliente no `admin.html` e copie o link do painel (`dashboard.html?t=slug&k=token`).
2. Abra o painel: NÃO deve aparecer a faixa "Modo demonstração". Se aparecer, veja o item abaixo.
3. Preencha o `capta.html?t=slug` como um lead de teste → ele deve aparecer no painel (real).

## Se o painel ainda cair em "Modo demonstração"
Quase sempre é um destes:
- `SUPABASE_SERVICE_ROLE_KEY` não configurada no Vercel (ou deploy antes de configurar → refaça o deploy).
- Token do link (`k`) diferente do `dashboard_token` do tenant.
- A coluna `plano`/`integracao` ainda não existe (rode os SQLs).
