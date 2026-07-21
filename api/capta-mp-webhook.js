// /api/capta-mp-webhook.js — recebe o aviso do Mercado Pago e ajusta o plano.
// Assinatura autorizada  -> plano = pro
// Assinatura cancelada/pausada -> plano = free
// Sempre responde 200 rápido pro MP não reenviar em loop.
// Env: MP_ACCESS_TOKEN, SUPABASE_SERVICE_ROLE_KEY.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MP_TOKEN     = process.env.MP_ACCESS_TOKEN;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

async function setPlano(slug, plano) {
  await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ plano }),
  });
}

module.exports = async function handler(req, res) {
  try {
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const q = req.query || {};
    const type = body.type || body.topic || q.type || q.topic || '';
    const id = (body.data && body.data.id) || q['data.id'] || q.id;

    if (!MP_TOKEN || !SERVICE_KEY || !id) return res.status(200).json({ ok: true });

    // eventos de assinatura (preapproval)
    if (type.includes('preapproval') || type.includes('subscription')) {
      const r = await fetch(`https://api.mercadopago.com/preapproval/${id}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
      const d = await r.json();
      if (r.ok && d && d.external_reference) {
        const slug = d.external_reference;
        if (d.status === 'authorized') await setPlano(slug, 'pro');
        else if (d.status === 'cancelled' || d.status === 'paused') await setPlano(slug, 'free');
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true }); // nunca devolve erro pro MP
  }
};
