// /api/capta-leads.js — entrega os leads de um tenant para o painel.
// Protegida por token (MVP): o painel só lê se o ?k= bater com dashboard_token.
// Usa service_role no servidor (a anon key nunca lê leads).

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

export default async function handler(req, res){
  const slug  = req.query.t;
  const token = req.query.k || req.headers['x-capta-token'];
  if(!slug || !token) return res.status(400).json({error:'t e k obrigatórios'});

  const { data: t } = await sb.from('capta_tenants')
    .select('id,nome,dashboard_token,plano').eq('slug', slug).single();
  if(!t) return res.status(404).json({error:'tenant não encontrado'});
  if(token !== t.dashboard_token) return res.status(401).json({error:'token inválido'});

  // GET => lista leads | PATCH => atualiza status de um lead
  if(req.method === 'PATCH'){
    const { lead_id, status } = req.body || {};
    if(!lead_id || !status) return res.status(400).json({error:'lead_id e status obrigatórios'});
    await sb.from('capta_leads').update({ status }).eq('id', lead_id).eq('tenant_id', t.id);
    return res.status(200).json({ ok:true });
  }

  const { data: leads } = await sb.from('capta_leads')
    .select('id,nome,contato,respostas,score,temperatura,origem,status,criado_em')
    .eq('tenant_id', t.id).order('criado_em', { ascending:false }).limit(300);

  return res.status(200).json({
    tenant: { nome: t.nome, plano: t.plano },
    leads: leads || []
  });
}
