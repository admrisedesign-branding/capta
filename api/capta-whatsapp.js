// /api/capta-whatsapp.js — conexão e envio de WhatsApp
//
// UM endpoint com AÇÕES, no padrão do capta-admin.js. O plano Hobby do
// Vercel só permite 12 funções, então conectar/qr/status/enviar não podem
// ser arquivos separados.
//
// POST { acao, slug, token, ... }
//   acao: 'status'      -> { status, numero, qr? }
//   acao: 'qr'          -> { qr }            (base64 pronto para <img>)
//   acao: 'desconectar' -> { status }
//   acao: 'enviar'      -> { ok, id }        { conversa_id | telefone, texto }
//   acao: 'conversas'   -> { conversas[] }    lista do inbox
//   acao: 'mensagens'   -> { mensagens[] }    { conversa_id }
//   acao: 'midia'       -> { url }            { mensagem_id } — link assinado 5 min
//   acao: 'webhooks'    -> { ok, url }       (re)configura os webhooks
//
// Autenticação: slug + dashboard_token, igual ao resto do painel.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZAPI_CLIENT_TOKEN, SITE_URL

const prov = require('./_lib/whatsapp-provedor');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE         = process.env.SITE_URL || 'https://capta.riseagencia.com';

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });
  if (!SERVICE_KEY) return res.status(500).json({ erro: 'Falta SUPABASE_SERVICE_ROLE_KEY.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const acao  = (body.acao  || 'status').trim();
  const slug  = (body.slug  || '').trim();
  const token = (body.token || '').trim();
  if (!slug || !token) return res.status(400).json({ erro: 'Sem credenciais do painel.' });

  try {
    // ---- valida o negócio e o plano ----
    const tenants = await sb(
      `capta_tenants?slug=eq.${encodeURIComponent(slug)}&dashboard_token=eq.${encodeURIComponent(token)}&select=id,slug,plano&limit=1`
    );
    const tenant = tenants && tenants[0];
    if (!tenant) return res.status(403).json({ erro: 'Acesso negado.' });

    // WhatsApp conectado é recurso do Business: é onde sai o custo da
    // instância. A trava fica no servidor, nunca no navegador.
    const planos = await sb(
      `capta_planos?codigo=eq.${encodeURIComponent(tenant.plano || 'free')}&select=permite_whatsapp,nome&limit=1`
    );
    if (!planos?.[0]?.permite_whatsapp) {
      return res.status(402).json({ erro: 'Conectar o WhatsApp está disponível no plano Business.' });
    }

    // ---- canal do negócio ----
    const canais = await sb(
      `capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&select=*&limit=1`
    );
    const canal = canais && canais[0];
    if (!canal || !canal.instancia_id || !canal.instancia_token) {
      return res.status(409).json({
        erro: 'Nenhuma instância configurada para este negócio.',
        // No Z-API a instância é criada no painel deles; a RISE cola o
        // id e o token aqui pelo admin antes de o cliente ler o QR.
        precisa: 'instancia'
      });
    }

    switch (acao) {
      case 'status':      return await acaoStatus(canal, res);
      case 'qr':          return await acaoQr(canal, res);
      case 'desconectar': return await acaoDesconectar(canal, res);
      case 'webhooks':    return await acaoWebhooks(canal, res);
      case 'enviar':      return await acaoEnviar(tenant, canal, body, res);
      case 'conversas':   return await acaoConversas(tenant, res);
      case 'mensagens':   return await acaoMensagens(tenant, body, res);
      case 'midia':       return await acaoMidia(tenant, body, res);
      default:            return res.status(400).json({ erro: 'Ação inválida.' });
    }
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};

// ---------------------------------------------------------------------
// STATUS — a tela chama de 3 em 3s enquanto estiver aguardando o QR
// ---------------------------------------------------------------------
async function acaoStatus(canal, res) {
  const s = await prov.obterStatus(canal);

  // Só grava quando muda, para não escrever no banco a cada polling.
  if (s.status !== canal.status || (s.numero && s.numero !== canal.numero)) {
    await sb(`capta_canais?id=eq.${canal.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: s.status,
        numero: s.numero || canal.numero,
        ultimo_erro: s.erro || null,
        conectado_em: s.status === 'conectado' && canal.status !== 'conectado'
          ? new Date().toISOString() : canal.conectado_em,
        atualizado_em: new Date().toISOString()
      })
    });

    // Assim que conecta, aponta os webhooks para cá.
    if (s.status === 'conectado') {
      try { await prov.configurarWebhooks(canal, SITE); } catch (e) { console.error('webhooks:', e.message); }
    }
  }

  // NUNCA devolver instancia_token para o navegador.
  return res.status(200).json({ status: s.status, numero: s.numero, erro: s.erro });
}

// ---------------------------------------------------------------------
// QR — a experiência "Lite" dentro do Capta
// ---------------------------------------------------------------------
async function acaoQr(canal, res) {
  const s = await prov.obterStatus(canal);
  if (s.status === 'conectado') {
    return res.status(200).json({ status: 'conectado', numero: s.numero, qr: null });
  }

  const qr = await prov.obterQr(canal);
  if (!qr) return res.status(200).json({ status: s.status, qr: null });

  await sb(`capta_canais?id=eq.${canal.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'aguardando_qr',
      qr_expira_em: new Date(Date.now() + 60_000).toISOString(),
      atualizado_em: new Date().toISOString()
    })
  });

  return res.status(200).json({ status: 'aguardando_qr', qr });
}

async function acaoDesconectar(canal, res) {
  await prov.desconectar(canal);
  await sb(`capta_canais?id=eq.${canal.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'desconectado', numero: null, atualizado_em: new Date().toISOString() })
  });
  return res.status(200).json({ status: 'desconectado' });
}

async function acaoWebhooks(canal, res) {
  const r = await prov.configurarWebhooks(canal, SITE);
  return res.status(200).json(r);
}

// ---------------------------------------------------------------------
// ENVIAR — humano respondendo pelo painel
//
// Ao enviar, o agente é desligado nessa conversa. É a trava que o Kommo
// não tem: sem isso, bot e humano respondem juntos.
// ---------------------------------------------------------------------
async function acaoEnviar(tenant, canal, body, res) {
  const texto = (body.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Mensagem vazia.' });

  let conversa = null;
  let telefone = body.telefone ? prov.comDDI(body.telefone) : null;

  if (body.conversa_id) {
    const rows = await sb(
      `capta_conversas?id=eq.${body.conversa_id}&tenant_id=eq.${tenant.id}&select=id,telefone&limit=1`
    );
    conversa = rows && rows[0];
    if (!conversa) return res.status(404).json({ erro: 'Conversa não encontrada.' });
    telefone = prov.comDDI(conversa.telefone);
  }

  if (!telefone) return res.status(400).json({ erro: 'Informe conversa_id ou telefone.' });

  // Conversa nova, iniciada pelo painel
  if (!conversa) {
    const achadas = await sb(
      `capta_conversas?tenant_id=eq.${tenant.id}&telefone=eq.${telefone}&select=id&limit=1`
    );
    conversa = achadas?.[0] || (await sb('capta_conversas', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        tenant_id: tenant.id, canal_id: canal.id, telefone,
        agente_ativo: false, status: 'aberta'
      })
    }))[0];
  }

  const envio = await prov.enviarTexto(canal, telefone, texto);

  await sb('capta_mensagens', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      conversa_id: conversa.id,
      tenant_id: tenant.id,
      direcao: 'saida',
      autor: 'humano',
      autor_id: body.usuario_id || null,
      tipo: 'texto',
      texto,
      provedor_msg_id: envio.provedor_msg_id,
      entrega: 'enviada'
    })
  });

  // Humano assumiu: o agente para de responder nesta conversa.
  await sb(`capta_conversas?id=eq.${conversa.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      agente_ativo: false,
      atendente_id: body.usuario_id || null,
      assumida_em: new Date().toISOString(),
      nao_lidas: 0
    })
  });

  return res.status(200).json({ ok: true, id: envio.provedor_msg_id, conversa_id: conversa.id });
}

