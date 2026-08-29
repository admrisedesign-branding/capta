// =====================================================================
// CAPTA — ADAPTADOR DE PROVEDOR DE WHATSAPP
// api/lib/whatsapp-provedor.js
//
// TODO o resto do Capta fala só com este arquivo. Se um dia trocar de
// Z-API para Zapster, Wafly ou Evolution, muda aqui e nada mais.
//
// Cinco funções: criarInstancia, obterQr, obterStatus, enviarTexto,
// normalizarWebhook.
//
// SEGURANÇA: o token da instância NUNCA sai daqui para o navegador.
// Fica em capta_canais.instancia_token, lido só no servidor.
// =====================================================================

const PROVEDOR = process.env.WHATSAPP_PROVEDOR || 'zapi';

// Token de segurança da CONTA (não da instância). No painel do Z-API em
// Segurança. Vai no header Client-Token de toda chamada.
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const zapiUrl = (canal, caminho) =>
  `https://api.z-api.io/instances/${canal.instancia_id}/token/${canal.instancia_token}/${caminho}`;

async function zapiFetch(canal, caminho, opcoes = {}) {
  const r = await fetch(zapiUrl(canal, caminho), {
    ...opcoes,
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': ZAPI_CLIENT_TOKEN,
      ...(opcoes.headers || {})
    }
  });
  const texto = await r.text();
  let corpo;
  try { corpo = texto ? JSON.parse(texto) : {}; } catch { corpo = { raw: texto }; }
  if (!r.ok) {
    const erro = new Error(corpo?.error || corpo?.message || `Z-API ${r.status}`);
    erro.status = r.status;
    erro.corpo = corpo;
    throw erro;
  }
  return corpo;
}

// ---------------------------------------------------------------------
// 1. QR CODE — a experiência "Lite" dentro do Capta
//
// Devolve base64 pronto para <img src="...">. O QR expira rápido; a tela
// deve pedir de novo a cada ~20s enquanto o status for aguardando_qr.
// ---------------------------------------------------------------------
async function obterQr(canal) {
  const r = await zapiFetch(canal, 'qr-code/image');
  const valor = r.value || r.qrcode || r.image || null;
  if (!valor) return null;
  return valor.startsWith('data:') ? valor : `data:image/png;base64,${valor}`;
}

// ---------------------------------------------------------------------
// 2. STATUS DA CONEXÃO
//
// Normaliza para os valores de capta_canais.status:
// desconectado | aguardando_qr | conectado | erro
// ---------------------------------------------------------------------
async function obterStatus(canal) {
  try {
    const r = await zapiFetch(canal, 'status');
    if (r.connected === true) {
      return { status: 'conectado', numero: r.phone || r.connectedPhone || null, erro: null };
    }
    if (r.smartphoneConnected === false || r.error === 'You are not connected.') {
      return { status: 'aguardando_qr', numero: null, erro: null };
    }
    return { status: 'aguardando_qr', numero: null, erro: r.error || null };
  } catch (e) {
    return { status: 'erro', numero: null, erro: e.message };
  }
}

// ---------------------------------------------------------------------
// 3. DESCONECTAR
// ---------------------------------------------------------------------
async function desconectar(canal) {
  await zapiFetch(canal, 'disconnect');
  return { status: 'desconectado' };
}

// ---------------------------------------------------------------------
// 4. ENVIAR TEXTO
//
// O telefone tem que ir COM o 55. A capta_fone() do banco devolve 11
// dígitos SEM o código do país — por isso as filas de lembrete e de
// pesquisa já prefixam. Aqui a gente garante de novo, porque envio com
// número errado falha silenciosamente e ninguém descobre.
// ---------------------------------------------------------------------
function comDDI(telefone) {
  const d = String(telefone || '').replace(/\D/g, '');
  if (!d) return null;
  return d.startsWith('55') ? d : `55${d}`;
}

async function enviarTexto(canal, telefone, mensagem) {
  const phone = comDDI(telefone);
  if (!phone) throw new Error('Telefone inválido');

  const r = await zapiFetch(canal, 'send-text', {
    method: 'POST',
    body: JSON.stringify({ phone, message: mensagem })
  });

  return {
    provedor_msg_id: r.messageId || r.id || null,
    bruto: r
  };
}

