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
//   acao: 'agenda'      -> { turmas[], horarios[], agendamentos[] }
//   acao: 'agendar'     -> { ok, id }          { turma_id, data, crianca_nome, crianca_idade,
//                                                 responsavel + contato | lead_id | conversa_id }
//   acao: 'remarcar'    -> { ok, id }          { agendamento_id, data, turma_id, motivo }
//   acao: 'presenca'    -> { ok }              { agendamento_id, status }
//   acao: 'funil'       -> { etapas[], leads[] }
//   acao: 'mover'       -> { ok }              { lead_id, etapa_id, motivo }
//   acao: 'webhooks'    -> { ok, url }       (re)configura os webhooks
//
// Autenticação: slug + dashboard_token, igual ao resto do painel.
//
// GET ?cron=<CRON_SECRET>  -> executa o relógio diário (lembretes)
//   O Vercel Cron chama por GET. Aproveitar este endpoint evita criar uma
//   13ª função e estourar o limite de 12 do plano Hobby.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZAPI_CLIENT_TOKEN, SITE_URL,
//      CRON_SECRET

const prov = require('./_lib/whatsapp-provedor');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oaezsozoriqnkurxncjs.supabase.co';
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

const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  // ---- relógio diário (Vercel Cron) ----
  if (req.method === 'GET') {
    const autorizado = req.headers['x-vercel-cron']
      || (CRON_SECRET && req.query.cron === CRON_SECRET);
    if (!autorizado) return res.status(405).json({ erro: 'use POST' });
    return await rodarCron(res);
  }

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

    // Funil, agenda e presença não dependem de WhatsApp: valem em qualquer
    // plano, com ou sem canal conectado.
    // permissão por papel (o e-mail de quem está usando vem no corpo)
    if (body.email_atual) {
      const eu = await usuarioDe(tenant.id, body.email_atual);
      if (eu && eu.ativo === false) return res.status(403).json({ erro: 'Seu acesso está desativado. Fale com o gestor.' });
      if (eu && !podeFazer(eu.papel, acao)) return res.status(403).json({ erro: `Seu perfil (${(PAPEIS[eu.papel]||{}).nome || eu.papel}) não pode fazer isso.` });
    }

    const SEM_WHATS = ['funil', 'mover', 'agenda', 'agendar', 'remarcar', 'presenca', 'lead', 'campos', 'alunos', 'aluno', 'experimentais', 'desfecho', 'desfazer', 'conversa_atualizar', 'respostas', 'importar_historico', 'equipe', 'equipe_salvar', 'eu', 'eventos', 'evento_salvar', 'evento_leads', 'casar_conversas', 'sem_data', 'saude'];
    if (SEM_WHATS.includes(acao)) {
      switch (acao) {
        case 'agenda':   return await acaoAgenda(tenant, body, res);
        case 'agendar':  return await acaoAgendar(tenant, body, res);
        case 'remarcar': return await acaoRemarcar(tenant, body, res);
        case 'presenca': return await acaoPresenca(tenant, body, res);
        case 'funil':    return await acaoFunil(tenant, res);
        case 'mover':    return await acaoMover(tenant, body, res);
        case 'lead':     return await acaoLead(tenant, body, res);
        case 'campos':   return await acaoCampos(tenant, body, res);
        case 'alunos':   return await acaoAlunos(tenant, body, res);
        case 'aluno':    return await acaoAluno(tenant, body, res);
        case 'experimentais': return await acaoExperimentais(tenant, body, res);
        case 'desfecho': return await acaoDesfecho(tenant, body, res);
        case 'desfazer': return await acaoDesfazer(tenant, body, res);
        case 'conversa_atualizar': return await acaoConversaAtualizar(tenant, body, res);
        case 'respostas': return await acaoRespostas(tenant, body, res);
        case 'importar_historico': return await acaoImportarHistorico(tenant, body, res);
        case 'equipe':   return await acaoEquipe(tenant, body, res);
        case 'equipe_salvar': return await acaoEquipeSalvar(tenant, body, res);
        case 'eu':       return await acaoEu(tenant, body, res);
        case 'eventos':  return await acaoEventos(tenant, body, res);
        case 'evento_salvar': return await acaoEventoSalvar(tenant, body, res);
        case 'evento_leads':  return await acaoEventoLeads(tenant, body, res);
        case 'casar_conversas': return await acaoCasarConversas(tenant, body, res);
        case 'sem_data':      return await acaoSemData(tenant, body, res);
        case 'saude':         return await acaoSaude(tenant, body, res);
      }
    }

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
      case 'codigo':      return await acaoCodigo(canal, body, res);
      case 'desconectar': return await acaoDesconectar(canal, res);
      case 'webhooks':    return await acaoWebhooks(canal, res);
      case 'enviar':      return await acaoEnviar(tenant, canal, body, res);
      case 'enviar_midia': return await acaoEnviarMidia(tenant, canal, body, res);
      case 'conversas':   return await acaoConversas(tenant, res);
      case 'mensagens':   return await acaoMensagens(tenant, body, res);
      case 'midia':       return await acaoMidia(tenant, body, res);
      case 'agenda':      return await acaoAgenda(tenant, body, res);
      case 'agendar':     return await acaoAgendar(tenant, body, res);
      case 'remarcar':    return await acaoRemarcar(tenant, body, res);
      case 'presenca':    return await acaoPresenca(tenant, body, res);
      case 'funil':       return await acaoFunil(tenant, res);
      case 'mover':       return await acaoMover(tenant, body, res);
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


