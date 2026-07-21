// /api/capta-mp-create.js — cria uma ASSINATURA RECORRENTE no Mercado Pago
// POST { slug, token, plano } -> { url }  (init_point do checkout)
// Valida o tenant (slug + dashboard_token), usa owner_email como pagador
// e slug como external_reference (pra o webhook saber quem liberar).
// Env: MP_ACCESS_TOKEN (Mercado Pago), SUPABASE_SERVICE_ROLE_KEY.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MP_TOKEN     = process.env.MP_ACCESS_TOKEN;
const SITE         = process.env.SITE_URL || 'https://capta.riseagencia.com';

const PLANOS = {
  pro: { reason: 'Capta Pro (mensal)', valor: 97 },
};

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!MP_TOKEN) return res.status(500).json({ error: 'Falta MP_ACCESS_TOKEN no Vercel.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY.' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const slug = (body.slug || '').trim();
  const token = (body.token || '').trim();
  const plano = (body.plano || 'pro').trim();
  const cfg = PLANOS[plano];
  if (!cfg) return res.status(400).json({ error: 'Plano inválido.' });
  if (!slug || !token) return res.status(400).json({ error: 'Sem credenciais do painel.' });

  // valida o tenant
  let tenant;
  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&dashboard_token=eq.${encodeURIComponent(token)}&select=id,slug,owner_email,nome&limit=1`);
    tenant = rows && rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!tenant) return res.status(403).json({ error: 'Acesso negado.' });
  if (!tenant.owner_email) return res.status(400).json({ error: 'Cadastre um e-mail no seu negócio antes de assinar.' });

  // cria a assinatura (preapproval)
  const payload = {
    reason: cfg.reason,
    external_reference: tenant.slug,
    payer_email: tenant.owner_email,
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: cfg.valor, currency_id: 'BRL' },
    back_url: `${SITE}/dashboard.html?t=${encodeURIComponent(tenant.slug)}&k=${encodeURIComponent(token)}&pago=1`,
    notification_url: `${SITE}/api/capta-mp-webhook`,
  };
  try {
    const r = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'Mercado Pago: ' + (d.message || JSON.stringify(d)) });
    const url = d.init_point || d.sandbox_init_point;
    if (!url) return res.status(500).json({ error: 'Mercado Pago não retornou o link de pagamento.' });
    return res.status(200).json({ url });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
