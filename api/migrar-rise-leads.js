// api/migrar-rise-leads.js — migração ONE-OFF: copia as tabelas do projeto antigo (rise-leads)
// pro projeto novo (capta-dev), preservando IDs. Apagar este arquivo depois da migração.
//
// Uso (GET, com o CRON_SECRET do projeto):
//   https://capta.riseagencia.com/api/migrar-rise-leads?secret=<CRON_SECRET>            → copia tudo
//   https://capta.riseagencia.com/api/migrar-rise-leads?secret=<CRON_SECRET>&so=capta_leads → só uma tabela
//   ...&dry=1 → só conta as linhas dos dois lados, não grava nada
//
// Variáveis (Vercel do capta):
//   MIG_SRC_URL  = https://wpoeigoledhzyvomudgf.supabase.co   (rise-leads)
//   MIG_SRC_KEY  = service_role do rise-leads
//   MIG_DST_URL  = https://oaezsozoriqnkurxncjs.supabase.co   (capta-dev)
//   MIG_DST_KEY  = service_role do capta-dev
//   CRON_SECRET  = já existe

const SRC = { url: process.env.MIG_SRC_URL, key: process.env.MIG_SRC_KEY };
const DST = { url: process.env.MIG_DST_URL, key: process.env.MIG_DST_KEY };

// ordem respeita as chaves estrangeiras
const TABELAS = [
  'capta_tenants', 'capta_planos', 'capta_admins', 'capta_usuarios', 'capta_etapas',
  'capta_formularios', 'capta_perguntas', 'capta_leads', 'capta_turmas', 'capta_agenda_bloqueios',
  'capta_canais', 'capta_conversas', 'capta_mensagens', 'capta_midias',
  'capta_agendamentos', 'capta_matriculas', 'capta_investimento', 'capta_conhecimento',
  'capta_agente_config', 'capta_relatorios', 'capta_diagnosticos', 'leads',
];

// tabelas sem PK "id" (upsert por outra chave ou insert simples)
const CHAVE = { capta_planos: 'codigo', capta_agente_config: 'tenant_id', capta_diagnosticos: 'tenant_id', capta_admins: null };
// colunas que existem na origem mas NÃO no destino (descartar)
const DESCARTAR = { capta_admins: ['criado_em'] };

const h = (p, extra = {}) => ({ apikey: p.key, Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json', ...extra });

async function contar(p, t) {
  const r = await fetch(`${p.url}/rest/v1/${t}?select=*`, { headers: h(p, { Prefer: 'count=exact', Range: '0-0' }) });
  const cr = r.headers.get('content-range') || '';
  return r.ok ? Number(cr.split('/')[1] ?? -1) : `erro ${r.status}`;
}

async function lerTudo(t) {
  const out = [];
  const passo = 500;
  for (let off = 0; ; off += passo) {
    const r = await fetch(`${SRC.url}/rest/v1/${t}?select=*&offset=${off}&limit=${passo}`, { headers: h(SRC) });
    if (!r.ok) throw new Error(`ler ${t}: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < passo) break;
  }
  return out;
}

async function gravar(t, rows) {
  if (!rows.length) return { gravadas: 0 };
  const desc = DESCARTAR[t] || [];
  const limpo = rows.map(r => { const o = { ...r }; for (const c of desc) delete o[c]; return o; });
  const chave = t in CHAVE ? CHAVE[t] : 'id';
  const tentar = async (prefer, q = '') => fetch(`${DST.url}/rest/v1/${t}${q}`, {
    method: 'POST', headers: h(DST, { Prefer: prefer }), body: JSON.stringify(limpo),
  });
  let r = chave
    ? await tentar('resolution=merge-duplicates,return=minimal', `?on_conflict=${chave}`)
    : await tentar('return=minimal');
  if (!r.ok && chave) r = await tentar('return=minimal'); // sem PK utilizável → insert simples
  if (!r.ok) throw new Error(`gravar ${t}: ${r.status} ${await r.text()}`);
  return { gravadas: limpo.length };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  if (!process.env.CRON_SECRET || q.secret !== process.env.CRON_SECRET) return res.status(401).json({ erro: 'secret' });
  if (!SRC.url || !SRC.key || !DST.url || !DST.key) return res.status(500).json({ erro: 'faltam MIG_SRC_* / MIG_DST_*' });

  const lista = q.so ? [q.so] : TABELAS;
  const rel = [];
  for (const t of lista) {
    const item = { tabela: t, origem: await contar(SRC, t), destino_antes: await contar(DST, t) };
    try {
      if (!q.dry) {
        const rows = await lerTudo(t);
        Object.assign(item, await gravar(t, rows));
        item.destino_depois = await contar(DST, t);
      }
    } catch (e) { item.erro = e.message.slice(0, 300); }
    rel.push(item);
  }
  res.status(200).json({ ok: true, dry: !!q.dry, rel });
};