async function acaoCodigo(canal, body, res) {
  const numero = String(body.numero || '').replace(/\D/g, '');
  if (numero.length < 10) return res.status(400).json({ erro: 'Informe o número com DDD.' });
  const s = await prov.obterStatus(canal);
  if (s.status === 'conectado') return res.status(200).json({ status: 'conectado', codigo: null });
  const codigo = await prov.obterCodigo(canal, numero);
  if (!codigo) return res.status(200).json({ status: s.status, codigo: null });
  await sb(`capta_canais?id=eq.${canal.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'aguardando_qr', numero, atualizado_em: new Date().toISOString() }) });
  return res.status(200).json({ status: 'aguardando_qr', codigo });
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

  if (conversa && body.autor && body.autor !== 'bot') {
    const dono = (await sb(`capta_conversas?id=eq.${conversa.id}&select=atendente&limit=1`).catch(() => []))?.[0]?.atendente;
    if (dono && dono !== body.autor && !body.forcar) return res.status(409).json({ erro: `${dono} está atendendo esta conversa. Quer assumir mesmo assim?`, atendente: dono, confirmar: true });
  }
  const envio = await prov.enviarTexto(canal, telefone, texto);
  if (body.autor !== 'bot') { const cl = await sb(`capta_conversas?id=eq.${conversa.id}&select=lead_id&limit=1`).catch(() => []); contatoHumano(tenant.id, cl?.[0]?.lead_id).catch(() => null); }

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
    `&select=id,telefone,agente_ativo,status,nao_lidas,ultima_mensagem,ultima_mensagem_em,atendente,resolvida_em,` +
    `lead:lead_id(id,nome,temperatura,status,etapa_id,atendente,notas,contato,crianca,idade,kommo_lead_id)` +
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
    `&select=id,telefone,agente_ativo,nao_lidas,atendente,resolvida_em,lead:lead_id(id,nome,temperatura,etapa_id,atendente,notas,contato,crianca,idade,kommo_lead_id)&limit=1`
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

// ---------------------------------------------------------------------
// RELÓGIO DIÁRIO
//
// Varre os negócios com WhatsApp conectado e dispara os lembretes de
// véspera e do dia. Sem isso o sistema só responde e nunca persegue — e é
// a perseguição que segura o comparecimento.
// ---------------------------------------------------------------------
async function rodarCron(res) {
  const resumo = { enviados: 0, falhas: 0, negocios: 0, sessoes: 0 };

  try {
    const canais = await sb(`capta_canais?tipo=eq.whatsapp&status=eq.conectado&select=*`);

    for (const canal of canais || []) {
      resumo.negocios++;
      try { await lembretes(canal, resumo); }
      catch (e) { console.error('[cron lembretes]', canal.tenant_id, e.message); }
    }

    try { resumo.sessoes = await rpc('capta_bot_abandonar_paradas', { p_horas: 48 }); }
    catch { /* tabelas do bot ainda não existem em produção */ }

  } catch (e) {
    console.error('[cron]', e.message);
    return res.status(500).json({ erro: e.message, ...resumo });
  }

  return res.status(200).json({ ok: true, ...resumo });
}

// ---------------------------------------------------------------------
// Lembretes de véspera (D-1) e do dia (D0)
//
// A fila vem do banco já com o telefone normalizado e com o 55 na frente,
// e já exclui quem recebeu. As datas são calculadas no fuso de Manaus:
// current_date em UTC vira o dia seguinte a partir das 20h locais.
// ---------------------------------------------------------------------
async function lembretes(canal, resumo) {
  const fila = await rpc('capta_lembretes_pendentes', { p_tenant: canal.tenant_id });
  if (!fila || !fila.length) return;

  for (const item of fila) {
    const primeiro = (item.crianca_nome || '').trim().split(' ')[0];
    const hora = String(item.hora_inicio || '').slice(0, 5);

    const texto = item.tipo === 'd1'
      ? `Oi! Tudo certo pra amanhã às ${hora}? A aula experimental ${primeiro ? 'do ' + primeiro + ' ' : ''}já está reservada 😊\n\nResponda *1* para confirmar ou *2* se precisar remarcar.`
      : `Bom dia! Lembrete da aula ${primeiro ? 'do ' + primeiro + ' ' : ''}hoje às ${hora}. Estamos te esperando!\n\nSe precisar remarcar, é só responder *2*.`;

    try {
      const envio = await prov.enviarTexto(canal, item.contato, texto);

      // Marca ANTES de qualquer outra coisa: se falhar depois, o pior
      // caso é a família não receber — melhor que receber duas vezes.
      await sb(`capta_agendamentos?id=eq.${item.agendamento_id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(
          item.tipo === 'd1'
            ? { lembrete_d1_em: new Date().toISOString() }
            : { lembrete_d0_em: new Date().toISOString() }
        )
      });

      // Registra na conversa, para o histórico do inbox não ter buracos.
      await registrar(canal, item, texto, envio.provedor_msg_id);
      resumo.enviados++;

      // Ritmo humano: conexão não oficial banisce número que dispara rápido.
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      resumo.falhas++;
      console.error('[lembrete]', item.agendamento_id, e.message);
    }
  }
}

async function registrar(canal, item, texto, msgId) {
  try {
    const achadas = await sb(
      `capta_conversas?tenant_id=eq.${canal.tenant_id}&telefone=eq.${item.contato}&select=id&limit=1`
    );
    let conversaId = achadas?.[0]?.id;

    if (!conversaId) {
      const criada = await sb('capta_conversas', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          tenant_id: canal.tenant_id, canal_id: canal.id,
          lead_id: item.lead_id || null, telefone: item.contato,
          agente_ativo: true, status: 'aberta'
        })
      });
      conversaId = criada[0].id;
    }

    await sb('capta_mensagens', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        conversa_id: conversaId, tenant_id: canal.tenant_id,
        direcao: 'saida', autor: 'sistema', tipo: 'texto',
        texto, provedor_msg_id: msgId, entrega: 'enviada'
      })
    });
  } catch (e) {
    console.error('[registrar lembrete]', e.message);
  }
}

// ---------------------------------------------------------------------
// AGENDA
// ---------------------------------------------------------------------
async function rpc(nome, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error(`${nome}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function acaoAgenda(tenant, body, res) {
  const dias = Math.min(Number(body.dias) || 21, 60);

  const [turmas, horarios, agendamentos] = await Promise.all([
    sb(`capta_turmas?tenant_id=eq.${tenant.id}&ativa=is.true&select=*&order=dia_semana,hora_inicio`),
    rpc('capta_vagas_experimental', { p_tenant: tenant.id, p_dias: dias })
      .then(rows => (rows || []).map(h => ({ ...h, capacidade: h.capacidade })))
      .catch(() => rpc('capta_horarios_disponiveis', { p_tenant: tenant.id, p_dias: dias })),
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}` +
       `&status=in.(agendado,confirmado,compareceu,faltou)` +
       `&select=id,data,hora_inicio,hora_fim,status,crianca_nome,crianca_idade,turma_id,` +
       `confirmado_em,lead:lead_id(id,nome,contato)&order=data.asc,hora_inicio.asc&limit=300`)
  ]);

  return res.status(200).json({ turmas: turmas || [], horarios: horarios || [], agendamentos: agendamentos || [] });
}

