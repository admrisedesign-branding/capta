// /api/capta-config.js — Vercel Serverless Function (Node 18+, CommonJS)
// Duas coisas:
//   GET                      -> { maya, notify }  (habilitador do painel, como antes)
//   POST { acao, slug, token }
//     'integracoes'          -> lista o que está conectado no negócio
//     'integracao_salvar'    -> conecta/desconecta Meta Ads (conta + token) — token nunca volta pro navegador
//     'investimento'         -> lista o gasto por mês/campanha
//     'investimento_salvar'  -> lança/edita/apaga gasto manual (evento, brinde, impulsionamento)
//     'meta_sync'            -> puxa o gasto das campanhas da Meta e grava em capta_investimento
//
// Variáveis: SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oaezsozoriqnkurxncjs.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const META_API     = 'https://graph.facebook.com/v21.0';

async function sb(caminho, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (r.status === 204) return null;
  const txt = await r.text();
  if (!txt) return null;                       // resposta vazia (Prefer: return=minimal)
  try { return JSON.parse(txt); } catch { return null; }
}
// data de hoje no fuso de Manaus (o servidor roda em UTC)
const hojeManaus = () => new Date(Date.now() - 4*3600*1000).toISOString().slice(0, 10);
const mesDe = d => String(d || hojeManaus()).slice(0, 7) + '-01';

// ---------------------------------------------------------------------
async function integracoes(tenant) {
  const rows = await sb(`capta_integracoes?tenant_id=eq.${tenant.id}&select=id,servico,conta_id,conta_nome,ativo,ultimo_sync,ultimo_erro`).catch(() => []);
  return (rows || []).map(r => ({ ...r, conectado: !!r.ativo }));   // token nunca sai daqui
}

async function metaContas(token) {
  const r = await fetch(`${META_API}/me/adaccounts?fields=name,account_id,currency&limit=50&access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Token recusado pela Meta.');
  return (j.data || []).map(c => ({ id: c.id, nome: c.name, moeda: c.currency }));
}

// gasto por campanha no período (a Meta devolve por dia; somamos por mês)
async function metaGasto(token, contaId, desde, ate) {
  // "actions" traz as conversas de WhatsApp iniciadas pelo anúncio — é o número
  // que a própria Meta contabiliza, sem depender de tag no CRM.
  const campos = 'campaign_name,spend,impressions,clicks,date_start,actions,cost_per_action_type';
  const url = `${META_API}/${contaId}/insights?level=campaign&fields=${campos}&time_range=${encodeURIComponent(JSON.stringify({ since: desde, until: ate }))}&time_increment=monthly&limit=200&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'A Meta recusou a consulta.');
  const acao = (lista, tipos) => {
    for (const t of tipos) { const a = (lista || []).find(x => x.action_type === t); if (a) return Number(a.value || 0); }
    return 0;
  };
  return (j.data || []).map(x => ({
    campanha: x.campaign_name || 'Campanha', mes: String(x.date_start).slice(0, 7) + '-01',
    valor: Number(x.spend || 0), impressoes: Number(x.impressions || 0), cliques: Number(x.clicks || 0),
    // conversas de WhatsApp que a Meta atribui ao anúncio
    conversas: acao(x.actions, [
      'onsite_conversion.total_messaging_connection',
      'onsite_conversion.messaging_conversation_started_7d',
      'onsite_conversion.messaging_first_reply'
    ]),
    cliques_link: acao(x.actions, ['link_click'])
  }));
}

