-- Registro de ligações: o Capta não faz a chamada (quem disca é o telefone),
-- mas guarda o que aconteceu. É isso que faz a ligação contar como
-- atendimento, sair da fila de "sem resposta" e aparecer no histórico.
create table if not exists public.capta_ligacoes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.capta_tenants(id) on delete cascade,
  lead_id     uuid,
  conversa_id uuid,
  telefone    text,
  resultado   text not null,          -- falou | nao_atendeu | numero_errado | ligar_depois | caixa_postal
  observacao  text,
  retornar_em timestamptz,            -- quando o lead pediu pra ligar depois
  por_nome    text,
  por_email   text,
  criado_em   timestamptz not null default now()
);
create index if not exists capta_ligacoes_lead_idx on public.capta_ligacoes (tenant_id, lead_id, criado_em desc);
create index if not exists capta_ligacoes_conv_idx on public.capta_ligacoes (tenant_id, conversa_id, criado_em desc);
create index if not exists capta_ligacoes_retorno_idx on public.capta_ligacoes (tenant_id, retornar_em) where retornar_em is not null;
alter table public.capta_ligacoes enable row level security;