async function acaoAgendar(tenant, body, res) {
  const { turma_id, data, crianca_nome, crianca_idade } = body;
  if (!turma_id || !data) return res.status(400).json({ erro: 'Informe turma e data.' });

  let leadId = body.lead_id || null;

  if (!leadId && body.conversa_id) {
    const c = await sb(`capta_conversas?id=eq.${body.conversa_id}&tenant_id=eq.${tenant.id}&select=lead_id&limit=1`);
    leadId = c?.[0]?.lead_id || null;
  }

  // Agendamento feito na mão, com o telefone do responsável: acha o lead
  // existente ou cria um novo. Sem lead vinculado não há para quem mandar
  // o lembrete de véspera, e o agendamento não aparece no funil.
  if (!leadId && body.contato) {
    leadId = await acharOuCriarLead(tenant.id, body.contato, body.responsavel, crianca_nome);
  }

  const t = await sb(`capta_turmas?id=eq.${turma_id}&tenant_id=eq.${tenant.id}&select=hora_inicio,hora_fim&limit=1`);
  if (!t?.[0]) return res.status(404).json({ erro: 'Turma não encontrada.' });

  try {
    const criado = await sb('capta_agendamentos', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        tenant_id: tenant.id, lead_id: leadId, turma_id, data,
        hora_inicio: t[0].hora_inicio, hora_fim: t[0].hora_fim,
        crianca_nome: crianca_nome || null,
        crianca_idade: crianca_idade || null,
        status: 'agendado',
        criado_por: body.usuario_email || 'painel'
      })
    });

    // Move o lead para a etapa de aula agendada, se ela existir — e leva pro Kommo.
    if (leadId) {
      const e = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Aula%20agendada&select=id&limit=1`);
      if (e?.[0]) {
        const atual = (await sb(`capta_leads?id=eq.${leadId}&select=etapa_id&limit=1`).catch(() => []))?.[0]?.etapa_id || null;
        if (atual && atual !== e[0].id) await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ etapa_anterior_id: atual }) }).catch(() => null);
        await moverLead(tenant.id, leadId, e[0].id, null);
        await empurrarKommo(tenant.id, leadId, e[0].id, null).catch(() => null);
      }
      const tt = await sb(`capta_turmas?id=eq.${turma_id}&select=dia_semana&limit=1`).catch(() => []);
      const campos = { data_aula: `${data}T${String(t[0].hora_inicio).slice(0,5)}:00-04:00`, bloco: blocoKommo(tt?.[0]?.dia_semana, t[0].hora_inicio, t[0].hora_fim), crianca: crianca_nome || null, idade: crianca_idade ? Number(crianca_idade) : null };
      await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos) }).catch(() => null);
      await kommoCampos(tenant.id, leadId, { ...campos, curso: 'First' }).catch(() => null);
    }

    return res.status(200).json({ ok: true, id: criado[0].id });
  } catch (e) {
    // O gatilho do banco recusa turma lotada e data bloqueada.
    return res.status(409).json({ erro: limparErro(e.message) });
  }
}

async function acaoRemarcar(tenant, body, res) {
  const { agendamento_id, data, turma_id } = body;
  if (!agendamento_id || !data || !turma_id) return res.status(400).json({ erro: 'Dados incompletos.' });

  const a = await sb(`capta_agendamentos?id=eq.${agendamento_id}&tenant_id=eq.${tenant.id}&select=id&limit=1`);
  if (!a?.[0]) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

  try {
    const novo = await rpc('capta_remarcar', {
      p_agendamento: agendamento_id, p_nova_data: data, p_nova_turma: turma_id,
      p_motivo: body.motivo || null, p_ator: body.usuario_email || 'painel'
    });
    // lead volta a "Aula agendada" e o Kommo recebe nova data, bloco e a tag reagendado
    const ag = (await sb(`capta_agendamentos?id=eq.${agendamento_id}&select=lead_id&limit=1`).catch(() => []))?.[0];
    const t = (await sb(`capta_turmas?id=eq.${turma_id}&select=dia_semana,hora_inicio,hora_fim&limit=1`).catch(() => []))?.[0];
    if (ag?.lead_id) {
      const e = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Aula%20agendada&select=id&limit=1`))?.[0];
      if (e) { await moverLead(tenant.id, ag.lead_id, e.id, null); await empurrarKommo(tenant.id, ag.lead_id, e.id, null).catch(() => null); }
      if (t) {
        const campos = { data_aula: `${data}T${String(t.hora_inicio).slice(0,5)}:00-04:00`, bloco: blocoKommo(t.dia_semana, t.hora_inicio, t.hora_fim) };
        await sb(`capta_leads?id=eq.${ag.lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos) }).catch(() => null);
        await kommoCampos(tenant.id, ag.lead_id, campos).catch(() => null);
      }
      await kommoTag(tenant.id, ag.lead_id, 'reagendado').catch(() => null);
    }
    return res.status(200).json({ ok: true, id: novo });
  } catch (e) {
    return res.status(409).json({ erro: limparErro(e.message) });
  }
}

// Presença: é isso que alimenta a comissão. Sem marcar, o funil mente.
async function acaoPresenca(tenant, body, res) {
  const { agendamento_id, status } = body;
  if (!['compareceu', 'faltou', 'confirmado', 'cancelado'].includes(status)) {
    return res.status(400).json({ erro: 'Situação inválida.' });
  }

  const a = await sb(`capta_agendamentos?id=eq.${agendamento_id}&tenant_id=eq.${tenant.id}&select=id,lead_id&limit=1`);
  if (!a?.[0]) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

  const agora = new Date().toISOString();
  const campos = { status };
  if (status === 'compareceu') campos.compareceu_em = agora;
  if (status === 'confirmado') { campos.confirmado_em = agora; campos.confirmado_por = 'atendente'; }
  if (status === 'cancelado')  { campos.cancelado_em = agora; campos.motivo_cancelamento = body.motivo || null; }

  await sb(`capta_agendamentos?id=eq.${agendamento_id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos)
  });

  if (status === 'compareceu' && a[0].lead_id) {
    const e = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Compareceu&select=id&limit=1`);
    if (e?.[0]) await moverLead(tenant.id, a[0].lead_id, e[0].id, null);
  }
  if (status === 'cancelado' && a[0].lead_id) {
    const ativas = await sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&lead_id=eq.${a[0].lead_id}&status=in.(agendado,confirmado)&select=id&limit=1`).catch(() => []);
    if (!ativas?.length) {
      const l = (await sb(`capta_leads?id=eq.${a[0].lead_id}&select=etapa_id,etapa_anterior_id&limit=1`))?.[0] || {};
      const ag = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Aula%20agendada&select=id&limit=1`);
      if (ag?.[0] && l.etapa_id === ag[0].id) {
        let volta = l.etapa_anterior_id;
        if (!volta) volta = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=ilike.em%20contato&select=id&limit=1`))?.[0]?.id;
        if (volta) { await moverLead(tenant.id, a[0].lead_id, volta, null); await empurrarKommo(tenant.id, a[0].lead_id, volta, null).catch(() => null); }
        await sb(`capta_leads?id=eq.${a[0].lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ data_aula: null, bloco: null }) }).catch(() => null);
        await kommoLimparAula(tenant.id, a[0].lead_id).catch(() => null);
      }
    }
  }

  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------
// FUNIL
// ---------------------------------------------------------------------
async function acaoFunil(tenant, res) {
  const [etapas, leads, motivos] = await Promise.all([
    sb(`capta_etapas?tenant_id=eq.${tenant.id}&select=*&order=ordem`),
    sb(`capta_leads?tenant_id=eq.${tenant.id}` +
       `&select=id,nome,contato,temperatura,score,origem,etapa_id,etapa_em,criado_em,motivo_perda,kommo_lead_id,atendente,tags,fonte,porta,crianca,idade,curso,data_aula,bloco,notas,email` +
       `&order=etapa_em.desc.nullslast,criado_em.desc&limit=500`),
    sb(`capta_motivos?tenant_id=eq.${tenant.id}&ativo=is.true&select=id,nome,etapa&order=ordem`)
      .catch(() => [])
  ]);
  return res.status(200).json({ etapas: etapas || [], leads: leads || [], motivos: motivos || [] });
}

async function acaoMover(tenant, body, res) {
  const { lead_id, etapa_id } = body;
  if (!lead_id || !etapa_id) return res.status(400).json({ erro: 'Dados incompletos.' });

  const l = await sb(`capta_leads?id=eq.${lead_id}&tenant_id=eq.${tenant.id}&select=id&limit=1`);
  if (!l?.[0]) return res.status(404).json({ erro: 'Lead não encontrado.' });

  await moverLead(tenant.id, lead_id, etapa_id, body.motivo || null);
  const kommo = await empurrarKommo(tenant.id, lead_id, etapa_id, body.motivo || null).catch(e => ({ erro: e.message }));
  return res.status(200).json({ ok: true, kommo });
}

// Lead espelhado do Kommo: a etapa nova vai pra lá também (o espelho volta pelo webhook e confirma).
async function empurrarKommo(tenantId, leadId, etapaId, motivo) {
  const token = process.env.KOMMO_TOKEN;
  if (!token) return null;
  const [l, e] = await Promise.all([
    sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id,kommo_pipeline&limit=1`),
    sb(`capta_etapas?id=eq.${etapaId}&tenant_id=eq.${tenantId}&select=kommo_status_id,nome&limit=1`)
  ]);
  const lead = l?.[0], etapa = e?.[0];
  if (!lead?.kommo_lead_id || !etapa?.kommo_status_id) return null;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  const r = await fetch(`https://${dominio}/api/v4/leads/${lead.kommo_lead_id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_id: Number(etapa.kommo_status_id), ...(lead.kommo_pipeline ? { pipeline_id: Number(lead.kommo_pipeline) } : {}) })
  });
  if (!r.ok) { const t = await r.text(); await registrarFalha(tenantId, 'kommo', `mover etapa: ${r.status} ${t.slice(0,200)}`); throw new Error(`Kommo ${r.status}: ${t.slice(0, 200)}`); }
  if (motivo) {
    await fetch(`https://${dominio}/api/v4/leads/${lead.kommo_lead_id}/notes`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ note_type: 'common', params: { text: `Capta · movido para "${etapa.nome}": ${motivo}` } }])
    }).catch(() => {});
  }
  return { etapa: etapa.nome, kommo_status_id: etapa.kommo_status_id };
}


