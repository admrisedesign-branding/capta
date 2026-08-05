// /api/capta-relatorios.js — Vercel Serverless Function (Node 18+, CommonJS)
// Lê os relatórios mensais (snapshot) de um cliente para a aba Relatórios do painel.
// Mesmo modelo de segurança do capta-leads: valida slug + dashboard_token no
// servidor e usa a service_role. O navegador nunca lê a tabela direto.
//
// GET ?t=slug&k=token            -> { tenant:{nome,plano,slug}, relatorios:[{mes,dados,atualizado_em}] }
// GET ?t=slug&k=token&mes=2026-07 -> idem, só aquele mês
//
// Env no Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (secreta) — já configurada
//   SUPABASE_URL               (opcional, default abaixo)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  const slug  = req.query.t;
  const token = req.query.k;
  const mes   = req.query.mes;
  if (!slug || !token) return res.status(400).json({ error: 't e k são obrigatórios.' });

  // valida o cliente pelo token (server-side) — igual ao capta-leads
  let tenant;
  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,nome,plano,slug,dashboard_token`);
    tenant = rows && rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!tenant) return res.status(404).json({ error: 'Negócio não encontrado.' });
  if (tenant.dashboard_token !== token) return res.status(403).json({ error: 'Acesso negado.' });

  // busca os relatórios publicados desse cliente
  let filtroMes = '';
  if (mes) filtroMes = `&mes=eq.${encodeURIComponent(mes)}`;
  let relatorios;
  try {
    relatorios = await sb(
      `capta_relatorios?tenant_id=eq.${tenant.id}&publicado=is.true${filtroMes}` +
      `&select=mes,dados,atualizado_em&order=mes.desc`
    );
  } catch (e) {
    // se a tabela ainda não existe no banco, não quebra o painel: devolve vazio
    const msg = String(e.message || '');
    if (msg.includes('capta_relatorios') || msg.includes('42P01')) {
      return res.status(200).json({ tenant: { nome: tenant.nome, plano: tenant.plano, slug: tenant.slug }, relatorios: [] });
    }
    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({
    tenant: { nome: tenant.nome, plano: tenant.plano, slug: tenant.slug },
    relatorios: relatorios || [],
  });
};
