// /api/capta-leads.js — Vercel Serverless Function (Node 18+)
// GET  ?t=slug&k=token  -> { tenant:{nome,plano,...}, leads:[...] }   (painel do cliente lê os leads)
// PATCH ?t=slug&k=token  body { lead_id, status }                     (muda o status de um lead)
// DELETE ?t=slug&k=token body { lead_id }                             (exclui um lead)
//
// Variável de ambiente no Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (secreta)  -> Supabase → Settings → API → service_role
//   SUPABASE_URL               (opcional, default abaixo)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oaezsozoriqnkurxncjs.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS_OK    = ['novo', 'contatado', 'fechado', 'perdido'];

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

module.exports = async function handler(req, res) {
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  const slug  = req.query.t;
  const token = req.query.k;
  if (!slug || !token) return res.status(400).json({ error: 't e k são obrigatórios.' });

  // valida o tenant pelo token (server-side)
  let tenant;
  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,nome,plano,slug,integracao,dashboard_token`);
    tenant = rows && rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!tenant) return res.status(404).json({ error: 'Negócio não encontrado.' });
  if (tenant.dashboard_token !== token) return res.status(403).json({ error: 'Acesso negado.' });

  // ---------- GET: tenant + leads ----------
  if (req.method === 'GET') {
    let leads;
    try {
      leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&select=id,nome,contato,origem,temperatura,score,status,criado_em,respostas,tags,etapa_nome,fonte,porta,atendente,kommo_lead_id,ganho_em,campanha,anuncio_id,perdido_em,valor,data_aula,curso,kommo_criado_em,etapa_em,evento_id,notas,crianca,idade,notas,data_aula,etapa_em,perdido_em,valor&order=criado_em.desc`);
    } catch (e) {
      // banco ainda sem a coluna de notas: segue sem ela
      try {
        leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&select=id,nome,contato,origem,temperatura,score,status,criado_em,respostas,tags,etapa_nome,fonte,porta,atendente,kommo_lead_id,ganho_em,perdido_em,valor,data_aula,curso,kommo_criado_em,etapa_em,evento_id,notas,crianca,idade&order=criado_em.desc`);
      } catch (e2) { return res.status(500).json({ error: e2.message }); }
    }
    // espera de resposta (vem da conversa aberta do lead)
    try {
      const convs = await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=not.is.null&resolvida_em=is.null&select=lead_id,aguardando_desde,nao_lidas,ultima_mensagem_em`);
      const por = {}; (convs || []).forEach(c => { const a = por[c.lead_id]; if (!a || new Date(c.ultima_mensagem_em||0) > new Date(a.ultima_mensagem_em||0)) por[c.lead_id] = c; });
      (leads || []).forEach(l => { const c = por[l.id]; if (c) { l.aguardando_desde = c.aguardando_desde; l.nao_lidas = c.nao_lidas; l.ultima_mensagem_em = c.ultima_mensagem_em; } });
    } catch (e) {}
    return res.status(200).json({
      tenant: { nome: tenant.nome, plano: tenant.plano, slug: tenant.slug, integracao: tenant.integracao },
      leads: leads || [],
    });
  }

  // ---------- PATCH: status e/ou anotações de um lead ----------
  if (req.method === 'PATCH') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { lead_id, status, notas } = body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id é obrigatório.' });

    const patch = {};
    if (status !== undefined) {
      if (!STATUS_OK.includes(status)) return res.status(400).json({ error: 'status inválido.' });
      patch.status = status;
    }
    if (notas !== undefined) patch.notas = String(notas || '').slice(0, 4000);
    if (!Object.keys(patch).length)
      return res.status(400).json({ error: 'Informe status ou notas.' });

    try {
      // escopo no tenant: um cliente nunca altera lead de outro
      await sb(`capta_leads?id=eq.${encodeURIComponent(lead_id)}&tenant_id=eq.${tenant.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('notas'))
        return res.status(500).json({ error: 'A coluna de anotações ainda não existe no banco. Rode o SQL sql-notas.sql no Supabase.' });
      return res.status(500).json({ error: e.message });
    }
    return res.status(200).json({ ok: true });
  }

  // ---------- DELETE: exclui um lead (escopado no tenant) ----------
  if (req.method === 'DELETE') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { lead_id } = body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id é obrigatório.' });
    try {
      // escopo no tenant: um cliente nunca apaga lead de outro
      await sb(`capta_leads?id=eq.${encodeURIComponent(lead_id)}&tenant_id=eq.${tenant.id}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Método não suportado (use GET, PATCH ou DELETE).' });
}
