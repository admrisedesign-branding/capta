// api/capta-kommo.js — integrações com o Kommo, num arquivo só (limite de 12 funções do plano Hobby)
//
//   ?acao=espelho  (padrão)  → espelho Kommo → Capta. Webhook do Kommo aponta pra cá:
//                              https://capta.riseagencia.com/api/capta-kommo   (lead adicionado/alterado/etapa alterada)
//                              backfill: ...?acao=espelho&lead_id=123456
//
// Variáveis: KOMMO_TOKEN · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · CRON_SECRET
//            KOMMO_ACCOUNT_ID (opcional: só aceita webhook da sua conta)

// ───────────── ESPELHO ─────────────

const KOMMO = `https://${process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com'}`;
const H_KOMMO = { Authorization: `Bearer ${process.env.KOMMO_TOKEN}` };
const SB_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const TENANT_SLUG = process.env.CAPTA_TENANT_SLUG || 'my-robot-manaus';
const H_SB = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

// Campos do Kommo lidos PELO NOME (criados na tela, sem colar ID)
const CAMPOS = {
  fonte: 'Fonte', porta: 'Porta', atendente: 'Quem atendeu', crianca: 'Filho',
  curso: 'Curso', data_aula: 'Data da aula', bloco: 'Bloco', pagamento: 'Pagamento',
  score: 'Score', categoria: 'Categoria', origem: 'Origem', bairro: 'Bairro',
  area: 'Área', trilha: 'Trilha', momento: 'Momento',
};
// No Kommo, 142 = Venda ganha e 143 = Venda perdida em qualquer funil; o campo "type"
// só vem preenchido na etapa de entrada, então não dá pra confiar só nele.
const ehGanho  = st => st.id === 142 || st.tipo === 1 || /ganha|aluno ativo|matriculado/i.test(st.nome || '');
const ehPerda  = st => st.id === 143 || st.tipo === 2 || /perdida|perdido|closed.?lost/i.test(st.nome || '');
// etapa do Kommo → status do Capta (novo · contatado · fechado · perdido)
function statusDe(st) {
  if (ehGanho(st)) return 'fechado';
  if (ehPerda(st)) return 'perdido';
  return /novo lead|incoming/i.test(st.nome || '') ? 'novo' : 'contatado';
}
const cap = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : null);

// O bot do WhatsApp grava o NÚMERO da opção; o formulário do site já grava o texto.
// Estas são as listas do bot (QUALIFICA_WHATSAPP): traduzimos na leitura.
const LEGENDA = {
  bairro: { '1':'Adrianópolis', '2':'Ponta Negra', '3':'Nossa Senhora das Graças / Vieiralves', '4':'Parque Dez', '5':'Flores', '6':'Aleixo', '7':'Outro bairro' },
  area:   { '1':'Robótica', '2':'Programação', '3':'Inteligência Artificial', '4':'Jogos', '5':'Ainda não sei' },
  momento:{ '1':'Quero matricular', '2':'Quero aula experimental', '3':'Pesquisando opções', '4':'Só conhecendo' },
};
const traduz = (campo, v) => { const t = String(v ?? '').trim(); if (!t) return null; return (LEGENDA[campo] && LEGENDA[campo][t]) || t; };
// "João Vitor, 8 anos" / "Lucas 7" → { nome, idade }
function criancaDe(texto) {
  const t = String(texto || '').trim(); if (!t) return {};
  const m = t.match(/^(.*?)[,\s-]+(\d{1,2})\s*(anos?|a)?\.?$/i);
  if (m && Number(m[2]) >= 2 && Number(m[2]) <= 18) return { nome: m[1].trim().replace(/[,\-]$/, ''), idade: Number(m[2]) };
  return { nome: t.replace(/\s*\d{1,2}\s*anos?\.?$/i, '').trim() || null };
}
// no CONTATO (não no lead): idade da criança
const CAMPO_IDADE_CONTATO = 'Idade da criança';

let cache = { fields: null, statuses: null, tenant: null, etapas: null, at: 0 };

