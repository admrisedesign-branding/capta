-- Aula experimental em hora aberta sem turma regular: o agendamento fica sem turma.
alter table capta_agendamentos alter column turma_id drop not null;
