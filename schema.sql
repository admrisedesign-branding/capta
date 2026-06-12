-- =====================================================================
-- CAPTA — app de captura + qualificação antes do WhatsApp
-- Schema multi-tenant (cada cliente da RISE = 1 tenant)
-- =====================================================================
-- Modelo: um formulário com perguntas certas fica ANTES do link do
-- WhatsApp. A pessoa responde -> é salva e pontuada -> cai no WhatsApp
-- já qualificada -> o dono vê tudo no painel. Sem CRM, sem API cara.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- TENANTS  (os negócios que assinam o Capta)
-- ---------------------------------------------------------------------
create table if not exists public.capta_tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,        -- vai na URL: /capta.html?t=slug
  nome            text not null,               -- nome do negócio
  whatsapp        text not null,               -- destino, E.164 sem '+': 5592...
  msg_template    text not null default 'Oi! Vim pelo formulário e quero saber mais. ({nome})',
  cor             text not null default '#FF6A1A',
  headline        text not null default 'Fale com a gente',
  owner_email     text,                        -- recebe aviso de lead novo
  dashboard_token text not null default encode(gen_random_bytes(12),'hex'), -- acesso ao painel (MVP)
  plano           text not null default 'pro', -- essencial | pro | gestao
  ativo           boolean not null default true,
  criado_em       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- PERGUNTAS  (o funil de cada tenant — o segredo do produto)
-- opcoes: [{"label":"Essa semana","pontos":3}, {"label":"Sem data","pontos":0}]
-- ---------------------------------------------------------------------
create table if not exists public.capta_perguntas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.capta_tenants(id) on delete cascade,
  ordem       int  not null default 0,
  texto       text not null,
  opcoes      jsonb not null,
  ativo       boolean not null default true
);
create index if not exists idx_perg_tenant on public.capta_perguntas(tenant_id, ordem);

-- ---------------------------------------------------------------------
-- LEADS  (cada pessoa que preencheu)
-- respostas: {"<pergunta_id>": {"label":"Essa semana","pontos":3}, ...}
-- ---------------------------------------------------------------------
create table if not exists public.capta_leads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.capta_tenants(id) on delete cascade,
  nome        text not null,
  contato     text,                  -- telefone/whatsapp do lead (opcional)
  respostas   jsonb not null default '{}',
  pontos      int,
  score       int,                   -- 0..100
  temperatura text,                  -- Quente | Morno | Frio
  origem      text,                  -- instagram | google | bio | anuncio...
  status      text not null default 'novo', -- novo|contatado|fechado|perdido
  criado_em   timestamptz not null default now()
);
create index if not exists idx_leads_tenant on public.capta_leads(tenant_id, criado_em desc);
create index if not exists idx_leads_temp   on public.capta_leads(tenant_id, temperatura);

-- ---------------------------------------------------------------------
-- SCORING  (canônico, no servidor)
-- Soma os pontos escolhidos / soma dos pontos máximos do funil do tenant.
-- ---------------------------------------------------------------------
create or replace function public.capta_score()
returns trigger language plpgsql as $$
declare
  v_pts int := 0;
  v_max int := 0;
  v_score int;
begin
  -- pontos escolhidos pelo lead
  select coalesce(sum((value->>'pontos')::int),0)
    into v_pts
  from jsonb_each(new.respostas);

  -- pontos máximos possíveis no funil deste tenant
  select coalesce(sum(maxp),0) into v_max from (
    select max((o->>'pontos')::int) maxp
    from public.capta_perguntas p,
         jsonb_array_elements(p.opcoes) o
    where p.tenant_id = new.tenant_id and p.ativo
    group by p.id
  ) s;

  v_score := round( v_pts::numeric / greatest(v_max,1) * 100 );

  new.pontos      := v_pts;
  new.score       := v_score;
  new.temperatura := case
    when v_score >= 70 then 'Quente'
    when v_score >= 40 then 'Morno'
    else                    'Frio'
  end;
  return new;
end;
$$;

drop trigger if exists trg_capta_score on public.capta_leads;
create trigger trg_capta_score
  before insert or update of respostas on public.capta_leads
  for each row execute function public.capta_score();

-- ---------------------------------------------------------------------
-- RLS
-- Público (anon): pode INSERIR lead e LER tenants ativos + suas perguntas
-- (o formulário precisa ler as perguntas pra montar a tela).
-- Leitura de LEADS nunca é pública — só via API com service_role.
-- ---------------------------------------------------------------------
alter table public.capta_tenants   enable row level security;
alter table public.capta_perguntas enable row level security;
alter table public.capta_leads     enable row level security;

drop policy if exists "ler tenant ativo" on public.capta_tenants;
create policy "ler tenant ativo" on public.capta_tenants
  for select to anon using (ativo = true);

drop policy if exists "ler perguntas ativas" on public.capta_perguntas;
create policy "ler perguntas ativas" on public.capta_perguntas
  for select to anon using (
    ativo = true and
    tenant_id in (select id from public.capta_tenants where ativo)
  );

drop policy if exists "anon insere lead" on public.capta_leads;
create policy "anon insere lead" on public.capta_leads
  for insert to anon with check (
    tenant_id in (select id from public.capta_tenants where ativo)
  );

-- (Observação: o dashboard_token e o owner_email ficam expostos via anon
--  na tabela tenants. Se quiser blindar, mova-os p/ uma tabela à parte sem
--  policy de leitura anon — ver README, seção Segurança.)

-- =====================================================================
-- SEED de exemplo: Natação Aquática Manaus (apague depois de testar)
-- =====================================================================
with t as (
  insert into public.capta_tenants (slug, nome, whatsapp, headline, msg_template, owner_email)
  values (
    'natacao-manaus',
    'Natação Aquática Manaus',
    '5592991755756',
    'Quer uma aula experimental?',
    'Oi! Sou {nome}, vim pelo formulário e quero saber sobre as aulas de natação.',
    'adm.risedesign@gmail.com'
  )
  returning id
)
insert into public.capta_perguntas (tenant_id, ordem, texto, opcoes)
select id, ordem, texto, opcoes::jsonb from t, (values
  (1, 'Pra quem é a aula?',
      '[{"label":"Pra mim","pontos":2},{"label":"Meu filho(a)","pontos":3},{"label":"Mais de uma pessoa","pontos":3}]'),
  (2, 'Quando você quer começar?',
      '[{"label":"Essa semana","pontos":3},{"label":"Esse mês","pontos":2},{"label":"Mês que vem","pontos":1},{"label":"Só pesquisando","pontos":0}]'),
  (3, 'Já praticou natação antes?',
      '[{"label":"Nunca","pontos":2},{"label":"Um pouco","pontos":1},{"label":"Sim, com experiência","pontos":1}]')
) as q(ordem, texto, opcoes);
