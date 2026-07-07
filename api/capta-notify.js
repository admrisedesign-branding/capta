// /api/capta-notify.js — Vercel Serverless Function (Node 18+)
// POST body { lead_id }  -> envia e-mail pro dono do negócio avisando do novo lead (via Resend)
// É "fire-and-forget": o capta.html não espera a resposta. Se faltar chave, apenas não envia
// (nunca bloqueia a captura do lead).
//
// Variáveis de ambiente no Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (secreta)  -> obrigatória p/ ler o lead/tenant
//   RESEND_API_KEY             (secreta)  -> sua chave do Resend (opcional; sem ela, não envia)
//   CAPTA_FROM_EMAIL           (opcional) -> remetente verificado no Resend (ex: "Capta <capta@riseagencia.com>")
//   SUPABASE_URL               (opcional, default abaixo)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM         = process.env.CAPTA_FROM_EMAIL || 'Capta <onboarding@resend.dev>';
const PAINEL_BASE  = 'https://capta.riseagencia.com';

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!SERVICE_KEY) return res.status(200).json({ ok: false, skip: 'sem SUPABASE_SERVICE_ROLE_KEY' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { lead_id } = body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id obrigatório.' });

  try {
    const leads = await sb(`capta_leads?id=eq.${encodeURIComponent(lead_id)}&select=nome,contato,origem,temperatura,score,tenant_id`);
    const lead = leads && leads[0];
    if (!lead) return res.status(404).json({ error: 'lead não encontrado.' });

    const tenants = await sb(`capta_tenants?id=eq.${lead.tenant_id}&select=nome,owner_email,slug,dashboard_token`);
    const tenant = tenants && tenants[0];
    if (!tenant || !tenant.owner_email) return res.status(200).json({ ok: false, skip: 'tenant sem owner_email' });
    if (!RESEND_KEY) return res.status(200).json({ ok: false, skip: 'sem RESEND_API_KEY' });

    const painel = `${PAINEL_BASE}/dashboard.html?t=${tenant.slug}&k=${tenant.dashboard_token}`;
    const html = `<div style="font-family:system-ui,sans-serif;max-width:480px">
      <h2 style="margin:0 0 4px">Novo lead${lead.temperatura ? ' · ' + lead.temperatura : ''} 🎯</h2>
      <p style="font-size:16px;margin:8px 0"><b>${lead.nome || '—'}</b><br>${lead.contato || ''}${lead.origem ? ' · ' + lead.origem : ''}</p>
      ${lead.score != null ? `<p style="margin:4px 0;color:#555">Pontuação: ${lead.score}/100</p>` : ''}
      <p style="margin:18px 0"><a href="${painel}" style="background:#2E5BFF;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:700">Ver no painel →</a></p>
      <p style="font-size:12px;color:#999">Enviado pelo Capta</p>
    </div>`;

    const rr = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: tenant.owner_email, subject: `Novo lead — ${tenant.nome}`, html }),
    });
    if (!rr.ok) return res.status(502).json({ error: 'Resend: ' + (await rr.text()).slice(0, 200) });
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