// ---------------------------------------------------------------------
// LEAD — o painel lateral do Pipeline: conversa (se houver) + agendamentos
// ---------------------------------------------------------------------
async function acaoLead(tenant, body, res) {
  const id = (body.lead_id || '').trim();
  if (!id) return res.status(400).json({ erro: 'Informe lead_id.' });
  const [conv, ags, canais] = await Promise.all([
    sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=eq.${id}&select=id,telefone,agente_ativo,status,nao_lidas&order=ultima_mensagem_em.desc.nullslast&limit=1`).catch(() => []),
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&lead_id=eq.${id}&select=id,data,hora_inicio,hora_fim,status,crianca_nome,turma_id,remarcado_para&order=data.desc&limit=10`).catch(() => []),
    sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&select=status&limit=1`).catch(() => [])
  ]);
  let mensagens = [];
  if (conv?.[0]) {
    mensagens = await sb(`capta_mensagens?conversa_id=eq.${conv[0].id}&tenant_id=eq.${tenant.id}&select=id,direcao,autor,tipo,texto,transcricao,criado_em&order=criado_em.asc&limit=100`).catch(() => []);
  }
  return res.status(200).json({
    conversa: conv?.[0] || null, mensagens: mensagens || [], agendamentos: ags || [],
    canal: canais?.[0]?.status || null
  });
}

// CAMPOS — Fonte / Porta / Quem atendeu / anotações; grava no Capta e no Kommo
const KOMMO_FIELD = { fonte: 3886273, porta: 3886275, atendente: 3881999, data_aula: 3886283, bloco: 3886279, curso: 3886277, pagamento: 3886281 };
async function acaoCampos(tenant, body, res) {
  const id = (body.lead_id || '').trim();
  if (!id) return res.status(400).json({ erro: 'Informe lead_id.' });
  const patch = {};
  for (const k of ['fonte', 'porta', 'atendente', 'notas', 'crianca']) if (body[k] !== undefined) patch[k] = body[k] || null;
  if (body.idade !== undefined) patch.idade = body.idade ? Number(body.idade) : null;
  if (!Object.keys(patch).length) return res.status(400).json({ erro: 'Nada para salvar.' });
  await sb(`capta_leads?id=eq.${id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
  const kommo = await kommoCampos(tenant.id, id, patch).catch(e => ({ erro: e.message }));
  return res.status(200).json({ ok: true, kommo });
}

async function kommoCampos(tenantId, leadId, valores) {
  const token = process.env.KOMMO_TOKEN;
  if (!token) return null;
  const l = await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id&limit=1`);
  if (!l?.[0]?.kommo_lead_id) return null;
  const cfv = [];
  for (const [k, v] of Object.entries(valores)) {
    if (!KOMMO_FIELD[k] || v === null || v === undefined || v === '') continue;
    cfv.push({ field_id: KOMMO_FIELD[k], values: [{ value: k === 'data_aula' ? Math.floor(new Date(v).getTime() / 1000) : String(v) }] });
  }
  if (!cfv.length) return null;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  const r = await fetch(`https://${dominio}/api/v4/leads/${l[0].kommo_lead_id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_fields_values: cfv })
  });
  if (!r.ok) { const t = await r.text(); await registrarFalha(tenantId, 'kommo', `campos: ${r.status} ${t.slice(0,200)}`); throw new Error(`Kommo ${r.status}: ${t.slice(0, 200)}`); }
  return { campos: cfv.length };
}

// bloco do Kommo a partir do horário da turma ("8h–10h", "sáb 9h–11h"…)
function blocoKommo(diaSemana, hi, hf) {
  const h = x => String(x || '').slice(0, 2).replace(/^0/, '') + 'h';
  const b = `${h(hi)}–${h(hf)}`;
  return Number(diaSemana) === 6 ? `sáb ${b}` : b;
}


// ---------------------------------------------------------------------
// ALUNOS ATIVOS — grade por turma e kit
// ---------------------------------------------------------------------
async function acaoAlunos(tenant, body, res) {
  const [turmas, alunos, kits] = await Promise.all([
    sb(`capta_turmas?tenant_id=eq.${tenant.id}&select=id,nome,dia_semana,hora_inicio,hora_fim,capacidade,limite_sala,kit_experimental,ativa&order=dia_semana,hora_inicio`),
    sb(`capta_alunos?tenant_id=eq.${tenant.id}&select=id,nome,nome_curto,kit,matricula,turma_id,lead_id,status,trancado_ate,observacao&order=nome`).catch(() => []),
    sb(`capta_kits?tenant_id=eq.${tenant.id}&select=kit,capacidade,cor`).catch(() => [])
  ]);
  return res.status(200).json({ turmas: turmas || [], alunos: alunos || [], kits: kits || [] });
}

// cria / edita um aluno (nome, kit, turma, status, observação)
async function acaoAluno(tenant, body, res) {
  const campos = {};
  for (const k of ['nome', 'nome_curto', 'kit', 'turma_id', 'status', 'trancado_ate', 'observacao', 'lead_id']) if (body[k] !== undefined) campos[k] = body[k] || null;
  if (body.matricula !== undefined) campos.matricula = body.matricula ? Number(body.matricula) : null;
  if (body.id) {
    campos.atualizado_em = new Date().toISOString();
    await sb(`capta_alunos?id=eq.${body.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos) });
    return res.status(200).json({ ok: true, id: body.id });
  }
  if (!campos.nome) return res.status(400).json({ erro: 'Informe o nome.' });
  const criado = await sb('capta_alunos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ tenant_id: tenant.id, status: 'ativo', ...campos }) });
  return res.status(200).json({ ok: true, id: criado[0].id });
}


// ---------------------------------------------------------------------
// AULA EXPERIMENTAL — lista de aulas + desfecho (matriculou / não / em andamento / faltou)
// ---------------------------------------------------------------------
async function acaoExperimentais(tenant, body, res) {
  const de = body.de || new Date(Date.now() - 14*864e5).toISOString().slice(0,10);
  const ate = body.ate || new Date(Date.now() + 30*864e5).toISOString().slice(0,10);
  const [ags, turmas] = await Promise.all([
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&data=gte.${de}&data=lte.${ate}&select=id,lead_id,turma_id,data,hora_inicio,hora_fim,crianca_nome,crianca_idade,status,compareceu_em,observacao,criado_em,motivo_id,remarcado_de,remarcado_para&order=data,hora_inicio`),
    sb(`capta_turmas?tenant_id=eq.${tenant.id}&select=id,nome,dia_semana,hora_inicio,hora_fim`)
  ]);
  const ids = [...new Set((ags || []).map(a => a.lead_id).filter(Boolean))];
  const leads = ids.length ? await sb(`capta_leads?tenant_id=eq.${tenant.id}&id=in.(${ids.join(',')})&select=id,nome,contato,temperatura,atendente,fonte,porta,origem,etapa_id,kommo_lead_id,valor,pagamento,curso,notas`) : [];
  return res.status(200).json({ agendamentos: ags || [], turmas: turmas || [], leads: leads || [] });
}

