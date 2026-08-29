// =====================================================================
// CAPTA — WEBHOOK DE WHATSAPP
// api/capta-whatsapp-webhook.js
//
// Recebe os eventos do provedor, casa com o lead pelo telefone e grava
// a mensagem. Responde 200 SEMPRE e o mais rápido possível — o Z-API
// reenvia o evento se o endpoint demorar ou falhar.
//
// URL configurada na instância:
//   https://capta.riseagencia.com/api/capta-whatsapp-webhook?canal=<uuid>
// =====================================================================

const prov = require('./_lib/whatsapp-provedor');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(caminho, opcoes = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {})
    }
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  // PROCESSA ANTES DE RESPONDER.
  // No Vercel a instância é congelada assim que a resposta é enviada, então
  // trabalho assíncrono depois do res.json() pode nunca rodar. Grava
  // primeiro; o Z-API tolera alguns segundos de espera.
  try {
    await processar(req.query.canal, req.body);
  } catch (e) {
    console.error('[capta-whatsapp-webhook]', e.message, JSON.stringify(req.body || {}).slice(0, 800));
  }

  // 200 sempre: erro faz o Z-API reenviar em loop.
  return res.status(200).json({ ok: true });
};

async function processar(canalId, payload) {
  const evento = prov.normalizarWebhook(payload);
  if (!evento) return;                       // grupo, notificação, tipo não suportado

  // O canal vem pela query, mas confere contra o instanceId do payload:
  // impede que um webhook forjado escreva na conversa de outro cliente.
  const canais = await sb(
    `capta_canais?select=id,tenant_id,instancia_id&id=eq.${canalId}`
  );
  const canal = canais?.[0];
  if (!canal) return;
  if (evento.instancia_id && canal.instancia_id &&
      evento.instancia_id !== canal.instancia_id) {
    console.warn('[webhook] instanceId não confere', evento.instancia_id);
    return;
  }

  const tenant = canal.tenant_id;

  // ----- desconexão -----
  if (evento.tipo_evento === 'desconectado') {
    await sb(`capta_canais?id=eq.${canal.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'desconectado', ultimo_erro: 'instância desconectada' })
    });
    return;
  }

  // ----- status de entrega -----
  if (evento.tipo_evento === 'status') {
    if (!evento.provedor_msg_id || !evento.entrega) return;
    await sb(
      `capta_mensagens?tenant_id=eq.${tenant}&provedor_msg_id=eq.${evento.provedor_msg_id}`,
      { method: 'PATCH', body: JSON.stringify({ entrega: evento.entrega }) }
    );
    return;
  }

  // ----- mensagem -----
  const conversa = await acharOuCriarConversa(tenant, canal.id, evento);

  const direcao = evento.de_mim ? 'saida' : 'entrada';
  const autor   = evento.de_mim ? 'humano' : 'lead';

  let msg;
  try {
    const criadas = await sb('capta_mensagens', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        conversa_id: conversa.id,
        tenant_id: tenant,
        direcao,
        autor,
        tipo: evento.tipo,
        texto: evento.texto,
        midia_mime: evento.midia?.mime || null,
        provedor_msg_id: evento.provedor_msg_id,
        entrega: evento.de_mim ? 'enviada' : null,
        // Áudio nasce como transcrição pendente. Quem transcreve é a
        // ação 'transcrever', não o webhook — aqui o tempo é curto.
        transcricao_status: evento.tipo === 'audio' ? 'pendente' : null,
        criado_em: evento.criado_em
      })
    });
    msg = criadas && criadas[0];
  } catch (e) {
    // 23505 = índice único → evento reenviado, já gravado. Ignorar.
    if (String(e.message).includes('23505')) return;
    throw e;
  }

  // Baixa e guarda a mídia. O link do Z-API expira em 30 dias, então
  // apontar para ele quebraria o histórico em um mês.
  if (msg && evento.midia?.url) {
    try { await guardarMidia(tenant, msg, evento); }
    catch (e) { console.error('[midia]', e.message); }
  }

  // Mensagem vinda do celular significa que um humano respondeu por fora.
  // O agente cala a boca, como se tivesse assumido pelo painel.
  if (evento.de_mim) {
    await sb(`capta_conversas?id=eq.${conversa.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ agente_ativo: false, assumida_em: new Date().toISOString() })
    });
  }

}