// ---------------------------------------------------------------------
// 5. NORMALIZAR WEBHOOK
//
// Converte o payload do provedor no formato interno do Capta. É a única
// função que precisa mudar quando trocar de provedor.
//
// Devolve null para tudo que NÃO deve virar mensagem:
//   • notificações do WhatsApp (têm o atributo `notification`)
//   • grupos e newsletters — o Capta é atendimento 1-a-1
//   • callbacks de status de entrega (tratados à parte)
//
// Campos do Z-API usados: type, instanceId, messageId, phone, fromMe,
// momment (ms), isGroup, isNewsletter, senderName/chatName, text.message
// ---------------------------------------------------------------------
function normalizarWebhook(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Status de entrega (enviada/entregue/lida) vem em callback próprio.
  if (payload.type === 'MessageStatusCallback' || payload.type === 'DeliveryCallback') {
    return {
      tipo_evento: 'status',
      instancia_id: payload.instanceId,
      provedor_msg_id: payload.ids?.[0] || payload.messageId || null,
      entrega: mapaEntrega(payload.status)
    };
  }

  if (payload.type !== 'ReceivedCallback') return null;

  // Notificação do WhatsApp (entrou no grupo, apagou mensagem, etc.)
  if (payload.notification) return null;

  // Atendimento é 1-a-1.
  if (payload.isGroup || payload.isNewsletter) return null;

  const { tipo, texto, midia } = extrairConteudo(payload);
  if (!tipo) return null;                      // tipo não suportado

  return {
    tipo_evento: 'mensagem',
    instancia_id: payload.instanceId,
    provedor_msg_id: payload.messageId,
    telefone: comDDI(payload.phone),
    numero_conectado: payload.connectedPhone || null,
    de_mim: payload.fromMe === true,           // enviada pelo celular, fora do Capta
    nome: payload.senderName || payload.chatName || null,
    criado_em: payload.momment ? new Date(payload.momment).toISOString() : new Date().toISOString(),
    tipo,
    texto,
    midia                                       // { url, mime, nome } ou null
  };
}

function extrairConteudo(p) {
  if (p.text?.message)  return { tipo: 'texto',      texto: p.text.message, midia: null };
  if (p.buttonsResponseMessage?.message)
                        return { tipo: 'texto',      texto: p.buttonsResponseMessage.message, midia: null };
  if (p.listResponseMessage?.message)
                        return { tipo: 'texto',      texto: p.listResponseMessage.message, midia: null };

  if (p.image)     return { tipo: 'imagem',    texto: p.image.caption || null,    midia: m(p.image) };
  if (p.audio)     return { tipo: 'audio',     texto: null,                       midia: m(p.audio) };
  if (p.video)     return { tipo: 'video',     texto: p.video.caption || null,    midia: m(p.video) };
  if (p.document)  return { tipo: 'documento', texto: p.document.caption || null, midia: m(p.document) };
  if (p.sticker)   return { tipo: 'figurinha', texto: null,                       midia: m(p.sticker) };

  return { tipo: null, texto: null, midia: null };

  function m(o) {
    return {
      url:  o.imageUrl || o.audioUrl || o.videoUrl || o.documentUrl || o.stickerUrl || o.url || null,
      mime: o.mimeType || null,
      nome: o.fileName || null
    };
  }
}

function mapaEntrega(s) {
  switch (String(s || '').toUpperCase()) {
    case 'SENT':      return 'enviada';
    case 'RECEIVED':  return 'entregue';
    case 'READ':
    case 'PLAYED':    return 'lida';
    case 'PENDING':   return 'enviada';
    default:          return null;
  }
}

// ---------------------------------------------------------------------
// 6. CONFIGURAR OS WEBHOOKS DA INSTÂNCIA
//
// Chamado uma vez, logo depois de conectar. O Z-API EXIGE HTTPS.
// ---------------------------------------------------------------------
async function configurarWebhooks(canal, urlBase) {
  const url = `${urlBase}/api/capta-whatsapp-webhook?canal=${canal.id}`;

  await zapiFetch(canal, 'update-webhook-received', {
    method: 'PUT', body: JSON.stringify({ value: url })
  });
  await zapiFetch(canal, 'update-webhook-message-status', {
    method: 'PUT', body: JSON.stringify({ value: url })
  });
  await zapiFetch(canal, 'update-webhook-disconnected', {
    method: 'PUT', body: JSON.stringify({ value: url })
  });

  return { ok: true, url };
}

module.exports = {
  PROVEDOR,
  obterQr,
  obterStatus,
  desconectar,
  enviarTexto,
  normalizarWebhook,
  configurarWebhooks,
  comDDI
};

// =====================================================================
// NOTAS
//
// 1. CRIAR INSTÂNCIA: no Z-API a instância é criada no PAINEL deles, não
//    por API (a API de criação é do plano de parceiro). Então, por
//    enquanto, o fluxo é: você cria a instância no painel, cola id e
//    token no admin do Capta, e o cliente só lê o QR. Quando houver
//    volume, vale pedir acesso de parceiro para automatizar isso.
//
// 2. MÍDIA EXPIRA EM 30 DIAS no armazenamento do Z-API. A nossa retenção
//    é de 90. Portanto o webhook precisa BAIXAR o arquivo e salvar no
//    Supabase Storage (bucket privado) na hora que a mensagem chega.
//    Guardar o link deles quebra em um mês.
//
// 3. O webhook precisa responder 200 IMEDIATAMENTE. Grave e responda;
//    não chame o agente nem baixe mídia antes de responder.
//
// 4. REENVIO: em instabilidade o Z-API reenvia o mesmo evento. A
//    idempotência é o índice único capta_mensagens_provedor_uk sobre
//    (tenant_id, provedor_msg_id).
//
// 5. fromMe = true significa que alguém respondeu pelo CELULAR, por fora
//    do Capta. Vale gravar assim mesmo (autor 'humano') para o histórico
//    não ficar com buracos — e é o sinal de que a equipe ainda não
//    migrou o hábito para o sistema.
// =====================================================================
