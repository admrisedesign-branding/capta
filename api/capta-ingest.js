// /api/capta-ingest.js — recebe leads de SITES EXTERNOS (integração "Form externo / API").
// O site do cliente tem o formulário dele; aqui o lead entra no Capta já pontuado.
//
// POST {
//   slug, token,                       // identificam o cliente (vêm do admin)
//   nome, contato, origem,
//   respostas: [ { texto, label, pontos } ],
//   extra: { bairro, cidade, ... }     // vira anotação no lead
// }
//
// A nota (0–100) e a temperatura NÃO vêm do site: quem calcula é o gatilho
// do banco, usando as perguntas cadastradas para o tenant. Por isso as
// perguntas do Capta precisam espelhar as do site (ver sql-capta-ingest.sql).
//
// Env: SUPABASE_SERVICE_ROLE_KEY (obrigatória), SUPABASE_URL (opcional)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
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

// tira acento/caixa pra casar o texto da pergunta com a cadastrada
const norm = s => String(s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

module.exports = async function handler(req, res) {
  // o site do cliente roda em outro domínio — precisa liberar CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { slug, token, nome, contato, origem, respostas, extra } = body || {};

  if (!slug || !token) return res.status(400).json({ error: 'slug e token são obrigatórios.' });
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'nome é obrigatório.' });

  try {
    // 1) valida o cliente
    const rows = await sb(
      `capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,nome,ativo,ingest_token`
    );
    const t = rows && rows[0];
    if (!t || !t.ativo) return res.status(404).json({ error: 'Negócio não encontrado ou inativo.' });
    if (!t.ingest_token || t.ingest_token !== token) {
      return res.status(403).json({ error: 'Token inválido.' });
    }

    // 2) formulário principal (mais antigo ativo)
    let formId = null;
    try {
      const forms = await sb(
        `capta_formularios?tenant_id=eq.${t.id}&ativo=is.true&select=id&order=criado_em.asc&limit=1`
      );
      if (forms && forms[0]) formId = forms[0].id;
    } catch { /* sem formulário cadastrado: segue sem vincular */ }

    // 3) casa cada resposta com a pergunta cadastrada (pelo texto; se não
    //    achar, cai pela ordem). O gatilho soma os pontos de qualquer jeito.
    const perg = await sb(
      `capta_perguntas?tenant_id=eq.${t.id}&select=id,texto,ordem&order=ordem.asc`
    );
    const byTexto = new Map((perg || []).map(p => [norm(p.texto), p.id]));

    const lista = Array.isArray(respostas) ? respostas.slice(0, 20) : [];
    const ans = {};
    lista.forEach((r, i) => {
      const key =
        byTexto.get(norm(r && r.texto)) ||
        ((perg && perg[i] && perg[i].id) || 'q' + (i + 1));
      ans[key] = {
        label: String((r && r.label) || '').slice(0, 160),
        pontos: Number(r && r.pontos) || 0,
      };
    });

    // 4) campos livres viram anotação do lead
    let notas = '';
    if (extra && typeof extra === 'object') {
      notas = Object.keys(extra)
        .slice(0, 12)
        .filter(k => extra[k] !== null && extra[k] !== undefined && extra[k] !== '')
        .map(k => `${k}: ${String(extra[k]).slice(0, 120)}`)
        .join(' · ')
        .slice(0, 1000);
    }

    const lead = {
      tenant_id: t.id,
      nome: String(nome).trim().slice(0, 120),
      contato: String(contato || '').replace(/\D/g, '').slice(0, 20) || null,
      respostas: ans,
      origem: String(origem || 'site').slice(0, 60),
    };
    if (formId) lead.formulario_id = formId;
    if (notas) lead.notas = notas;

    const created = await sb('capta_leads', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(lead),
    });
    const novo = Array.isArray(created) ? created[0] : created;

    // 5) avisa o dono por e-mail — nunca bloqueia a gravação
    if (novo && novo.id) {
      try {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        fetch(`https://${host}/api/capta-notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lead_id: novo.id }),
        }).catch(() => {});
      } catch { /* ignora */ }
    }

    // Se o gatilho de unificação fundiu este lead em outro (mesmo telefone
    // nos últimos 30 dias), o banco não devolve linha nova — e isso é sucesso.
    const fundido = !novo;
    return res.status(200).json({
      ok: true,
      merged: fundido,
      id: fundido ? null : novo.id,
      score: fundido ? null : novo.score,
      temperatura: fundido ? null : novo.temperatura,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