// desfecho: matriculou | nao | andamento | faltou  (+ valor/pagamento/curso ou motivo)
async function acaoDesfecho(tenant, body, res) {
  const { agendamento_id, desfecho } = body;
  if (!['matriculou', 'nao', 'andamento', 'faltou', 'compareceu'].includes(desfecho)) return res.status(400).json({ erro: 'Desfecho inválido.' });
  const a = (await sb(`capta_agendamentos?id=eq.${agendamento_id}&tenant_id=eq.${tenant.id}&select=id,lead_id,turma_id,data,crianca_nome,crianca_idade,status&limit=1`))?.[0];
  if (!a) return res.status(404).json({ erro: 'Aula não encontrada.' });
  const agora = new Date().toISOString();
  const etapa = async nome => (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.${encodeURIComponent(nome)}&select=id&limit=1`))?.[0]?.id || null;
  const patchAg = { observacao: body.observacao || null };
  let etapaNome = null, kommoExtra = {}, leadPatch = {};

  if (desfecho === 'faltou') { Object.assign(patchAg, { status: 'faltou' }); etapaNome = 'Aula agendada'; }
  if (desfecho === 'compareceu') { Object.assign(patchAg, { status: 'compareceu', compareceu_em: agora }); }
  // Em andamento: continua em Aula agendada, ganha a tag "em andamento" e a observação vira nota no Kommo
  if (desfecho === 'andamento') { Object.assign(patchAg, { status: 'compareceu', compareceu_em: a.status === 'compareceu' ? undefined : agora }); }
  // Não fechou: vai pra Remarketing com a tag "motivo: …"
  if (desfecho === 'nao') {
    Object.assign(patchAg, { status: 'compareceu', compareceu_em: a.status === 'compareceu' ? undefined : agora });
    etapaNome = 'Remarketing';
    leadPatch.motivo_perda = body.motivo || null;
  }
  if (desfecho === 'matriculou') {
    Object.assign(patchAg, { status: 'compareceu', compareceu_em: a.status === 'compareceu' ? undefined : agora });
    etapaNome = 'Aluno ativo';
    leadPatch = { valor: body.valor ? Number(body.valor) : null, pagamento: body.pagamento || null, curso: body.curso || 'First', ganho_em: agora, status: 'fechado' };
    kommoExtra = { curso: body.curso || 'First' };
    // vira aluno (se ainda não for)
    if (a.lead_id) {
      const ja = await sb(`capta_alunos?tenant_id=eq.${tenant.id}&lead_id=eq.${a.lead_id}&select=id&limit=1`).catch(() => []);
      if (!ja?.length) await sb('capta_alunos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        tenant_id: tenant.id, nome: body.aluno_nome || a.crianca_nome || 'Aluno novo', nome_curto: a.crianca_nome || null,
        kit: body.curso || 'First', turma_id: body.turma_id || a.turma_id, lead_id: a.lead_id, status: 'ativo',
        observacao: `Matriculado pela aula experimental de ${a.data}` }) }).catch(() => null);
    }
    // registro comercial (comissão)
    if (a.lead_id) await sb('capta_matriculas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      tenant_id: tenant.id, lead_id: a.lead_id, agendamento_id: a.id, valor_bruto: body.valor ? Number(body.valor) : null,
      fechada_em: agora.slice(0,10), fechada_por: body.atendente || null, status: 'ativa' }) }).catch(() => null);
  }
  Object.keys(patchAg).forEach(k => patchAg[k] === undefined && delete patchAg[k]);
  await sb(`capta_agendamentos?id=eq.${a.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patchAg) });

  let kommo = null;
  if (a.lead_id) {
    if (Object.keys(leadPatch).length) await sb(`capta_leads?id=eq.${a.lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(leadPatch) }).catch(() => null);
    if (etapaNome) { const eid = await etapa(etapaNome); if (eid) { await moverLead(tenant.id, a.lead_id, eid, body.motivo || null); kommo = await empurrarKommo(tenant.id, a.lead_id, eid, body.motivo || null).catch(e => ({ erro: e.message })); } }
    if (desfecho === 'matriculou') {
      await kommoCampos(tenant.id, a.lead_id, { ...kommoExtra, ...(body.pagamento ? { pagamento: body.pagamento } : {}) }).catch(() => null);
      if (body.valor) await kommoPreco(tenant.id, a.lead_id, Number(body.valor)).catch(() => null);
      if (body.pagamento) await kommoTag(tenant.id, a.lead_id, 'pagamento: ' + String(body.pagamento).toLowerCase()).catch(() => null);
    }
    if (desfecho === 'nao' && body.motivo) await kommoTag(tenant.id, a.lead_id, 'motivo: ' + String(body.motivo).toLowerCase()).catch(() => null);
    if (desfecho === 'andamento') {
      await kommoTag(tenant.id, a.lead_id, 'em andamento').catch(() => null);
      if (body.situacao) await kommoNota(tenant.id, a.lead_id, 'Aula experimental · em andamento: ' + body.situacao).catch(() => null);
    }
    if (desfecho === 'faltou') await kommoTag(tenant.id, a.lead_id, 'reagendar devido falta').catch(() => null);
  }
  return res.status(200).json({ ok: true, kommo });
}

async function kommoNota(tenantId, leadId, texto) {
  const token = process.env.KOMMO_TOKEN; if (!token) return null;
  const l = await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id&limit=1`); if (!l?.[0]?.kommo_lead_id) return null;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  await fetch(`https://${dominio}/api/v4/leads/${l[0].kommo_lead_id}/notes`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify([{ note_type: 'common', params: { text: texto } }]) });
}

async function kommoPreco(tenantId, leadId, valor) {
  const token = process.env.KOMMO_TOKEN; if (!token) return null;
  const l = await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id&limit=1`); if (!l?.[0]?.kommo_lead_id) return null;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  await fetch(`https://${dominio}/api/v4/leads/${l[0].kommo_lead_id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ price: Math.round(valor) }) });
}
async function kommoTag(tenantId, leadId, tag) {
  const token = process.env.KOMMO_TOKEN; if (!token) return null;
  const l = await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id,tags&limit=1`); if (!l?.[0]?.kommo_lead_id) return null;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  const tags = [...new Set([...(l[0].tags || []), tag])].map(name => ({ name }));
  await fetch(`https://${dominio}/api/v4/leads/${l[0].kommo_lead_id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ _embedded: { tags } }) });
}


// Primeiro contato humano: lead em "Novo lead" vai pra "Em contato" (Capta + Kommo). Bot não conta.
async function contatoHumano(tenantId, leadId) {
  if (!leadId) return null;
  const l = (await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=etapa_id&limit=1`))?.[0];
  if (!l) return null;
  const [novo, contato] = await Promise.all([
    sb(`capta_etapas?tenant_id=eq.${tenantId}&nome=ilike.novo%20lead&select=id&limit=1`),
    sb(`capta_etapas?tenant_id=eq.${tenantId}&nome=ilike.em%20contato&select=id&limit=1`)
  ]);
  if (!contato?.[0]) return null;
  if (l.etapa_id && novo?.[0] && l.etapa_id !== novo[0].id) return null; // já saiu de Novo lead
  await moverLead(tenantId, leadId, contato[0].id, null);
  return empurrarKommo(tenantId, leadId, contato[0].id, null).catch(() => null);
}


async function kommoLimparAula(tenantId, leadId) {
  const token = process.env.KOMMO_TOKEN; if (!token) return null;
  const l = await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id&limit=1`); if (!l?.[0]?.kommo_lead_id) return null;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  await fetch(`https://${dominio}/api/v4/leads/${l[0].kommo_lead_id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ custom_fields_values: [{ field_id: KOMMO_FIELD.data_aula, values: [] }, { field_id: KOMMO_FIELD.bloco, values: [] }] }) });
}


// desfaz um desfecho (não / em andamento / faltou): aula volta a "agendado", lead volta pra "Aula agendada"
async function acaoDesfazer(tenant, body, res) {
  const a = (await sb(`capta_agendamentos?id=eq.${body.agendamento_id}&tenant_id=eq.${tenant.id}&select=id,lead_id,status,observacao&limit=1`))?.[0];
  if (!a) return res.status(404).json({ erro: 'Aula não encontrada.' });
  if (/desfecho: matriculou/i.test(a.observacao || '')) return res.status(409).json({ erro: 'Matrícula não se desfaz por aqui — ajuste em Alunos ativos e no Kommo.' });
  await sb(`capta_agendamentos?id=eq.${a.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'agendado', compareceu_em: null, observacao: null }) });
  if (a.lead_id) {
    const e = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Aula%20agendada&select=id&limit=1`))?.[0];
    if (e) { await moverLead(tenant.id, a.lead_id, e.id, null); await empurrarKommo(tenant.id, a.lead_id, e.id, null).catch(() => null); }
    await sb(`capta_leads?id=eq.${a.lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ motivo_perda: null }) }).catch(() => null);
  }
  return res.status(200).json({ ok: true });
}


