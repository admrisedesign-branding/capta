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
  // freio de abuso: campos longos e payload gigante são recusados antes de tocar no banco
  const tam = JSON.stringify(body || {}).length;
  if (tam > 20000) return res.status(413).json({ error: 'Envio muito grande.' });
  if (String(nome || '').length > 120 || String(contato || '').length > 30 || String(origem || '').length > 60)
    return res.status(400).json({ error: 'Campos acima do tamanho permitido.' });

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

    // 2) perguntas cadastradas — servem para pontuar E para escolher o formulário
    const perg = await sb(
      `capta_perguntas?tenant_id=eq.${t.id}&ativo=is.true&select=id,texto,ordem,formulario_id&order=ordem.asc`
    );

    // 3) formulário principal: o mais antigo ativo QUE TENHA PERGUNTAS.
    //    Um formulário vazio no mesmo cliente não pode capturar os leads.
    let formId = null;
    try {
      const forms = await sb(
        `capta_formularios?tenant_id=eq.${t.id}&ativo=is.true&select=id&order=criado_em.asc`
      );
      const lista = forms || [];
      const comPerguntas = new Set((perg || []).map(p => p.formulario_id).filter(Boolean));
      const escolhido = lista.find(f => comPerguntas.has(f.id)) || lista[0];
      if (escolhido) formId = escolhido.id;
    } catch { /* sem formulário cadastrado: segue sem vincular */ }
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

    // 4) campos conhecidos entram em colunas próprias; o resto vira anotação
    const CONHECIDOS = ['fonte','porta','atendente','crianca','idade','evento_id','kommo_lead_id','notas','temperatura','curso'];
    const campos = {};
    let notas = '';
    if (extra && typeof extra === 'object') {
      for (const k of CONHECIDOS) {
        const v = extra[k];
        if (v === null || v === undefined || v === '') continue;
        if (k === 'idade') campos.idade = Number(v) || null;
        else if (k === 'kommo_lead_id') campos.kommo_lead_id = Number(v) || null;
        else if (k === 'notas') notas = String(v).slice(0, 1000);
        else campos[k] = String(v).slice(0, 160);
      }
      const sobra = Object.keys(extra).filter(k => !CONHECIDOS.includes(k))
        .slice(0, 12)
        .filter(k => extra[k] !== null && extra[k] !== undefined && extra[k] !== '')
        .map(k => `${k.replace(/_/g, ' ')}: ${String(extra[k]).slice(0, 120)}`)
        .join(' · ');
      notas = [notas, sobra].filter(Boolean).join(' · ').slice(0, 1000);
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
    Object.assign(lead, campos);
    // veio de evento: acha o evento cadastrado pelo nome (sem precisar de id fixo)
    if (!lead.evento_id && extra && extra.evento_nome) {
      try {
        const alvo = String(extra.evento_nome).trim().toLowerCase();
        const evs = await sb(`capta_eventos?tenant_id=eq.${t.id}&select=id,nome,data_inicio&order=data_inicio.desc&limit=50`);
        const limpa = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
        const a1 = limpa(alvo);
        const achou = (evs || []).find(e => limpa(e.nome) === a1)
          || (evs || []).find(e => limpa(e.nome).includes(a1) || a1.includes(limpa(e.nome)));
        if (achou) lead.evento_id = achou.id;
        else {
          // evento novo: cadastra sozinho, pra não perder o rastreio
          const criado = await sb('capta_eventos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
            tenant_id: t.id, nome: String(extra.evento_nome).slice(0, 120), local: extra.evento_local || null,
            cidade: 'Manaus', data_inicio: (extra.evento_data || new Date().toISOString().slice(0, 10)).slice(0, 10),
            tipo: 'evento', ativo: true, observacao: 'criado pelo app de captação' }) });
          if (criado && criado[0]) lead.evento_id = criado[0].id;
        }
      } catch (e) {}
    }
    // lead de evento já entra na primeira etapa do funil, pronto pro atendimento
    try {
      const et = await sb(`capta_etapas?tenant_id=eq.${t.id}&nome=ilike.novo%20lead&select=id&limit=1`);
      if (et && et[0]) { lead.etapa_id = et[0].id; lead.etapa_em = new Date().toISOString(); }
    } catch (e) {}

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
