-- Agendamento extra: aula encaixada fora do horário regular (noite, fim de
-- semana, feriado). Não tem turma e não consome vaga da grade.
alter table capta_agendamentos add column if not exists extra boolean not null default false;
create index if not exists capta_agendamentos_extra_idx on capta_agendamentos (tenant_id, extra);
