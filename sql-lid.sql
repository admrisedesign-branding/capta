-- @lid: identificador do WhatsApp quando o número vem oculto
alter table capta_conversas add column if not exists lid text;
alter table capta_conversas add column if not exists nome text;
alter table capta_conversas add column if not exists foto_url text;
create index if not exists capta_conversas_lid_idx on capta_conversas (tenant_id, lid);
alter table capta_leads add column if not exists lid text;
create index if not exists capta_leads_lid_idx on capta_leads (tenant_id, lid);