// ---------------------------------------------------------------------
// INBOX — atribuir / resolver / reabrir · respostas prontas · anexos
// ---------------------------------------------------------------------
async function acaoConversaAtualizar(tenant, body, res) {
  const id = (body.conversa_id || '').trim(); if (!id) return res.status(400).json({ erro: 'Informe conversa_id.' });
  // assumir: só entra se estiver livre (ou for a própria pessoa) — evita dois atendentes na mesma conversa
  if (body.assumir) {
    const c = (await sb(`capta_conversas?id=eq.${id}&tenant_id=eq.${tenant.id}&select=atendente&limit=1`))?.[0];
    if (c && c.atendente && c.atendente !== body.assumir) return res.status(409).json({ erro: `${c.atendente} está atendendo esta conversa.`, atendente: c.atendente });
    await sb(`capta_conversas?id=eq.${id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ atendente: body.assumir }) });
    return res.status(200).json({ ok: true, atendente: body.assumir });
  }
  const patch = {};
  if (body.atendente !== undefined) patch.atendente = body.atendente || null;
  if (body.resolvida === true) patch.resolvida_em = new Date().toISOString();
  if (body.resolvida === false) patch.resolvida_em = null;
  if (body.lida) patch.nao_lidas = 0;
  if (!Object.keys(patch).length) return res.status(400).json({ erro: 'Nada para atualizar.' });
  await sb(`capta_conversas?id=eq.${id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
  return res.status(200).json({ ok: true });
}
async function acaoRespostas(tenant, body, res) {
  if (body.salvar) {
    const r = body.salvar;
    if (r.id) await sb(`capta_respostas?id=eq.${r.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ titulo: r.titulo, texto: r.texto, atalho: r.atalho || null }) });
    else await sb('capta_respostas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tenant_id: tenant.id, titulo: r.titulo, texto: r.texto, atalho: r.atalho || null }) });
  }
  if (body.apagar) await sb(`capta_respostas?id=eq.${body.apagar}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  const lista = await sb(`capta_respostas?tenant_id=eq.${tenant.id}&select=id,titulo,texto,atalho&order=titulo`).catch(() => []);
  return res.status(200).json({ respostas: lista || [] });
}
async function acaoEnviarMidia(tenant, canal, body, res) {
  const { conversa_id, tipo, dados, nome, legenda } = body;
  if (!conversa_id || !dados || !['imagem', 'audio', 'documento'].includes(tipo)) return res.status(400).json({ erro: 'Dados incompletos.' });
  const conv = (await sb(`capta_conversas?id=eq.${conversa_id}&tenant_id=eq.${tenant.id}&select=id,telefone,lead_id&limit=1`))?.[0];
  if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada.' });
  const envio = await prov.enviarMidia(canal, conv.telefone, tipo, dados, { nome, legenda });
  await sb('capta_mensagens', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id, conversa_id: conv.id, direcao: 'saida', autor: body.autor || 'atendente', tipo, texto: legenda || nome || null,
    provedor_msg_id: envio.provedor_msg_id, entrega: 'enviada', criado_em: new Date().toISOString() }) }).catch(() => null);
  await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ultima_mensagem: legenda || (tipo === 'imagem' ? '📷 imagem' : tipo === 'audio' ? '🎤 áudio' : '📎 ' + (nome || 'arquivo')), ultima_mensagem_em: new Date().toISOString(), agente_ativo: false }) }).catch(() => null);
  contatoHumano(tenant.id, conv.lead_id).catch(() => null);
  return res.status(200).json({ ok: true });
}


