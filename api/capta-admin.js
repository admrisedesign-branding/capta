// /api/capta-admin.js — todas as leituras e escritas do painel da RISE.
// Valida o usuário pelo access_token do Supabase e confere se o e-mail está
// em capta_admins. Só então executa com a chave de serviço.
// Assim o navegador nunca precisa de permissão de escrita no banco.
//
// POST { access_token, action, ...params }
//   listar            -> { tenants, leads }
//   perguntas_listar   { tenant_id }
//   pergunta_criar     { tenant_id, ordem, texto, opcoes }
//   pergunta_apagar    { id }
//   lead_status        { lead_id, status }
//   tenant_ativo       { id, ativo }
//   tenant_salvar      { id?, payload }
//
// Env: SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS_OK    = ['novo', 'contatado', 'fechado', 'perdido'];
const PLANOS_OK    = ['free', 'pro', 'business', 'gestao'];

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
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// confirma que o token pertence a um admin da RISE
async function exigirAdmin(access_token) {
  if (!access_token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  const email = (user && user.email || '').toLowerCase().trim();
  if (!email) return null;
  const rows = await sb(`capta_admins?email=eq.${encodeURIComponent(email)}&select=email&limit=1`);
  return (rows && rows.length) ? email : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { access_token, action } = body || {};

  let admin;
  try { admin = await exigirAdmin(access_token); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  if (!admin) return res.status(403).json({ error: 'Acesso restrito à equipe da RISE.' });

  try {
    switch (action) {
      case 'listar': {
        const [tenants, leads] = await Promise.all([
          sb('capta_tenants?select=*&order=criado_em.desc'),
          sb('capta_leads?select=*,capta_tenants(nome,slug)&order=criado_em.desc&limit=2000'),
        ]);
        return res.status(200).json({ tenants: tenants || [], leads: leads || [] });
      }

      case 'perguntas_listar': {
        const { tenant_id } = body;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id obrigatório.' });
        const qs = await sb(`capta_perguntas?tenant_id=eq.${encodeURIComponent(tenant_id)}&select=*&order=ordem`);
        return res.status(200).json({ perguntas: qs || [] });
      }

      case 'pergunta_criar': {
        const { tenant_id, ordem, texto, opcoes } = body;
        if (!tenant_id || !texto || !Array.isArray(opcoes) || opcoes.length < 2)
          return res.status(400).json({ error: 'Dados incompletos da pergunta.' });
        await sb('capta_perguntas', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ tenant_id, ordem: Number(ordem) || 1, texto: String(texto).slice(0, 300), opcoes, ativo: true }),
        });
        return res.status(200).json({ ok: true });
      }

      case 'pergunta_apagar': {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id obrigatório.' });
        await sb(`capta_perguntas?id=eq.${encodeURIComponent(id)}`, {
          method: 'DELETE', headers: { Prefer: 'return=minimal' },
        });
        return res.status(200).json({ ok: true });
      }

      case 'lead_status': {
        const { lead_id, status } = body;
        if (!lead_id || !STATUS_OK.includes(status))
          return res.status(400).json({ error: 'lead_id e status válido são obrigatórios.' });
        await sb(`capta_leads?id=eq.${encodeURIComponent(lead_id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status }),
        });
        return res.status(200).json({ ok: true });
      }

      case 'tenant_ativo': {
        const { id, ativo } = body;
        if (!id) return res.status(400).json({ error: 'id obrigatório.' });
        await sb(`capta_tenants?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ativo: !!ativo }),
        });
        return res.status(200).json({ ok: true });
      }

      case 'tenant_salvar': {
        const { id, payload } = body;
        if (!payload || !payload.nome || !payload.slug)
          return res.status(400).json({ error: 'nome e slug são obrigatórios.' });
        if (payload.plano && !PLANOS_OK.includes(payload.plano))
          return res.status(400).json({ error: 'plano inválido.' });

        const limpo = {
          nome: String(payload.nome).slice(0, 120),
          slug: String(payload.slug).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60),
          whatsapp: String(payload.whatsapp || '').replace(/\D/g, '').slice(0, 20),
          headline: String(payload.headline || 'Fale com a gente').slice(0, 200),
          msg_template: String(payload.msg_template || 'Oi! Sou {nome}, vim pelo formulário.').slice(0, 400),
          owner_email: payload.owner_email ? String(payload.owner_email).toLowerCase().trim().slice(0, 160) : null,
          plano: payload.plano || 'free',
          integracao: payload.integracao || 'link',
          ativo: payload.ativo !== false,
        };

        if (id) {
          await sb(`capta_tenants?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(limpo),
          });
        } else {
          limpo.dashboard_token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
          await sb('capta_tenants', {
            method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(limpo),
          });
        }
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: 'Ação desconhecida.' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
