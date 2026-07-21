// /api/capta-auth.js — Vercel Serverless Function (Node 18+, CommonJS)
// Depois do login (e-mail/senha ou Google), decide pra onde mandar a pessoa.
//
// POST { access_token }  (ou header Authorization: Bearer <token>)
//   -> { role:'admin',  url:'/admin.html' }
//   -> { role:'client', url:'/dashboard.html?t=slug&k=token' }
//   -> { role:'none' }   (e-mail não vinculado a nenhum acesso)
//
// Regras:
//   1) e-mail em capta_admins        -> admin
//   2) e-mail == owner_email de um tenant ativo -> painel daquele cliente
//   3) senão                         -> sem acesso
//
// Env: SUPABASE_SERVICE_ROLE_KEY (já setada). SUPABASE_ANON_KEY opcional.

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const token = (body && body.access_token) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(400).json({ error: 'Sem token de sessão.' });

  // 1) valida o token na Auth do Supabase e pega o e-mail
  let email = '';
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(401).json({ error: 'Sessão inválida.' });
    const u = await r.json();
    email = (u && u.email ? u.email : '').toLowerCase().trim();
  } catch (e) { return res.status(401).json({ error: 'Sessão inválida.' }); }
  if (!email) return res.status(401).json({ error: 'Conta sem e-mail.' });

  const esc = encodeURIComponent(email);

  // 2) admin?
  try {
    const admins = await sbRest(`capta_admins?email=ilike.${esc}&select=email`);
    if (admins && admins.length) return res.status(200).json({ role: 'admin', url: '/admin.html' });
  } catch (e) { /* segue */ }

  // 3) cliente? (owner_email de um tenant ativo)
  try {
    const t = await sbRest(`capta_tenants?owner_email=ilike.${esc}&ativo=eq.true&select=slug,dashboard_token&limit=1`);
    if (t && t[0] && t[0].dashboard_token) {
      return res.status(200).json({ role: 'client', url: `/dashboard.html?t=${encodeURIComponent(t[0].slug)}&k=${encodeURIComponent(t[0].dashboard_token)}` });
    }
  } catch (e) { /* segue */ }

  return res.status(200).json({ role: 'none', email });
};