// ---------------------------------------------------------------------
// IMPORTAR HISTÓRICO — .txt exportado do WhatsApp (Android e iPhone)
// body: { lead_id?, telefone?, texto, nomes_escola: ['Rafa','My Robot'] , previa: true|false }
// ---------------------------------------------------------------------
function parseWhatsappTxt(txt) {
  const linhas = String(txt || '').replace(/\r/g, '').replace(/\u200e/g, '').split('\n');
  const msgs = [];
  const reA = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:[ap]\.?m\.?)?\s*-\s*([^:]+?):\s(.*)$/i;        // Android: 08/09/2026 14:03 - Nome: msg
  const reI = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([^:]+?):\s(.*)$/;                    // iPhone: [08/09/2026 14:03:10] Nome: msg
  for (const l of linhas) {
    const m = l.match(reA) || l.match(reI);
    if (m) {
      const [_, d, mo, y, h, mi, se, autor, texto] = m; const ano = y.length === 2 ? 2000 + Number(y) : Number(y);
      const quando = new Date(ano, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0));
      msgs.push({ quando, autor: autor.trim(), texto });
    } else if (msgs.length && l.trim()) msgs[msgs.length - 1].texto += '\n' + l;
  }
  return msgs.filter(m => !/^(Mensagens e chamadas s[ãa]o protegidas|As mensagens e as chamadas)/i.test(m.texto));
}
async function acaoImportarHistorico(tenant, body, res) {
  const msgs = parseWhatsappTxt(body.texto);
  if (!msgs.length) return res.status(400).json({ erro: 'Não reconheci o formato. Exporte a conversa pelo WhatsApp (sem mídia) e envie o .txt.' });
  const autores = {}; msgs.forEach(m => autores[m.autor] = (autores[m.autor] || 0) + 1);
  if (body.previa) return res.status(200).json({ total: msgs.length, autores, de: msgs[0].quando, ate: msgs[msgs.length - 1].quando });

  const escola = (body.nomes_escola || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  let telefone = body.telefone ? prov.comDDI(body.telefone) : null;
  let lead = null;
  if (body.lead_id) { lead = (await sb(`capta_leads?id=eq.${body.lead_id}&tenant_id=eq.${tenant.id}&select=id,contato&limit=1`))?.[0]; if (lead && !telefone) telefone = prov.comDDI(lead.contato); }
  if (!telefone) return res.status(400).json({ erro: 'Sem telefone pra ligar a conversa.' });
  let conv = (await sb(`capta_conversas?tenant_id=eq.${tenant.id}&telefone=eq.${telefone}&select=id,lead_id&limit=1`))?.[0];
  if (!conv) {
    const canal = (await sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&select=id&limit=1`))?.[0];
    conv = (await sb('capta_conversas', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ tenant_id: tenant.id, canal_id: canal?.id || null, telefone, lead_id: lead?.id || null, agente_ativo: false, status: 'aberta' }) }))[0];
  } else if (lead && !conv.lead_id) await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lead_id: lead.id }) }).catch(() => null);

  const crypto = require('crypto');
  const linhas = msgs.map(m => ({
    tenant_id: tenant.id, conversa_id: conv.id,
    direcao: escola.includes(m.autor.toLowerCase()) ? 'saida' : 'entrada',
    autor: escola.includes(m.autor.toLowerCase()) ? m.autor : 'lead',
    tipo: /<M[ií]dia oculta>|\(arquivo anexado\)|imagem omitida|áudio omitido|<Media omitted>/i.test(m.texto) ? 'midia' : 'texto',
    texto: m.texto.slice(0, 4000), entrega: 'importada', criado_em: m.quando.toISOString(),
    provedor_msg_id: 'import:' + crypto.createHash('md5').update(`${telefone}|${m.quando.toISOString()}|${m.autor}|${m.texto}`).digest('hex').slice(0, 24)
  }));
  let gravadas = 0;
  for (let i = 0; i < linhas.length; i += 200) {
    const lote = linhas.slice(i, i + 200);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/capta_mensagens?on_conflict=provedor_msg_id`, { method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(lote) });
    if (!r.ok) { const t = await r.text(); if (/provedor_msg_id/.test(t) && /unique|conflict/i.test(t)) { /* sem índice único: insere sem on_conflict */ await sb('capta_mensagens', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(lote) }); } else throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`); }
    gravadas += lote.length;
  }
  const ultima = msgs[msgs.length - 1];
  await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ultima_mensagem: (ultima.texto || '').slice(0, 120) }) }).catch(() => null);
  return res.status(200).json({ ok: true, conversa_id: conv.id, importadas: gravadas });
}


// ---------------------------------------------------------------------
// EQUIPE E PERMISSÕES
// Papéis: gestor (tudo) · atendente (atende e agenda) · secretaria (alunos e agenda) · leitura (só vê)
// ---------------------------------------------------------------------
const PAPEIS = {
  gestor:     { nome: 'Gestor',     desc: 'Vê e faz tudo, inclusive equipe e painel.',              telas: ['atendimento','painel','pipeline','conversas','leads','agenda','aula','alunos','eventos','ajustes'], pode: ['*'] },
  atendente:  { nome: 'Atendente',  desc: 'Atende, agenda e dá baixa nas aulas. Não vê o painel.',  telas: ['atendimento','pipeline','conversas','leads','agenda','aula'],                                   pode: ['agenda','agendar','remarcar','presenca','funil','mover','lead','campos','experimentais','desfecho','desfazer','conversas','mensagens','midia','enviar','enviar_midia','conversa_atualizar','respostas','importar_historico','alunos','eu'] },
  secretaria: { nome: 'Secretaria', desc: 'Cuida dos alunos e da agenda. Não atende no WhatsApp.',  telas: ['atendimento','agenda','aula','alunos'],                                                          pode: ['agenda','agendar','remarcar','presenca','experimentais','desfecho','desfazer','alunos','aluno','lead','funil','eu'] },
  leitura:    { nome: 'Só leitura', desc: 'Vê tudo, não altera nada.',                              telas: ['atendimento','painel','pipeline','conversas','leads','agenda','aula','alunos'],                   pode: ['agenda','funil','lead','experimentais','alunos','conversas','mensagens','midia','eu'] },
};
async function usuarioDe(tenantId, email) {
  if (!email) return null;
  const u = await sb(`capta_usuarios?tenant_id=eq.${tenantId}&email=eq.${encodeURIComponent(String(email).toLowerCase().trim())}&select=id,nome,email,papel,ativo,telas&limit=1`).catch(() => []);
  const r = u?.[0]; if (r && r.papel === 'dono') r.papel = 'gestor';   // cadastro antigo
  return r || null;
}
function podeFazer(papel, acao) {
  const p = PAPEIS[papel] || PAPEIS.gestor;
  return p.pode.includes('*') || p.pode.includes(acao);
}
async function acaoEu(tenant, body, res) {
  const u = await usuarioDe(tenant.id, body.email);
  const papel = u?.papel || 'gestor';
  const def = PAPEIS[papel] || PAPEIS.gestor;
  return res.status(200).json({ usuario: u ? { nome: u.nome, email: u.email, papel } : null, papel, telas: (u && u.telas && u.telas.length ? u.telas : def.telas), papeis: PAPEIS });
}
async function acaoEquipe(tenant, body, res) {
  const lista = await sb(`capta_usuarios?tenant_id=eq.${tenant.id}&select=id,nome,email,papel,ativo,telas,ultimo_acesso,criado_em&order=nome`).catch(() => []);
  return res.status(200).json({ equipe: lista || [], papeis: PAPEIS });
}
async function acaoEquipeSalvar(tenant, body, res) {
  const quem = await usuarioDe(tenant.id, body.email_atual);
  if (quem && quem.papel !== 'gestor') return res.status(403).json({ erro: 'Só um gestor pode mexer na equipe.' });
  if (body.apagar) { await sb(`capta_usuarios?id=eq.${body.apagar}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); }
  else {
    const u = body.usuario || {};
    const email = String(u.email || '').toLowerCase().trim();
    if (!u.id && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (!PAPEIS[u.papel || 'atendente']) return res.status(400).json({ erro: 'Papel inválido.' });
    const dados = { nome: (u.nome || '').trim() || email.split('@')[0], papel: u.papel || 'atendente', ativo: u.ativo !== false, telas: Array.isArray(u.telas) && u.telas.length ? u.telas : null };
    if (u.id) await sb(`capta_usuarios?id=eq.${u.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
    else {
      const ja = await sb(`capta_usuarios?tenant_id=eq.${tenant.id}&email=eq.${encodeURIComponent(email)}&select=id&limit=1`).catch(() => []);
      if (ja?.length) return res.status(409).json({ erro: 'Esse e-mail já está na equipe.' });
      await sb('capta_usuarios', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tenant_id: tenant.id, email, ...dados }) });
    }
  }
  const lista = await sb(`capta_usuarios?tenant_id=eq.${tenant.id}&select=id,nome,email,papel,ativo,telas,ultimo_acesso&order=nome`).catch(() => []);
  return res.status(200).json({ ok: true, equipe: lista || [], papeis: PAPEIS });
}


// ---------------------------------------------------------------------
// EVENTOS — feiras, shoppings, escolas: cada um com seus leads
// ---------------------------------------------------------------------
async function acaoEventos(tenant, body, res) {
  const eventos = await sb(`capta_eventos?tenant_id=eq.${tenant.id}&select=*&order=data_inicio.desc`).catch(() => []);
  const ids = (eventos || []).map(e => e.id);
  let porEvento = {};
  if (ids.length) {
    const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&evento_id=in.(${ids.join(',')})&select=id,evento_id,etapa_id,ganho_em,valor,data_aula,temperatura,criado_em`).catch(() => []);
    const etapas = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&select=id,nome`).catch(() => []);
    const nome = id => (etapas.find(e => e.id === id) || {}).nome || '';
    for (const l of leads || []) {
      const b = porEvento[l.evento_id] || (porEvento[l.evento_id] = { leads: 0, aulas: 0, matriculas: 0, receita: 0, quentes: 0 });
      b.leads++;
      if (l.data_aula || /aula agendada|matr|aluno/i.test(nome(l.etapa_id))) b.aulas++;
      if (l.ganho_em || /aluno ativo/i.test(nome(l.etapa_id))) { b.matriculas++; b.receita += Number(l.valor) || 0; }
      if ((l.temperatura || '').toLowerCase() === 'quente') b.quentes++;
    }
  }
  return res.status(200).json({ eventos: eventos || [], numeros: porEvento });
}
async function acaoEventoSalvar(tenant, body, res) {
  if (body.apagar) {
    await sb(`capta_leads?tenant_id=eq.${tenant.id}&evento_id=eq.${body.apagar}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ evento_id: null }) }).catch(() => null);
    await sb(`capta_eventos?id=eq.${body.apagar}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  } else {
    const e = body.evento || {};
    if (!e.nome) return res.status(400).json({ erro: 'Informe o nome do evento.' });
    const dados = { nome: e.nome.trim(), local: e.local || null, cidade: e.cidade || 'Manaus', data_inicio: e.data_inicio || null, data_fim: e.data_fim || e.data_inicio || null, tipo: e.tipo || null, isca: e.isca || null, observacao: e.observacao || null, ativo: e.ativo !== false };
    if (e.id) await sb(`capta_eventos?id=eq.${e.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
    else await sb('capta_eventos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tenant_id: tenant.id, ...dados }) });
  }
  return acaoEventos(tenant, body, res);
}
// leads de um evento; e "vincular": marca leads existentes (por tag, período ou lista de ids)
async function acaoEventoLeads(tenant, body, res) {
  if (body.vincular) {
    const { evento_id, ids, tag, de, ate } = body.vincular;
    if (!evento_id) return res.status(400).json({ erro: 'Informe o evento.' });
    let alvo = ids || [];
    if (!alvo.length && (tag || de)) {
      let q = `capta_leads?tenant_id=eq.${tenant.id}&select=id&limit=1000`;
      if (tag) q += `&tags=cs.{${encodeURIComponent(tag)}}`;
      if (de) q += `&criado_em=gte.${de}`;
      if (ate) q += `&criado_em=lte.${ate}T23:59:59`;
      const r = await sb(q).catch(() => []);
      alvo = (r || []).map(x => x.id);
    }
    if (!alvo.length) return res.status(200).json({ ok: true, vinculados: 0 });
    for (let i = 0; i < alvo.length; i += 100) {
      const lote = alvo.slice(i, i + 100);
      await sb(`capta_leads?tenant_id=eq.${tenant.id}&id=in.(${lote.join(',')})`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ evento_id, porta: 'evento', fonte: 'evento' }) });
    }
    return res.status(200).json({ ok: true, vinculados: alvo.length });
  }
  if (body.parados) {
    const evs = await sb(`capta_eventos?tenant_id=eq.${tenant.id}&ativo=is.true&select=id,nome`).catch(() => []);
    if (!evs?.length) return res.status(200).json({ leads: [], eventos: [] });
    const novo = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=ilike.novo%20lead&select=id&limit=1`).catch(() => []);
    let q = `capta_leads?tenant_id=eq.${tenant.id}&evento_id=in.(${evs.map(e => e.id).join(',')})&select=id,nome,contato,temperatura,evento_id,etapa_id,etapa_em,criado_em,atendente&order=criado_em.desc&limit=200`;
    if (novo?.[0]) q += `&etapa_id=eq.${novo[0].id}`;
    const leads = await sb(q).catch(() => []);
    return res.status(200).json({ leads: leads || [], eventos: evs });
  }
  const id = body.evento_id; if (!id) return res.status(400).json({ erro: 'Informe o evento.' });
  const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&evento_id=eq.${id}&select=id,nome,contato,temperatura,score,etapa_id,atendente,data_aula,ganho_em,valor,criado_em,kommo_lead_id,tags&order=criado_em.desc`).catch(() => []);
  const etapas = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&select=id,nome,tipo&order=ordem`).catch(() => []);
  return res.status(200).json({ leads: leads || [], etapas: etapas || [] });
}


// Liga conversas sem lead ao lead certo, comparando os últimos 8 dígitos do telefone.
async function acaoCasarConversas(tenant, body, res) {
  const convs = await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=is.null&select=id,telefone&limit=500`).catch(() => []);
  if (!convs?.length) return res.status(200).json({ ok: true, ligadas: 0 });
  const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&contato=not.is.null&select=id,contato,criado_em&order=criado_em.desc&limit=2000`).catch(() => []);
  const chave = t => String(t || '').replace(/\D/g, '').slice(-8);
  const mapa = new Map(); for (const l of leads || []) { const k = chave(l.contato); if (k && !mapa.has(k)) mapa.set(k, l.id); }
  let ligadas = 0;
  for (const c of convs) {
    const id = mapa.get(chave(c.telefone)); if (!id) continue;
    await sb(`capta_conversas?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lead_id: id }) }).catch(() => null);
    ligadas++;
  }
  return res.status(200).json({ ok: true, ligadas, total: convs.length });
}