async function sincronizarMeta(tenant, meses = 3) {
  const [conf] = await sb(`capta_integracoes?tenant_id=eq.${tenant.id}&servico=eq.meta_ads&ativo=is.true&select=id,conta_id,token&limit=1`).catch(() => []);
  if (!conf) return { erro: 'Meta Ads não está conectada.' };
  const ate = hojeManaus();
  const d = new Date(); d.setMonth(d.getMonth() - (meses - 1), 1);
  const desde = d.toISOString().slice(0, 10);
  try {
    const linhas = await metaGasto(conf.token, conf.conta_id, desde, ate);
    for (const l of linhas) {
      const ja = await sb(`capta_investimento?tenant_id=eq.${tenant.id}&mes=eq.${l.mes}&campanha=eq.${encodeURIComponent(l.campanha)}&canal=eq.meta&select=id&limit=1`).catch(() => []);
      const dados = { tenant_id: tenant.id, mes: l.mes, campanha: l.campanha, canal: 'meta', valor: l.valor,
        impressoes: l.impressoes, cliques: l.cliques, conversas: l.conversas,
        observacao: `${l.impressoes} impressões · ${l.cliques} cliques${l.conversas ? ' · ' + l.conversas + ' conversas' : ''} · atualizado ${new Date().toLocaleDateString('pt-BR')}` };
      if (ja?.[0]) await sb(`capta_investimento?id=eq.${ja[0].id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
      else await sb('capta_investimento', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
    }
    await sb(`capta_integracoes?id=eq.${conf.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ultimo_sync: new Date().toISOString(), ultimo_erro: null }) });
    return { ok: true, campanhas: linhas.length, ultimo_sync: new Date().toISOString() };
  } catch (e) {
    await sb(`capta_integracoes?id=eq.${conf.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ultimo_erro: e.message.slice(0, 300) }) }).catch(() => null);
    return { erro: e.message };
  }
}

// ---------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    // cron diário: /api/capta-config?sync=<CRON_SECRET> atualiza o gasto de todos os negócios
    // cron do Vercel (chega com user-agent vercel-cron) ou chamada manual com o CRON_SECRET
    const doCron = req.query && req.query.sync && (/vercel-cron/i.test(req.headers['user-agent'] || '') || (process.env.CRON_SECRET && req.query.sync === process.env.CRON_SECRET));
    if (doCron) {
      const conf = await sb(`capta_integracoes?servico=eq.meta_ads&ativo=is.true&select=tenant_id`).catch(() => []);
      const out = [];
      for (const c of conf || []) out.push(await sincronizarMeta({ id: c.tenant_id }, 2));
      return res.status(200).json({ ok: true, out });
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ maya: !!process.env.ANTHROPIC_API_KEY, notify: !!process.env.RESEND_API_KEY });
  }
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use GET ou POST.' });
  if (!SERVICE_KEY) return res.status(500).json({ erro: 'Falta SUPABASE_SERVICE_ROLE_KEY.' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { acao, slug, token } = body || {};
  if (!slug || !token) return res.status(400).json({ erro: 'slug e token são obrigatórios.' });
  const [tenant] = await sb(`capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,nome,dashboard_token&limit=1`).catch(() => []);
  if (!tenant) return res.status(404).json({ erro: 'Negócio não encontrado.' });
  if (tenant.dashboard_token !== token) return res.status(403).json({ erro: 'Acesso negado.' });

  try {
    switch (acao) {
      case 'recepcao_token': {
        const [t] = await sb(`capta_tenants?id=eq.${tenant.id}&select=recepcao_token&limit=1`);
        let tk = t && t.recepcao_token;
        if (!tk || body.renovar) {
          tk = 'rec_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
          await sb(`capta_tenants?id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ recepcao_token: tk }) });
        }
        return res.status(200).json({ token: tk });
      }

      case 'integracoes':
        return res.status(200).json({ integracoes: await integracoes(tenant) });

      case 'integracao_salvar': {
        const { servico = 'meta_ads', conta_id, conta_nome, token_meta, desconectar } = body;
        if (desconectar) {
          await sb(`capta_integracoes?tenant_id=eq.${tenant.id}&servico=eq.${servico}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
          return res.status(200).json({ ok: true, integracoes: await integracoes(tenant) });
        }
        if (!token_meta) return res.status(400).json({ erro: 'Cole o token de acesso.' });
        // se não veio a conta, devolve as contas que o token enxerga pra pessoa escolher
        if (!conta_id) {
          try { return res.status(200).json({ escolher: await metaContas(token_meta) }); }
          catch (e) { return res.status(400).json({ erro: e.message }); }
        }
        const [ja] = await sb(`capta_integracoes?tenant_id=eq.${tenant.id}&servico=eq.${servico}&select=id&limit=1`).catch(() => []);
        const dados = { tenant_id: tenant.id, servico, conta_id, conta_nome: conta_nome || conta_id, token: token_meta, ativo: true, ultimo_erro: null };
        if (ja) await sb(`capta_integracoes?id=eq.${ja.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
        else await sb('capta_integracoes', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
        const sync = await sincronizarMeta(tenant, 3);
        return res.status(200).json({ ok: true, sync, integracoes: await integracoes(tenant) });
      }

      case 'meta_sync':
        return res.status(200).json(await sincronizarMeta(tenant, Number(body.meses) || 3));

      case 'investimento': {
        const linhas = await sb(`capta_investimento?tenant_id=eq.${tenant.id}&select=id,mes,campanha,canal,valor,observacao,impressoes,cliques,conversas&order=mes.desc,canal`).catch(() => []);
        return res.status(200).json({ investimento: linhas || [], integracoes: await integracoes(tenant) });
      }

      case 'investimento_salvar': {
        if (body.apagar) await sb(`capta_investimento?id=eq.${body.apagar}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        else {
          const i = body.item || {};
          if (!i.valor) return res.status(400).json({ erro: 'Informe o valor.' });
          const dados = { mes: mesDe(i.mes), campanha: (i.campanha || '').trim() || 'Sem nome', canal: i.canal || 'outro', valor: Number(i.valor), observacao: i.observacao || null };
          if (i.id) await sb(`capta_investimento?id=eq.${i.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
          else await sb('capta_investimento', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tenant_id: tenant.id, ...dados }) });
        }
        const linhas = await sb(`capta_investimento?tenant_id=eq.${tenant.id}&select=id,mes,campanha,canal,valor,observacao,impressoes,cliques,conversas&order=mes.desc,canal`).catch(() => []);
        return res.status(200).json({ ok: true, investimento: linhas || [] });
      }

      default: return res.status(400).json({ erro: 'Ação desconhecida.' });
    }
  } catch (e) { return res.status(500).json({ erro: e.message }); }
};
