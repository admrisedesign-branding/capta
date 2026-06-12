// /api/capta-notify.js — avisa o dono do negócio quando chega um lead novo.
// Chamada pelo formulário após o insert. Usa service_role (ignora RLS).

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({error:'method'});
  const { lead_id } = req.body || {};
  if(!lead_id) return res.status(400).json({error:'lead_id obrigatório'});

  const { data: lead } = await sb.from('capta_leads').select('*').eq('id', lead_id).single();
  if(!lead) return res.status(404).json({error:'lead não encontrado'});

  const { data: t } = await sb.from('capta_tenants')
    .select('nome,owner_email,dashboard_token,slug').eq('id', lead.tenant_id).single();
  if(!t?.owner_email) return res.status(200).json({ok:true, no_email:true});

  const respostas = Object.values(lead.respostas||{})
    .map(r => `<li style="margin:3px 0">${esc(r.label)}</li>`).join('');
  const corTemp = lead.temperatura==='Quente' ? '#F5462D' : lead.temperatura==='Morno' ? '#E0930F' : '#3E7BFA';
  const painel = `${baseUrl(req)}/dashboard.html?t=${t.slug}&k=${t.dashboard_token}`;

  const r = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'Capta <leads@riseagencia.com>',
      to: [t.owner_email],
      subject: `🔥 Lead ${lead.temperatura} — ${lead.nome} (${lead.score}/100)`,
      html: `<div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;color:#16181D">
        <p style="font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#FF6A1A">${esc(t.nome)}</p>
        <h2 style="margin:6px 0 2px">${esc(lead.nome)}</h2>
        <p style="margin:0 0 12px;color:#5b6270">${esc(lead.contato||'')} ·
          <b style="color:${corTemp}">${lead.temperatura} · ${lead.score}/100</b></p>
        <p style="font-size:13px;font-weight:700;margin-bottom:4px">Respostas:</p>
        <ul style="font-size:14px;color:#5b6270;padding-left:18px;margin:0 0 16px">${respostas}</ul>
        <a href="https://wa.me/${onlyDigits(lead.contato)}" style="background:#1FA855;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:9px;display:inline-block;margin-right:8px">Chamar no WhatsApp</a>
        <a href="${painel}" style="color:#FF6A1A;text-decoration:none;font-weight:700;display:inline-block;padding:11px 0">Ver no painel →</a>
      </div>`
    })
  });
  if(!r.ok) return res.status(502).json({error:'falha no envio', detail: await r.text()});
  return res.status(200).json({ ok:true });
}

function baseUrl(req){
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}
const onlyDigits = s => (s||'').replace(/\D/g,'');
const esc = s => (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