// Leads parados em "Aula agendada" sem agendamento no Capta (a coluna herdada do Kommo).
async function acaoSemData(tenant, body, res) {
  const et = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Aula%20agendada&select=id&limit=1`).catch(() => []);
  if (!et?.[0]) return res.status(200).json({ leads: [] });
  const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&etapa_id=eq.${et[0].id}&select=id,nome,contato,temperatura,crianca,idade,atendente,etapa_em,criado_em,data_aula,kommo_lead_id&order=etapa_em.desc&limit=200`).catch(() => []);
  const ids = (leads || []).map(l => l.id);
  let comAula = new Set();
  if (ids.length) {
    const ags = await sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&lead_id=in.(${ids.join(',')})&status=in.(agendado,confirmado)&select=lead_id`).catch(() => []);
    comAula = new Set((ags || []).map(a => a.lead_id));
  }
  return res.status(200).json({ leads: (leads || []).filter(l => !comAula.has(l.id)) });
}


// ---------------------------------------------------------------------
// SAÚDE — o painel avisa quando o WhatsApp cai ou o Kommo recusa
// ---------------------------------------------------------------------
async function registrarFalha(tenantId, onde, mensagem) {
  await sb('capta_falhas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenantId, onde, mensagem: String(mensagem || '').slice(0, 400), criado_em: new Date().toISOString() }) }).catch(() => null);
}
async function acaoSaude(tenant, body, res) {
  const canal = (await sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&select=id,status,numero,atualizado_em,instancia_id,instancia_token,client_token&limit=1`).catch(() => []))?.[0];
  let whats = { conectado: false, status: canal?.status || 'sem canal' };
  if (canal) {
    try { const st = await prov.obterStatus(canal); whats = { conectado: st.status === 'conectado', status: st.status, numero: canal.numero };
      if (st.status !== canal.status) await sb(`capta_canais?id=eq.${canal.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: st.status, atualizado_em: new Date().toISOString() }) }).catch(() => null);
      if (st.status !== 'conectado') await registrarFalha(tenant.id, 'whatsapp', 'canal ' + st.status);
    } catch (e) { whats = { conectado: false, status: 'erro', erro: e.message }; await registrarFalha(tenant.id, 'whatsapp', e.message); }
  }
  const falhas = await sb(`capta_falhas?tenant_id=eq.${tenant.id}&criado_em=gte.${new Date(Date.now() - 864e5).toISOString()}&select=onde,mensagem,criado_em&order=criado_em.desc&limit=20`).catch(() => []);
  const kommo = !!process.env.KOMMO_TOKEN;
  return res.status(200).json({ whatsapp: whats, kommo, falhas: falhas || [] });
}

// Casa o telefone com um lead existente (comparação normalizada pela
// capta_fone) ou cria um novo. Nunca duplica pessoa.
async function acharOuCriarLead(tenantId, contato, responsavel, criancaNome) {
  const fone = String(contato || '').replace(/\D/g, '');
  if (fone.length < 10) return null;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/capta_lead_por_fone`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_tenant: tenantId, p_fone: fone })
    });
    if (r.ok) {
      const achado = await r.json();
      if (achado) return achado;
    }
  } catch { /* segue e cria */ }

  const nome = (responsavel || '').trim()
    || (criancaNome ? `Responsável de ${criancaNome}` : 'Contato do agendamento');

  // O insert dispara trg_capta_unificar: se a pessoa já existir dentro da
  // janela de 30 dias, o insert é cancelado e nada é criado. Por isso a
  // busca é refeita depois.
  await sb('capta_leads', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      tenant_id: tenantId, nome, contato: fone,
      origem: 'agendamento', status: 'novo'
    })
  }).catch(() => null);

  try {
    const r2 = await fetch(`${SUPABASE_URL}/rest/v1/rpc/capta_lead_por_fone`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_tenant: tenantId, p_fone: fone })
    });
    if (r2.ok) return await r2.json();
  } catch { /* ignora */ }

  return null;
}

// etapa_em é o que permite dizer "parado há X dias" — o dado que o Kommo
// não dá sem abrir card por card.
async function moverLead(tenantId, leadId, etapaId, motivo) {
  const campos = { etapa_id: etapaId, etapa_em: new Date().toISOString() };
  if (motivo !== null && motivo !== undefined) campos.motivo_perda = motivo;
  await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos)
  });
}

// Mensagens de erro do Postgres não servem para o cliente ler.
function limparErro(msg) {
  const s = String(msg || '');
  if (s.includes('Turma lotada'))    return 'Essa turma já está com as 4 vagas ocupadas nessa data.';
  if (s.includes('Data bloqueada'))  return 'Essa data está bloqueada na agenda.';
  if (s.includes('não pode ser remarcado')) return 'Este agendamento não pode ser remarcado.';
  return 'Não foi possível concluir. Confira os dados e tente de novo.';
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
