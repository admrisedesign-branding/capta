// /api/capta-leads.js — Vercel Serverless Function (Node 18+)
// GET  ?t=slug&k=token  -> { tenant:{nome,plano,...}, leads:[...] }   (painel do cliente lê os leads)
// PATCH ?t=slug&k=token  body { lead_id, status }                     (muda o status de um lead)
//
// Variável de ambiente no Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (secreta)  -> Supabase → Settings → API → service_role
//   SUPABASE_URL               (opcional, default abaixo)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
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
      leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&select=id,nome,contato,origem,temperatura,score,status,criado_em,respostas&order=criado_em.desc`);
    } catch (e) { return res.status(500).json({ error: e.message }); }
    return res.status(200).json({
      tenant: { nome: tenant.nome, plano: tenant.plano, slug: tenant.slug, integracao: tenant.integracao },
      leads: leads || [],
    });
  }

  // ---------- PATCH: status de um lead ----------
  if (req.method === 'PATCH') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { lead_id, status } = body || {};
    if (!lead_id || !STATUS_OK.includes(status))
      return res.status(400).json({ error: 'lead_id e status válido são obrigatórios.' });
    try {
      // escopo no tenant: um cliente nunca altera lead de outro
      await sb(`capta_leads?id=eq.${encodeURIComponent(lead_id)}&tenant_id=eq.${tenant.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status }),
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Método não suportado (use GET ou PATCH).' });
}