async function kget(path) {
  const r = await fetch(KOMMO + path, { headers: H_KOMMO });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`Kommo ${r.status} em ${path}`);
  return r.json();
}

async function carregarMeta() {
  if (cache.fields && Date.now() - cache.at < 10 * 60 * 1000) return;
  const [cf, pipes] = await Promise.all([
    kget('/api/v4/leads/custom_fields?limit=250'),
    kget('/api/v4/leads/pipelines'),
  ]);
  cache.fields = {};
  for (const f of cf?._embedded?.custom_fields || []) cache.fields[f.name.trim().toLowerCase()] = f.id;
  cache.statuses = {};
  for (const p of pipes?._embedded?.pipelines || [])
    for (const s of p._embedded?.statuses || []) cache.statuses[s.id] = { id: s.id, nome: s.name, tipo: s.type, pipeline: p.id };
  cache.at = Date.now();
}

// etapas do Capta ligadas às do Kommo (capta_etapas.kommo_status_id)
async function etapaDoKommo(tenant, statusId) {
  if (!cache.etapas || Date.now() - cache.at > 10 * 60 * 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/capta_etapas?tenant_id=eq.${tenant}&kommo_status_id=not.is.null&select=id,kommo_status_id`, { headers: H_SB });
    const rows = r.ok ? await r.json() : [];
    cache.etapas = Object.fromEntries(rows.map(e => [String(e.kommo_status_id), e.id]));
  }
  return cache.etapas[String(statusId)] || null;
}

async function tenantId() {
  if (cache.tenant) return cache.tenant;
  const r = await fetch(`${SB_URL}/rest/v1/capta_tenants?slug=eq.${TENANT_SLUG}&select=id`, { headers: H_SB });
  const [t] = await r.json();
  if (!t) throw new Error('tenant não encontrado: ' + TENANT_SLUG);
  cache.tenant = t.id;
  return t.id;
}

function valorCampo(lead, nome) {
  const id = cache.fields[nome.toLowerCase()];
  if (!id) return null;
  const f = (lead.custom_fields_values || []).find(x => x.field_id === id);
  return f?.values?.[0]?.value ?? null;
}

function idadeContato(contato) {
  const f = (contato?.custom_fields_values || []).find(x => (x.field_name || '').toLowerCase() === CAMPO_IDADE_CONTATO.toLowerCase());
  const v = f?.values?.[0]?.value;
  const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function telefoneContato(contato) {
  const f = (contato?.custom_fields_values || []).find(x => x.field_code === 'PHONE');
  return f?.values?.[0]?.value?.replace(/\D/g, '') || null;
}


// Contato humano no chat do Kommo. O WhatsApp Lite não diz quem enviou (created_by = 0 sempre),
// então a regra é de tempo: resposta do bot sai em segundos depois da mensagem do lead;
// mensagem enviada SEM mensagem recebida nos últimos N segundos foi uma pessoa.
const JANELA_BOT = Number(process.env.KOMMO_BOT_JANELA_SEG || 120);
async function houveContatoHumano(contatoId) {
  if (!contatoId) return false;
  const ev = await kget(`/api/v4/events?filter[entity]=contact&filter[entity_id]=${contatoId}&filter[type][]=incoming_chat_message&filter[type][]=outgoing_chat_message&limit=100`);
  const lista = (ev?._embedded?.events || []).map(e => ({ t: e.type, at: e.created_at })).sort((a, b) => a.at - b.at);
  let ultimaEntrada = -1e12;
  for (const e of lista) {
    if (e.t === 'incoming_chat_message') { ultimaEntrada = e.at; continue; }
    if (e.at - ultimaEntrada > JANELA_BOT) return true; // saída sem entrada recente = pessoa
  }
  return false;
}
const ts = s => (s ? new Date(s * 1000).toISOString() : null);

async function espelhar(leadId) {
  await carregarMeta();
  const lead = await kget(`/api/v4/leads/${leadId}?with=contacts,loss_reason`);
  if (!lead) return { lead_id: leadId, skip: 'não encontrado' };

  const contatoId = lead._embedded?.contacts?.find(c => c.is_main)?.id || lead._embedded?.contacts?.[0]?.id;
  const contato = contatoId ? await kget(`/api/v4/contacts/${contatoId}`) : null;
  let st = cache.statuses[lead.status_id] || {};
  const dataAula = valorCampo(lead, CAMPOS.data_aula);

  // Novo lead + já houve mensagem enviada por PESSOA (não pelo bot) → Em contato, no Kommo e aqui
  if (/novo lead/i.test(st.nome || '')) {
    const humano = await houveContatoHumano(contatoId).catch(() => false);
    if (humano) {
      const alvo = Object.entries(cache.statuses).find(([id, x]) => /em contato/i.test(x.nome || '') && x.pipeline === lead.pipeline_id);
      if (alvo) {
        const r = await fetch(`${KOMMO}/api/v4/leads/${lead.id}`, { method: 'PATCH', headers: { ...H_KOMMO, 'Content-Type': 'application/json' }, body: JSON.stringify({ status_id: Number(alvo[0]) }) });
        if (r.ok) { lead.status_id = Number(alvo[0]); st = cache.statuses[lead.status_id]; }
      }
    }
  }

  const linha = {
    tenant_id: await tenantId(),
    kommo_lead_id: lead.id,
    kommo_pipeline: lead.pipeline_id,
    kommo_status: lead.status_id,
    etapa_nome: st.nome || null,
    etapa_id: await etapaDoKommo(await tenantId(), lead.status_id),
    etapa_em: ts(lead.updated_at) || new Date().toISOString(),
    nome: contato?.name || lead.name || null,
    contato: telefoneContato(contato),
    origem: valorCampo(lead, CAMPOS.porta) || valorCampo(lead, CAMPOS.origem) || 'kommo',
    score: valorCampo(lead, CAMPOS.score) != null ? Number(valorCampo(lead, CAMPOS.score)) : null,
    temperatura: cap(valorCampo(lead, CAMPOS.categoria)),   // Quente · Morno · Frio
    status: statusDe(st),
    notas: [
      traduz('bairro',  valorCampo(lead, CAMPOS.bairro))  ? 'Bairro: '   + traduz('bairro',  valorCampo(lead, CAMPOS.bairro))  : null,
      traduz('area',    valorCampo(lead, CAMPOS.area))    ? 'Interesse: '+ traduz('area',    valorCampo(lead, CAMPOS.area))    : null,
      traduz('momento', valorCampo(lead, CAMPOS.momento)) ? 'Momento: '  + traduz('momento', valorCampo(lead, CAMPOS.momento)) : null,
      valorCampo(lead, CAMPOS.trilha) ? 'Trilha: ' + valorCampo(lead, CAMPOS.trilha) : null,
    ].filter(Boolean).join(' · ') || null,
    fonte: valorCampo(lead, CAMPOS.fonte),
    porta: valorCampo(lead, CAMPOS.porta),
    atendente: valorCampo(lead, CAMPOS.atendente),
    crianca: criancaDe(valorCampo(lead, CAMPOS.crianca)).nome,
    idade: idadeContato(contato) ?? criancaDe(valorCampo(lead, CAMPOS.crianca)).idade ?? null,
    curso: valorCampo(lead, CAMPOS.curso),
    data_aula: typeof dataAula === 'number' ? ts(dataAula) : dataAula,
    bloco: valorCampo(lead, CAMPOS.bloco),
    pagamento: valorCampo(lead, CAMPOS.pagamento),
    valor: lead.price || 0,
    tags: (lead._embedded?.tags || []).map(t => t.name),
    ganho_em: ehGanho(st) ? (ts(lead.closed_at) || ts(lead.updated_at)) : null,
    perdido_em: ehPerda(st) ? (ts(lead.closed_at) || ts(lead.updated_at)) : null,
    motivo_perda: lead._embedded?.loss_reason?.[0]?.name || null,
    kommo_criado_em: ts(lead.created_at),
    criado_em: ts(lead.created_at),      // data real do lead, não a hora do espelho
    espelhado_em: new Date().toISOString(),
  };

  const r = await fetch(`${SB_URL}/rest/v1/capta_leads?on_conflict=tenant_id,kommo_lead_id`, {
    method: 'POST',
    headers: { ...H_SB, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(linha),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  // ganho no Kommo (Aluno Ativo) → vira aluno em Alunos, se ainda não for
  if (ehGanho(st)) {
    try {
      const lr = await fetch(`${SB_URL}/rest/v1/capta_leads?tenant_id=eq.${linha.tenant_id}&kommo_lead_id=eq.${lead.id}&select=id&limit=1`, { headers: H_SB }).then(x => x.json());
      const leadId = lr?.[0]?.id;
      if (leadId) {
        const ja = await fetch(`${SB_URL}/rest/v1/capta_alunos?tenant_id=eq.${linha.tenant_id}&lead_id=eq.${leadId}&select=id&limit=1`, { headers: H_SB }).then(x => x.json());
        if (!ja?.length) await fetch(`${SB_URL}/rest/v1/capta_alunos`, { method: 'POST', headers: { ...H_SB, Prefer: 'return=minimal' }, body: JSON.stringify({
          tenant_id: linha.tenant_id, lead_id: leadId, nome: linha.crianca || linha.nome || 'Aluno novo', nome_curto: linha.crianca || null,
          kit: linha.curso || 'First', status: 'ativo', observacao: 'Matriculado pelo Kommo — definir a turma em Alunos' }) });
      }
    } catch (e) { /* não bloqueia o espelho */ }
  }
  // relê o que ficou salvo (gatilhos podem alterar score/temperatura/status)
  const g = await fetch(`${SB_URL}/rest/v1/capta_leads?tenant_id=eq.${linha.tenant_id}&kommo_lead_id=eq.${lead.id}&select=score,temperatura,status,origem,criado_em,tags`, { headers: H_SB }).then(x => x.json()).catch(() => null);
  return { lead_id: lead.id, etapa: linha.etapa_nome, fonte: linha.fonte, porta: linha.porta,
    enviado: { score: linha.score, temperatura: linha.temperatura, status: linha.status, origem: linha.origem },
    salvo: Array.isArray(g) ? g[0] : g };
}

// O Kommo manda form-urlencoded com chaves tipo leads[status][0][id]
function idsDoWebhook(body) {
  const ids = new Set();
  const obj = typeof body === 'string' ? Object.fromEntries(new URLSearchParams(body)) : body || {};
  for (const k of Object.keys(obj)) {
    const m = k.match(/^leads\[(add|update|status)\]\[\d+\]\[id\]$/);
    if (m) ids.add(Number(obj[k]));
  }
  return [...ids];
}

async function espelho(req, res) {
  try {
    // GET manual (backfill) exige o segredo; POST é o webhook do Kommo, que traz account_id
    if (req.method === 'GET' && req.query?.lead_id) {
      const esperado = (process.env.MIG_SECRET || process.env.CRON_SECRET || '').trim();
      const recebido = String(req.query.secret || '').trim();
      if (!esperado || recebido !== esperado) return res.status(401).json({ erro: 'Informe o segredo para o backfill manual.' });
    } else if (req.method === 'POST') {
      const conta = process.env.KOMMO_ACCOUNT_ID;
      const obj = typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : (req.body || {});
      const daConta = obj['account[id]'] || obj.account_id || (obj.account && obj.account.id);
      if (conta && daConta && String(daConta) !== String(conta)) return res.status(200).json({ ok: true, ignorado: 'outra conta' });
    }
    const ids = req.method === 'GET' && req.query?.lead_id
      ? [Number(req.query.lead_id)]
      : idsDoWebhook(req.body);
    if (!ids.length) return res.status(200).json({ ok: true, nada: true });

    const out = [];
    for (const id of ids) {
      try { out.push(await espelhar(id)); }
      catch (e) { out.push({ lead_id: id, erro: e.message }); }
    }
    return res.status(200).json({ ok: true, out });
  } catch (e) {
    console.error('kommo-espelho', e);
    return res.status(200).json({ ok: false, erro: e.message }); // 200 pro Kommo não desligar o webhook
  }
}

module.exports = async function handler(req, res) {
  return espelho(req, res);
};
