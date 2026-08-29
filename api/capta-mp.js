// /api/capta-mp.js — Mercado Pago (criação de assinatura + webhook)
//
// Substitui capta-mp-create.js e capta-mp-webhook.js, que foram fundidos
// para caber no limite de 12 funções do plano Hobby do Vercel.
//
// Os dois caminhos chegam por POST e são distinguidos pelo CORPO:
//   • { slug, token, plano }        -> cria assinatura, devolve { url }
//   • { type|topic, data:{ id } }   -> notificação do MP, ajusta o plano
//
// Env: MP_ACCESS_TOKEN, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, SITE_URL

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MP_TOKEN     = process.env.MP_ACCESS_TOKEN;
const SITE         = process.env.SITE_URL || 'https://capta.riseagencia.com';

const PLANOS = {
  pro:      { reason: 'Capta Pro (mensal)',      valor: 97 },
  business: { reason: 'Capta Business (mensal)', valor: 347 },
};

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const q = req.query || {};

  // ---- É notificação do Mercado Pago? ----
  // O MP manda type/topic e data.id (no corpo ou na query). O painel do
  // Capta nunca manda esses campos — manda slug e token.
  const tipoMP = body.type || body.topic || q.type || q.topic || '';
  const idMP   = (body.data && body.data.id) || q['data.id'] || q.id;

  if (tipoMP || (idMP && !body.slug)) {
    return webhook(String(tipoMP), idMP, res);
  }

  return criar(body, res);
};

// ---------------------------------------------------------------------
// Criação de assinatura (chamado pelo painel)
// ---------------------------------------------------------------------
async function criar(body, res) {
  if (!MP_TOKEN)    return res.status(500).json({ error: 'Falta MP_ACCESS_TOKEN no Vercel.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY.' });

  const slug  = (body.slug  || '').trim();
  const token = (body.token || '').trim();
  const plano = (body.plano || 'pro').trim();
  const cfg   = PLANOS[plano];

  if (!cfg)            return res.status(400).json({ error: 'Plano inválido.' });
  if (!slug || !token) return res.status(400).json({ error: 'Sem credenciais do painel.' });

  let tenant;
  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&dashboard_token=eq.${encodeURIComponent(token)}&select=id,slug,owner_email,nome&limit=1`);
    tenant = rows && rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }

  if (!tenant) return res.status(403).json({ error: 'Acesso negado.' });
  if (!tenant.owner_email) return res.status(400).json({ error: 'Cadastre um e-mail no seu negócio antes de assinar.' });

  const payload = {
    reason: cfg.reason,
    external_reference: tenant.slug,
    payer_email: tenant.owner_email,
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: cfg.valor, currency_id: 'BRL' },
    back_url: `${SITE}/dashboard.html?t=${encodeURIComponent(tenant.slug)}&k=${encodeURIComponent(token)}&pago=1`,
    // ATENÇÃO: mudou de /api/capta-mp-webhook para /api/capta-mp
    notification_url: `${SITE}/api/capta-mp`,
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
}

// ---------------------------------------------------------------------
// Webhook do Mercado Pago
// Sempre responde 200 — se devolver erro, o MP reenvia em loop.
// ---------------------------------------------------------------------
async function webhook(tipo, id, res) {
  try {
    if (!MP_TOKEN || !SERVICE_KEY || !id) return res.status(200).json({ ok: true });

    if (tipo.includes('preapproval') || tipo.includes('subscription')) {
      const r = await fetch(`https://api.mercadopago.com/preapproval/${id}`, {
        headers: { Authorization: `Bearer ${MP_TOKEN}` },
      });
      const d = await r.json();
      if (r.ok && d && d.external_reference) {
        const slug = d.external_reference;
        if (d.status === 'authorized') await setPlano(slug, 'pro');
        else if (d.status === 'cancelled' || d.status === 'paused') await setPlano(slug, 'free');
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
}

// =====================================================================
// NOTAS
//
// 1. A URL do webhook MUDOU: era /api/capta-mp-webhook, agora é
//    /api/capta-mp. Assinaturas criadas ANTES desta mudança continuam
//    apontando para a URL antiga e parariam de atualizar o plano. Hoje
//    não há assinante pagante, então não quebra nada. Se um dia houver,
//    a troca exige atualizar o notification_url de cada assinatura.
//
// 2. Se o painel (dashboard.html) chamar /api/capta-mp-create, precisa
//    ser atualizado para /api/capta-mp. Procurar por 'capta-mp-create'
//    no HTML antes de apagar os arquivos antigos.
//
// 3. O plano 'business' foi acrescentado ao PLANOS com R$ 347, seguindo
//    a escada nova (Free · Pro 97 · Business 347). O MP não valida esse
//    valor contra nada — a fonte da verdade é capta_planos no banco.
//
// 4. O webhook do plano é distinguido do create pelo CORPO da chamada:
//    o MP manda type/topic e data.id; o painel manda slug e token.
//    Nenhum dos dois manda os campos do outro, então não há ambiguidade.
// =====================================================================
