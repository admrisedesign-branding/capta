// /api/capta-perguntas-ia.js — Vercel Serverless Function (Node 18+)
// Gera as perguntas de qualificação com a IA da Anthropic (Claude) e salva no Supabase.
//
// Variáveis de ambiente no Vercel (Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY          (secreta)  -> sua chave da Anthropic
//   SUPABASE_SERVICE_ROLE_KEY  (secreta)  -> Supabase → Settings → API → service_role
//   SUPABASE_URL               (opcional, já tem default abaixo)

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = 'claude-sonnet-4-6';      // troque por 'claude-haiku-4-5' p/ baratear
const PLANOS_IA     = ['pro', 'business', 'gestao'];

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
  return r.status === 204 ? null : r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (!SERVICE_KEY || !ANTHROPIC_KEY)
    return res.status(500).json({ error: 'Faltam variáveis de ambiente no Vercel (ANTHROPIC_API_KEY / SUPABASE_SERVICE_ROLE_KEY).' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action, slug, token, contexto, perguntas } = body || {};
  if (!slug || !token) return res.status(400).json({ error: 'slug e token são obrigatórios.' });

  // ---- valida tenant + token + plano (server-side, à prova de DevTools) ----
  let tenant;
  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,nome,plano,dashboard_token`);
    tenant = rows && rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!tenant) return res.status(404).json({ error: 'Negócio não encontrado.' });
  if (tenant.dashboard_token !== token) return res.status(403).json({ error: 'Acesso negado.' });
  if (!PLANOS_IA.includes(tenant.plano)) return res.status(403).json({ error: 'Recurso disponível no plano Pro ou superior.' });

  // ========================= GERAR =========================
  if (action === 'gerar') {
    const ctx = contexto || {};
    const sys = `Você é especialista em geração de leads e qualificação para pequenos negócios brasileiros.
Crie de 4 a 5 perguntas para um formulário curto que a pessoa responde ANTES de cair no WhatsApp do negócio.
Cada pergunta tem de 3 a 4 alternativas. Cada alternativa tem "pontos" de 0 a 3, onde 3 = lead muito quente (alta intenção de compra e fit) e 0 = apenas curioso ou fora do perfil.
Perguntas simples, diretas, em português do Brasil, no tom do nicho. NÃO pergunte nome nem telefone (já são coletados à parte).
Responda APENAS com JSON válido, sem markdown e sem texto fora do JSON, neste formato:
{"perguntas":[{"texto":"...","opcoes":[{"label":"...","pontos":3},{"label":"...","pontos":1},{"label":"...","pontos":0}]}]}`;
    const usr = `Negócio: ${tenant.nome}
Nicho/segmento: ${ctx.nicho || '(não informado)'}
Instagram: ${ctx.instagram || '(não informado)'}
Site: ${ctx.site || '(não informado)'}
Gere as perguntas de qualificação.`;

    let aiText;
    try {
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          system: sys,
          messages: [{ role: 'user', content: usr }],
        }),
      });
      if (!ar.ok) return res.status(502).json({ error: 'IA falhou: ' + (await ar.text()).slice(0, 300) });
      const data = await ar.json();
      aiText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    } catch (e) { return res.status(502).json({ error: 'IA indisponível: ' + e.message }); }

    let parsed;
    try { parsed = JSON.parse(aiText.replace(/```json|```/g, '').trim()); }
    catch { return res.status(502).json({ error: 'A IA retornou um formato inesperado. Tente de novo.' }); }

    const limpas = (Array.isArray(parsed.perguntas) ? parsed.perguntas : [])
      .slice(0, 6)
      .map(q => ({
        texto: String(q.texto || '').slice(0, 200),
        opcoes: (q.opcoes || []).slice(0, 4).map(o => ({
          label: String(o.label || '').slice(0, 80),
          pontos: Math.max(0, Math.min(3, parseInt(o.pontos) || 0)),
        })),
      }))
      .filter(q => q.texto && q.opcoes.length >= 2);

    if (!limpas.length) return res.status(502).json({ error: 'Não consegui gerar perguntas. Tente de novo.' });
    return res.status(200).json({ perguntas: limpas });
  }

  // ========================= SALVAR =========================
  if (action === 'salvar') {
    const lista = Array.isArray(perguntas) ? perguntas : [];
    if (!lista.length) return res.status(400).json({ error: 'Nenhuma pergunta para salvar.' });
    try {
      // desativa as perguntas atuais (não-destrutivo) e insere as novas
      await sb(`capta_perguntas?tenant_id=eq.${tenant.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ativo: false }),
      });
      const rows = lista.slice(0, 8).map((q, i) => ({
        tenant_id: tenant.id,
        ordem: i + 1,
        texto: String(q.texto || '').slice(0, 200),
        opcoes: (q.opcoes || []).map(o => ({ label: String(o.label || ''), pontos: Math.max(0, Math.min(3, parseInt(o.pontos) || 0)) })),
        ativo: true,
      }));
      await sb('capta_perguntas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
    return res.status(200).json({ ok: true, total: lista.length });
  }

  return res.status(400).json({ error: 'action inválida (use "gerar" ou "salvar").' });
}
