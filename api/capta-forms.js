// /api/capta-forms.js — Vercel Serverless Function (Node 18+, CommonJS)
// Gerencia os formulários de um cliente (multi-formulário) e as perguntas de cada um.
// Valida sempre pelo par slug + dashboard_token (mesmo esquema do capta-leads).
//
// GET  ?t=slug&k=token
//    -> { plano, limite, usados, forms:[{ id,nome,proposito,pubid,pede_email,ativo,leads,perguntas:[...] }] }
//
// POST ?t=slug&k=token  body { action, ... }
//    action:'create'          { nome, proposito, pede_email } -> cria (respeita limite do plano)
//    action:'update'          { id, nome?, proposito?, pede_email?, ativo? } -> edita
//    action:'delete'          { id } -> apaga o formulário (e as perguntas, por cascade)
//    action:'salvar_perguntas'{ id, perguntas:[{texto,opcoes:[{label,pontos}]}] } -> substitui as perguntas
//
// Env: SUPABASE_SERVICE_ROLE_KEY (já configurada)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIMITES = { free: 1, pro: 1000000000, business: 15, gestao: 1000000000 };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const _t = await r.text();
  return _t ? JSON.parse(_t) : null;
}
const rid = () => { let s = ''; for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16); return s; };

module.exports = async function handler(req, res) {
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });
  const slug = req.query.t, token = req.query.k;
  if (!slug || !token) return res.status(400).json({ error: 't e k são obrigatórios.' });

  // valida o cliente pelo token
  let tenant;
  try {
    const rows = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,plano,dashboard_token`);
    tenant = rows && rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!tenant) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (tenant.dashboard_token !== token) return res.status(403).json({ error: 'Acesso negado.' });

  const plano = tenant.plano || 'free';
  const limite = LIMITES[plano] != null ? LIMITES[plano] : 1;
  const ownForm = async id => {
    const rows = await sb(`capta_formularios?id=eq.${encodeURIComponent(id)}&tenant_id=eq.${tenant.id}&select=id`);
    return rows && rows[0];
  };

  // ---------- GET: lista formulários + perguntas + contagem de leads ----------
  if (req.method === 'GET') {
    try {
      const forms = await sb(`capta_formularios?tenant_id=eq.${tenant.id}&select=id,nome,proposito,pubid,pede_email,ativo,criado_em&order=criado_em.asc`);
      const perg  = await sb(`capta_perguntas?tenant_id=eq.${tenant.id}&select=id,formulario_id,ordem,texto,opcoes,ativo&order=ordem.asc`);
      const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&select=formulario_id`);
      const countLeads = fid => leads.filter(l => l.formulario_id === fid).length;
      const out = (forms || []).map(f => ({
        ...f,
        leads: countLeads(f.id),
        perguntas: (perg || []).filter(p => p.formulario_id === f.id),
      }));
      return res.status(200).json({ plano, limite, usados: out.length, forms: out });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não suportado.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action } = body || {};

  try {
    // ---------- CREATE ----------
    if (action === 'create') {
      const atuais = await sb(`capta_formularios?tenant_id=eq.${tenant.id}&select=id`);
      if ((atuais || []).length >= limite)
        return res.status(403).json({ error: 'limite', limite, plano });
      const nome = String(body.nome || 'Novo formulário').slice(0, 80);
      const proposito = body.proposito ? String(body.proposito).slice(0, 200) : null;
      const pede_email = !!body.pede_email;
      const created = await sb('capta_formularios', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ tenant_id: tenant.id, nome, proposito, pede_email, pubid: rid(), ativo: true }),
      });
      return res.status(200).json({ ok: true, form: created && created[0] });
    }

    // ---------- UPDATE ----------
    if (action === 'update') {
      if (!body.id || !(await ownForm(body.id))) return res.status(403).json({ error: 'Formulário não é deste cliente.' });
      const patch = {};
      if (body.nome != null) patch.nome = String(body.nome).slice(0, 80);
      if (body.proposito != null) patch.proposito = String(body.proposito).slice(0, 200);
      if (body.pede_email != null) patch.pede_email = !!body.pede_email;
      if (body.ativo != null) patch.ativo = !!body.ativo;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada pra atualizar.' });
      await sb(`capta_formularios?id=eq.${encodeURIComponent(body.id)}&tenant_id=eq.${tenant.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return res.status(200).json({ ok: true });
    }

    // ---------- DELETE ----------
    if (action === 'delete') {
      if (!body.id || !(await ownForm(body.id))) return res.status(403).json({ error: 'Formulário não é deste cliente.' });
      await sb(`capta_formularios?id=eq.${encodeURIComponent(body.id)}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return res.status(200).json({ ok: true });
    }

    // ---------- SALVAR PERGUNTAS (manual ou pós-Maya) ----------
    if (action === 'salvar_perguntas') {
      if (!body.id || !(await ownForm(body.id))) return res.status(403).json({ error: 'Formulário não é deste cliente.' });
      const perguntas = Array.isArray(body.perguntas) ? body.perguntas : [];
      await sb(`capta_perguntas?formulario_id=eq.${encodeURIComponent(body.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      if (perguntas.length) {
        const rows = perguntas.slice(0, 10).map((q, i) => ({
          tenant_id: tenant.id, formulario_id: body.id, ordem: i + 1,
          texto: String(q.texto || '').slice(0, 300),
          opcoes: (q.opcoes || []).map(o => ({ label: String(o.label || '').slice(0, 120), pontos: Number(o.pontos) || 0 })),
          ativo: true,
        }));
        await sb('capta_perguntas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
      }
      return res.status(200).json({ ok: true, count: perguntas.length });
    }

    return res.status(400).json({ error: 'action inválida.' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
