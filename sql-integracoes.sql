-- conectores por negócio (Meta Ads hoje; outros depois)
create table if not exists capta_integracoes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references capta_tenants(id) on delete cascade,
  servico text not null,                 -- 'meta_ads'
  conta_id text, conta_nome text,
  token text,                            -- guardado só no servidor
  ativo boolean not null default true,
  ultimo_sync timestamptz, ultimo_erro text,
  criado_em timestamptz not null default now());
alter table capta_integracoes enable row level security;
create unique index if not exists capta_integracoes_uk on capta_integracoes (tenant_id, servico);
