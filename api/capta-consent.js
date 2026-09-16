// /api/capta-consent.js — registra CONSENTIMENTO LGPD sem criar lead.
// Usado pelo site da My Robot (o lead do site vai pro Kommo e chega no Capta
// pelo espelho; o aceite chega por aqui e o banco liga os dois pelo telefone).
//
// POST {
//   slug, token,                    // identificam o cliente (vêm do admin)
//   nome, contato,                  // responsável (nome + WhatsApp só dígitos)
//   canal,                          // 'site' | 'whatsapp-bot' | 'evento' | 'matricula' | 'tablet' | 'manual'
//   consentimento: {
//     contato: true,                //   obrigatório pra gravar
//     dados_crianca, marketing, imagem, pesquisa,   // opcionais (booleanos)
//     responsavel: true,            //   declarou ser o responsável (art. 14 §5)
//     versao: 'site-v1', texto: '...', url: '...'
//   }
// }
//
// Env: SUPABASE_SERVICE_ROLE_KEY (obrigatória), SUPABASE_URL (opcional)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oaezsozoriqnkurxncjs.supabase.co';
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
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const CANAIS = ['site', 'whatsapp-bot', 'evento', 'matricula', 'tablet', 'manual'];
const FINS   = ['marketing', 'imagem', 'dados_crianca', 'pesquisa'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { slug, token, nome, contato, canal, consentimento } = body || {};
  if (JSON.stringify(body || {}).length > 8000) return res.status(413).json({ error: 'Envio muito grande.' });
  if (!slug || !token) return res.status(400).json({ error: 'slug e token são obrigatórios.' });
  if (!consentimento || typeof consentimento !== 'object' || !consentimento.contato)
    return res.status(400).json({ error: 'consentimento.contato é obrigatório.' });

  const fone = String(contato || '').replace(/\D/g, '').slice(0, 20);
  if (fone.length < 10) return res.status(400).json({ error: 'contato (WhatsApp com DDD) é obrigatório.' });

  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,ativo,ingest_token`);
    const t = rows && rows[0];
    if (!t || !t.ativo) return res.status(404).json({ error: 'Negócio não encontrado ou inativo.' });
    if (!t.ingest_token || t.ingest_token !== token) return res.status(403).json({ error: 'Token inválido.' });

    // já existe lead com esse fone? liga direto (o gatilho também faz isso, mas aqui é mais preciso)
    let leadId = null;
    try {
      const ach = await sb(`capta_leads?tenant_id=eq.${t.id}&contato=like.*${fone.slice(-8)}&select=id&order=criado_em.desc&limit=1`);
      if (ach && ach[0]) leadId = ach[0].id;
    } catch (e) {}

    const base = {
      tenant_id: t.id,
      lead_id: leadId,
      canal: CANAIS.includes(canal) ? canal : 'site',
      responsavel_nome: String(nome || '').trim().slice(0, 120) || null,
      responsavel_telefone: fone,
      declarou_responsavel: !!consentimento.responsavel,
      texto_versao: String(consentimento.versao || 'api-v1').slice(0, 40),
      registrado_por: consentimento.registrado_por ? String(consentimento.registrado_por).slice(0, 120) : null,
      evidencia: {
        texto: String(consentimento.texto || '').slice(0, 1000),
        url: consentimento.url ? String(consentimento.url).slice(0, 300) : null,
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
        ua: String(req.headers['user-agent'] || '').slice(0, 300),
      },
    };
    const fins = ['contato', ...FINS.filter(f => consentimento[f])];
    const created = await sb('capta_consentimentos', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(fins.map(finalidade => ({ ...base, finalidade }))),
    });
    return res.status(200).json({ ok: true, lead_id: leadId, finalidades: fins, ids: (created || []).map(r => r.id) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
