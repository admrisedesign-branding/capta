-- Histórico de "quem atende": cada troca de dono da conversa/lead, com o
-- login de quem fez a mudança. Só cresce; nada é apagado por aqui.
create table if not exists public.capta_atendente_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.capta_tenants(id) on delete cascade,
  conversa_id uuid,
  lead_id     uuid,
  de          text,
  para        text,
  por_nome    text,
  por_email   text,
  criado_em   timestamptz not null default now()
);
create index if not exists capta_atendente_log_conv_idx on public.capta_atendente_log (tenant_id, conversa_id, criado_em desc);
create index if not exists capta_atendente_log_lead_idx on public.capta_atendente_log (tenant_id, lead_id, criado_em desc);
alter table public.capta_atendente_log enable row level security;
