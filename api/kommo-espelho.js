// api/kommo-espelho.js — espelho Kommo → Capta (só leitura do Kommo)
//
// Como ligar no Kommo: Configurações → Integrações → Webhooks → adicionar
//   URL: https://capta.riseagencia.com/api/kommo-espelho
//   Eventos: Lead adicionado · Lead alterado · Etapa do lead alterada
//
// Backfill manual (um lead por vez): GET https://capta.riseagencia.com/api/kommo-espelho?lead_id=123456
//
// Mora no projeto do CAPTA (Vercel), que já tem as variáveis do Supabase.
// Variável NOVA a criar no Vercel do Capta: KOMMO_TOKEN (mesmo valor do projeto da My Robot).

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
};
// no CONTATO (não no lead): idade da criança
const CAMPO_IDADE_CONTATO = 'Idade da criança';

let cache = { fields: null, statuses: null, tenant: null, at: 0 };

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
    for (const s of p._embedded?.statuses || []) cache.statuses[s.id] = { nome: s.name, tipo: s.type, pipeline: p.id };
  cache.at = Date.now();
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

const ts = s => (s ? new Date(s * 1000).toISOString() : null);

async function espelhar(leadId) {
  await carregarMeta();
  const lead = await kget(`/api/v4/leads/${leadId}?with=contacts,loss_reason`);
  if (!lead) return { lead_id: leadId, skip: 'não encontrado' };

  const contatoId = lead._embedded?.contacts?.find(c => c.is_main)?.id || lead._embedded?.contacts?.[0]?.id;
  const contato = contatoId ? await kget(`/api/v4/contacts/${contatoId}`) : null;
  const st = cache.statuses[lead.status_id] || {};
  const dataAula = valorCampo(lead, CAMPOS.data_aula);

  const linha = {
    tenant_id: await tenantId(),
    kommo_lead_id: lead.id,
    kommo_pipeline: lead.pipeline_id,
    kommo_status: lead.status_id,
    etapa_nome: st.nome || null,
    nome: contato?.name || lead.name || null,
    contato: telefoneContato(contato),
    origem: valorCampo(lead, CAMPOS.porta) || 'kommo',
    fonte: valorCampo(lead, CAMPOS.fonte),
    porta: valorCampo(lead, CAMPOS.porta),
    atendente: valorCampo(lead, CAMPOS.atendente),
    crianca: valorCampo(lead, CAMPOS.crianca),
    idade: idadeContato(contato),
    curso: valorCampo(lead, CAMPOS.curso),
    data_aula: typeof dataAula === 'number' ? ts(dataAula) : dataAula,
    bloco: valorCampo(lead, CAMPOS.bloco),
    pagamento: valorCampo(lead, CAMPOS.pagamento),
    valor: lead.price || 0,
    tags: (lead._embedded?.tags || []).map(t => t.name),
    ganho_em: st.tipo === 1 ? ts(lead.closed_at) : null,        // type 1 = ganho
    perdido_em: st.tipo === 2 ? ts(lead.closed_at) : null,      // type 2 = perdido
    motivo_perda: lead._embedded?.loss_reason?.[0]?.name || null,
    kommo_criado_em: ts(lead.created_at),
    espelhado_em: new Date().toISOString(),
  };

  const r = await fetch(`${SB_URL}/rest/v1/capta_leads?on_conflict=tenant_id,kommo_lead_id`, {
    method: 'POST',
    headers: { ...H_SB, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(linha),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return { lead_id: lead.id, etapa: linha.etapa_nome, fonte: linha.fonte, porta: linha.porta };
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

module.exports = async function handler(req, res) {
  try {
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
};