// ---------------------------------------------------------------------
// Baixa o arquivo do provedor e sobe no bucket privado do Supabase.
// Nome aleatório, sem nada que permita adivinhar a URL.
// ---------------------------------------------------------------------
const EXT = {
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'application/pdf': 'pdf'
};

async function guardarMidia(tenant, msg, evento) {
  const r = await fetch(evento.midia.url);
  if (!r.ok) throw new Error(`download ${r.status}`);

  const bytes = Buffer.from(await r.arrayBuffer());
  const mime  = evento.midia.mime || r.headers.get('content-type') || 'application/octet-stream';
  const base  = mime.split(';')[0].trim();
  const ext   = EXT[base] || 'bin';
  const caminho = `${tenant}/${msg.id}.${ext}`;

  const up = await fetch(`${SB_URL}/storage/v1/object/capta-midia/${caminho}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': base,
      'x-upsert': 'true'
    },
    body: bytes
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${await up.text()}`);

  await sb('capta_midias', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      tenant_id: tenant, mensagem_id: msg.id,
      caminho, mime: base, tamanho: bytes.length
    })
  });

  await sb(`capta_mensagens?id=eq.${msg.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ midia_url: caminho, midia_mime: base })
  });
}

// ---------------------------------------------------------------------
// Conversa: uma por telefone, por negócio. Casa com o lead usando a
// capta_fone() do banco — o telefone do lead mora em `contato`.
// ---------------------------------------------------------------------
async function acharOuCriarConversa(tenant, canalId, evento) {
  const fone = evento.telefone;

  const achadas = await sb(
    `capta_conversas?select=id,lead_id&tenant_id=eq.${tenant}&telefone=eq.${fone}`
  );
  if (achadas?.[0]) return achadas[0];

  // Procura um lead com esse telefone. A comparação normalizada é feita
  // pela função capta_lead_por_fone (RPC) — ver nota 3.
  let leadId = null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/capta_lead_por_fone`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_tenant: tenant, p_fone: fone })
    });
    if (r.ok) leadId = await r.json();
  } catch { /* sem lead: conversa nasce órfã e é vinculada depois */ }

  const criada = await sb('capta_conversas', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      tenant_id: tenant,
      canal_id: canalId,
      lead_id: leadId,
      telefone: fone,
      agente_ativo: true,
      status: 'aberta'
    })
  });

  return criada[0];
}

// =====================================================================
// NOTAS
//
// 1. PROCESSA E DEPOIS RESPONDE 200. Tentador inverter para responder
//    rápido, mas no Vercel a instância congela após a resposta e o
//    trabalho pendente se perde. O 200 é devolvido mesmo em erro, porque
//    resposta de erro faz o Z-API reenviar em loop.
//
// 2. MÍDIA: implementado em guardarMidia(). O arquivo é baixado do
//    Z-API (cujo link expira em 30 dias) e sobe no bucket PRIVADO
//    capta-midia. capta_mensagens.midia_url guarda o CAMINHO no bucket,
//    nunca uma URL pública — o navegador só recebe URL assinada de curta
//    duração, gerada na hora pela ação 'midia'.
//
// 6. ÁUDIO nasce com transcricao_status = 'pendente'. A transcrição NÃO
//    acontece aqui: o plano Hobby do Vercel corta a função em 10s e
//    download + Whisper pode estourar. Quem transcreve é a ação
//    'transcrever' do capta-whatsapp.js.
//
// 3. FALTA CRIAR no banco esta função, que o casamento de conversa usa:
//
//    create or replace function capta_lead_por_fone(p_tenant uuid, p_fone text)
//    returns uuid language sql stable as $$
//      select id from capta_leads
//      where tenant_id = p_tenant
//        and capta_fone(contato) = capta_fone(p_fone)
//      order by criado_em desc limit 1;
//    $$;
//
// 4. SEGURANÇA: o canal vem pela query string, mas é conferido contra o
//    instanceId do payload. Sem isso, alguém que descobrisse a URL
//    poderia injetar mensagem na conversa de outro cliente.
//
// 5. O agente NÃO é chamado aqui. Quem decide responder é o motor do
//    bot, lendo a fila — assim o webhook continua rápido e o custo de
//    IA fica sob controle.
// =====================================================================
