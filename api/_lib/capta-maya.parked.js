// /api/capta-maya.js — Vercel Serverless Function (Node 18+, CommonJS)
// A "Maya": gera perguntas de qualificação com IA e salva num formulário.
//
// POST body:
//   { action:'gerar', slug, token, contexto:{ nicho, instagram, site, objetivo, pede_email } }
//     -> { perguntas:[{ texto, opcoes:[{label,pontos}] }] }   (prévia, não salva)
//   { action:'salvar', slug, token, formulario_id, perguntas:[...] }
//     -> { ok:true, count }   (substitui as perguntas daquele formulário)
//
// Variáveis de ambiente no Vercel:
//   SUPABASE_SERVICE_ROLE_KEY  (secreta) — já configurada
//   ANTHROPIC_API_KEY          (secreta) — a chave da Maya (sk-ant-...)
//   MAYA_MODEL                 (opcional) — modelo da Anthropic (default abaixo)
//   SUPABASE_URL               (opcional)

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = process.env.MAYA_MODEL || 'claude-sonnet-5';

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const _t = await r.text();
  return _t ? JSON.parse(_t) : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action, slug, token, formulario_id, contexto, perguntas } = body || {};
  if (!slug || !token) return res.status(400).json({ error: 'slug e token são obrigatórios.' });

  // valida o cliente pelo token
  let tenant;
  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,nome,plano,dashboard_token`);
    tenant = rows && rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!tenant) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (tenant.dashboard_token !== token) return res.status(403).json({ error: 'Acesso negado.' });

  // ---------- GERAR (IA) ----------
  if (action === 'gerar') {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY no Vercel (a Maya precisa dela).' });
    const c = contexto || {};
    if (!c.nicho) return res.status(400).json({ error: 'Conta pra Maya o que o negócio faz.' });
    const pedeEmail = !!c.pede_email;

    const prompt = `Você é a Maya, especialista em qualificação de leads. Um negócio quer um formulário curto que capture contatos e separe quem tem intenção real (Quente) de quem é só curioso (Frio).

Negócio: ${c.nicho}
${c.instagram ? `Instagram: ${c.instagram}` : ''}
${c.site ? `Site: ${c.site}` : ''}
${c.objetivo ? `Objetivo do formulário: ${c.objetivo}` : ''}

Crie de 3 a 4 perguntas de qualificação curtas e diretas, adequadas a esse negócio. Cada pergunta tem 2 a 3 opções. Cada opção tem pontos de 0 a 3:
- 3 = forte intenção/urgência
- 2 = interesse real
- 1 = interesse morno
- 0 = curioso / sem intenção

As perguntas devem separar quente/morno/frio conforme o serviço. NÃO pergunte nome nem telefone${pedeEmail ? ' nem e-mail' : ''} (isso é capturado à parte).

Responda APENAS com JSON válido, sem texto antes ou depois, no formato exato:
{"perguntas":[{"texto":"...","opcoes":[{"label":"...","pontos":3},{"label":"...","pontos":1},{"label":"...","pontos":0}]}]}`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Maya (Anthropic): ' + (await r.text()).slice(0, 300) });
      const data = await r.json();
      let txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      txt = txt.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      let parsed;
      try { parsed = JSON.parse(txt); } catch { return res.status(502).json({ error: 'A Maya não retornou um formato válido. Tente de novo.' }); }
      const out = (parsed.perguntas || [])
        .filter(q => q && q.texto && Array.isArray(q.opcoes) && q.opcoes.length)
        .slice(0, 5)
        .map(q => ({ texto: String(q.texto).slice(0, 300), opcoes: q.opcoes.slice(0, 4).map(o => ({ label: String(o.label || '').slice(0, 120), pontos: Number(o.pontos) || 0 })) }));
      return res.status(200).json({ perguntas: out });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ---------- SALVAR ----------
  if (action === 'salvar') {
    if (!formulario_id) return res.status(400).json({ error: 'formulario_id obrigatório.' });
    if (!Array.isArray(perguntas) || !perguntas.length) return res.status(400).json({ error: 'Sem perguntas pra salvar.' });
    try {
      // confirma que o formulário é deste cliente
      const forms = await sb(`capta_formularios?id=eq.${encodeURIComponent(formulario_id)}&tenant_id=eq.${tenant.id}&select=id`);
      if (!forms || !forms[0]) return res.status(403).json({ error: 'Formulário não pertence a este cliente.' });

      // substitui as perguntas do formulário
      await sb(`capta_perguntas?formulario_id=eq.${encodeURIComponent(formulario_id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      const rows = perguntas.slice(0, 8).map((q, i) => ({
        tenant_id: tenant.id,
        formulario_id,
        ordem: i + 1,
        texto: String(q.texto || '').slice(0, 300),
        opcoes: (q.opcoes || []).map(o => ({ label: String(o.label || '').slice(0, 120), pontos: Number(o.pontos) || 0 })),
        ativo: true,
      }));
      await sb('capta_perguntas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
      return res.status(200).json({ ok: true, count: rows.length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: 'action inválida (use "gerar" ou "salvar").' });
};