// ---------------------------------------------------------------------
// CONVERSAS — lista do inbox, mais recente primeiro
// ---------------------------------------------------------------------
async function acaoConversas(tenant, res) {
  const rows = await sb(
    `capta_conversas?tenant_id=eq.${tenant.id}` +
    `&select=id,telefone,agente_ativo,status,nao_lidas,ultima_mensagem,ultima_mensagem_em,` +
    `lead:lead_id(id,nome,temperatura,status)` +
    `&order=ultima_mensagem_em.desc.nullslast&limit=100`
  );
  return res.status(200).json({ conversas: rows || [] });
}

// ---------------------------------------------------------------------
// MENSAGENS de uma conversa. Abrir zera o contador de não lidas.
// ---------------------------------------------------------------------
async function acaoMensagens(tenant, body, res) {
  const id = (body.conversa_id || '').trim();
  if (!id) return res.status(400).json({ erro: 'Informe conversa_id.' });

  const conv = await sb(
    `capta_conversas?id=eq.${id}&tenant_id=eq.${tenant.id}` +
    `&select=id,telefone,agente_ativo,nao_lidas,lead:lead_id(id,nome,temperatura)&limit=1`
  );
  if (!conv?.[0]) return res.status(404).json({ erro: 'Conversa não encontrada.' });

  const msgs = await sb(
    `capta_mensagens?conversa_id=eq.${id}&tenant_id=eq.${tenant.id}` +
    `&select=id,direcao,autor,tipo,texto,midia_url,midia_mime,entrega,criado_em,` +
    `transcricao,transcricao_status` +
    `&order=criado_em.asc&limit=200`
  );

  if (conv[0].nao_lidas > 0) {
    await sb(`capta_conversas?id=eq.${id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ nao_lidas: 0 })
    });
  }

  return res.status(200).json({ conversa: conv[0], mensagens: msgs || [] });
}

// ---------------------------------------------------------------------
// MÍDIA — devolve URL assinada de 5 minutos
//
// O bucket é privado. O navegador nunca recebe caminho permanente, e o
// link morre sozinho — é o que impede foto de criança de vazar por URL
// que alguém guardou.
// ---------------------------------------------------------------------
async function acaoMidia(tenant, body, res) {
  const id = (body.mensagem_id || '').trim();
  if (!id) return res.status(400).json({ erro: 'Informe mensagem_id.' });

  const rows = await sb(
    `capta_mensagens?id=eq.${id}&tenant_id=eq.${tenant.id}&select=midia_url,midia_mime&limit=1`
  );
  const m = rows && rows[0];
  if (!m || !m.midia_url) return res.status(404).json({ erro: 'Sem arquivo.' });

  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/capta-midia/${m.midia_url}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 })
  });
  if (!r.ok) return res.status(500).json({ erro: 'Não deu para abrir o arquivo.' });

  const d = await r.json();
  return res.status(200).json({ url: `${SUPABASE_URL}/storage/v1${d.signedURL}`, mime: m.midia_mime });
}

// =====================================================================
// NOTAS
//
// 1. O instancia_token NUNCA é devolvido ao navegador. Só o status, o
//    número e o QR saem daqui.
//
// 2. CRIAR INSTÂNCIA: no Z-API isso é feito no painel deles (a API de
//    criação é do plano de parceiro). O fluxo hoje é: a RISE cria a
//    instância, cola id e token em capta_canais pelo admin, e o cliente
//    só lê o QR pelo Capta. A experiência dele é idêntica à do Kommo.
//
// 3. A trava de plano fica AQUI, no servidor. Se ficasse na tela, bastava
//    abrir o inspetor para conectar um WhatsApp num plano Free — e cada
//    conexão custa uma instância paga do seu bolso.
//
// 4. POLLING: a tela chama 'status' de 3 em 3s enquanto aguarda o QR, e
//    o QR expira em torno de 60s, então vale pedir um novo a cada ~20s.
//    O endpoint só grava no banco quando o status muda.
//
// 5. FALTA no banco a função usada pelo webhook para casar telefone com
//    lead:
//
//    create or replace function capta_lead_por_fone(p_tenant uuid, p_fone text)
//    returns uuid language sql stable as $$
//      select id from capta_leads
//      where tenant_id = p_tenant
//        and capta_fone(contato) = capta_fone(p_fone)
//      order by criado_em desc limit 1;
//    $$;
// =====================================================================
