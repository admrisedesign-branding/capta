// /api/capta-auth.js — Vercel Serverless Function (Node 18+, CommonJS)
// Login unificado + onboarding freemium.
//
// POST { access_token }                    -> roteia:
//     { role:'admin',  url:'/admin.html' }
//     { role:'client', url:'/dashboard.html?t=slug&k=token' }
//     { role:'new' }                        (autenticado, sem negócio ainda -> onboarding)
//
// POST { access_token, action:'onboard', nome, whatsapp }  -> cria negócio Free e devolve:
//     { role:'client', url:'/dashboard.html?t=slug&k=token&tour=1' }
//
// Env: SUPABASE_SERVICE_ROLE_KEY (setada). SUPABASE_ANON_KEY opcional.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || 'sb_publishable_S4eWNjOtaiXTo5sr9Hek0A_42NzE4jf';

async function sbRest(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const rid = (n) => { let s = ''; const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };
function slugify(nome) {
  return (nome || 'negocio').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'negocio';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const token = (body && body.access_token) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(400).json({ error: 'Sem token de sessão.' });

  // valida token -> e-mail
  let email = '';
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(401).json({ error: 'Sessão inválida.' });
    const u = await r.json();
    email = (u && u.email ? u.email : '').toLowerCase().trim();
  } catch (e) { return res.status(401).json({ error: 'Sessão inválida.' }); }
  if (!email) return res.status(401).json({ error: 'Conta sem e-mail.' });
  const esc = encodeURIComponent(email);

  async function tenantDoDono() {
    const t = await sbRest(`capta_tenants?owner_email=ilike.${esc}&select=slug,dashboard_token,ativo&limit=1`);
    return t && t[0];
  }

  // ---------- ONBOARD ----------
  if (body.action === 'onboard') {
    try {
      const existente = await tenantDoDono();
      if (existente) {
        return res.status(200).json({ role: 'client', url: `/dashboard.html?t=${encodeURIComponent(existente.slug)}&k=${encodeURIComponent(existente.dashboard_token)}` });
      }
      const nome = (body.nome || '').toString().trim().slice(0, 80) || 'Meu negócio';
      const whatsapp = (body.whatsapp || '').toString().replace(/\D/g, '').slice(0, 15);
      let base = slugify(nome), slug = base, tries = 0;
      while (tries < 6) {
        const ex = await sbRest(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
        if (!ex || !ex.length) break;
        slug = `${base}-${rid(4)}`; tries++;
      }
      const dashboard_token = rid(24);
      const criado = await sbRest('capta_tenants', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          nome, slug, whatsapp: whatsapp || '55', owner_email: email,
          plano: 'free', integracao: 'link', ativo: true,
          headline: 'Fale com a gente', msg_template: 'Oi! Sou {nome}, vim pelo formulário.',
          dashboard_token,
        }),
      });
      const t = criado && criado[0];
      if (t) {
        try {
          await sbRest('capta_formularios', { method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ tenant_id: t.id, nome: 'Formulário principal', proposito: 'Captação geral', pubid: rid(8), pede_email: false, ativo: true }) });
        } catch (e) {}
      }
      return res.status(200).json({ role: 'client', url: `/dashboard.html?t=${encodeURIComponent(slug)}&k=${encodeURIComponent(dashboard_token)}&tour=1` });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---------- ROTEAMENTO ----------
  try {
    const admins = await sbRest(`capta_admins?email=ilike.${esc}&select=email`);
    if (admins && admins.length) return res.status(200).json({ role: 'admin', url: '/admin.html' });
  } catch (e) {}

  try {
    const t = await tenantDoDono();
    if (t && t.dashboard_token) {
      return res.status(200).json({ role: 'client', url: `/dashboard.html?t=${encodeURIComponent(t.slug)}&k=${encodeURIComponent(t.dashboard_token)}` });
    }
  } catch (e) {}

  return res.status(200).json({ role: 'new', email });
};
