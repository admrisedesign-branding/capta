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

// data de hoje no fuso de Manaus (o servidor roda em UTC)
const hojeManaus = () => new Date(Date.now() - 4*3600*1000).toISOString().slice(0, 10);

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
    // turno=tarde: a passada das 15h, que avisa quem tem aula amanhã de manhã
    return await rodarCron(res, (req.query.turno || 'manha'));
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
      `capta_tenants?slug=eq.${encodeURIComponent(slug)}&select=id,slug,nome,plano,dashboard_token,recepcao_token,email_remetente&limit=1`
    );
    const tenant = tenants && tenants[0];
    if (!tenant) return res.status(403).json({ erro: 'Acesso negado.' });
    // o tablet e o monitor usam um token próprio, que só abre as ações da recepção
    const RECEPCAO = ['recepcao', 'checkin', 'feedback', 'visita_avulsa', 'resumo_config', 'resumo_agora', 'ficha_aluno'];
    const ehRecepcao = tenant.recepcao_token && token === tenant.recepcao_token;
    if (ehRecepcao) { if (!RECEPCAO.includes(acao)) return res.status(403).json({ erro: 'Este dispositivo só pode fazer check-in.' }); }
    else if (token !== tenant.dashboard_token) return res.status(403).json({ erro: 'Acesso negado.' });

    // Funil, agenda e presença não dependem de WhatsApp: valem em qualquer
    // plano, com ou sem canal conectado.
    // permissão por papel (o e-mail de quem está usando vem no corpo)
    if (body.email_atual) {
      const eu = await usuarioDe(tenant.id, body.email_atual);
      if (eu && eu.ativo === false) return res.status(403).json({ erro: 'Seu acesso está desativado. Fale com o gestor.' });
      if (eu && !podeFazer(eu.papel, acao)) return res.status(403).json({ erro: `Seu perfil (${(PAPEIS[eu.papel]||{}).nome || eu.papel}) não pode fazer isso.` });
      // o papel de quem chamou fica disponível para as ações que mudam de
      // regra conforme quem está usando (ex.: prazo da reposição)
      if (eu) body._papel = eu.papel;
    }
    // sem e-mail no corpo (painel antigo) vale o padrão mais permissivo do dono
    if (!body._papel && token === tenant.dashboard_token) body._papel = 'gestor';

    const SEM_WHATS = ['funil', 'mover', 'agenda', 'agendar', 'remarcar', 'presenca', 'lead', 'campos', 'alunos', 'aluno', 'aluno_confirmar', 'turmas_vagas', 'transferir_aluno', 'boas_vindas', 'lead_novo', 'nota', 'notas', 'acesso', 'lgpd', 'lgpd_config', 'expurgar', 'pedido_titular', 'lembretes_agora', 'metas', 'casar_lid', 'identificar', 'experimentais', 'desfecho', 'desfazer', 'conversa_atualizar', 'respostas', 'importar_historico', 'importar_midia', 'atendente_historico', 'ligacao', 'ligacoes', 'avisos', 'equipe', 'equipe_salvar', 'eu', 'eventos', 'evento_salvar', 'evento_leads', 'casar_conversas', 'sem_data', 'mapear_aulas', 'saude', 'transcrever', 'vagas_kit', 'repor', 'faltas_aluno', 'sugerir', 'triagem', 'triagem_aplicar', 'retomada', 'retomada_marcar', 'remarcar_aluno', 'desfazer_remarcacao', 'recepcao', 'checkin', 'feedback', 'visita_avulsa', 'resumo_config', 'resumo_agora', 'ficha_aluno'];
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
        case 'aluno_confirmar': return await acaoAlunoConfirmar(tenant, body, res);
        case 'turmas_vagas':    return await acaoTurmasVagas(tenant, body, res);
        case 'lead_novo':       return await acaoLeadNovo(tenant, body, res);
        case 'acesso':          return await acaoAcesso(tenant, body, res);
        case 'lgpd':            return await acaoLgpd(tenant, body, res);
        case 'lembretes_agora': return await acaoLembretesAgora(tenant, body, res);
        case 'metas':           return await acaoMetas(tenant, body, res);
        case 'identificar':     return await acaoIdentificar(tenant, body, res);
        case 'casar_lid': {
          const [canal] = await sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&status=eq.conectado&select=*&limit=1`).catch(() => []);
          if (!canal) return res.status(400).json({ erro: 'WhatsApp não está conectado.' });
          if (body.lote && !body.limite) body.limite = body.lote;
          return await acaoCasarLid(tenant, canal, body, res);
        }
        case 'lgpd_config':     return await acaoLgpdConfig(tenant, body, res);
        case 'expurgar':        return await acaoExpurgar(tenant, body, res);
        case 'pedido_titular':  return await acaoPedidoTitular(tenant, body, res);
        case 'nota':            return await acaoNota(tenant, body, res);
        case 'notas':           return await acaoNotas(tenant, body, res);
        case 'boas_vindas':     return res.status(200).json(await enviarBoasVindas(tenant, body.aluno_id));
        case 'transferir_aluno': return await acaoTransferirAluno(tenant, body, res);
        case 'experimentais': return await acaoExperimentais(tenant, body, res);
        case 'desfecho': return await acaoDesfecho(tenant, body, res);
        case 'desfazer': return await acaoDesfazer(tenant, body, res);
        case 'conversa_atualizar': return await acaoConversaAtualizar(tenant, body, res);
        case 'respostas': return await acaoRespostas(tenant, body, res);
        case 'importar_historico': return await acaoImportarHistorico(tenant, body, res);
        case 'importar_midia':     return await acaoImportarMidia(tenant, body, res);
        case 'equipe':   return await acaoEquipe(tenant, body, res);
        case 'atendente_historico': return await acaoAtendenteHistorico(tenant, body, res);
        case 'ligacao':   return await acaoLigacao(tenant, body, res);
        case 'ligacoes':  return await acaoLigacoes(tenant, body, res);
        case 'equipe_salvar': return await acaoEquipeSalvar(tenant, body, res);
        case 'eu':       return await acaoEu(tenant, body, res);
        case 'eventos':  return await acaoEventos(tenant, body, res);
        case 'evento_salvar': return await acaoEventoSalvar(tenant, body, res);
        case 'evento_leads':  return await acaoEventoLeads(tenant, body, res);
        case 'casar_conversas': return await acaoCasarConversas(tenant, body, res);
        case 'sem_data':      return await acaoSemData(tenant, body, res);
        case 'mapear_aulas':  return await acaoMapearAulas(tenant, body, res);
        case 'saude':         return await acaoSaude(tenant, body, res);
        case 'transcrever':   return await acaoTranscrever(tenant, body, res);
        case 'vagas_kit':     return await acaoVagasKit(tenant, body, res);
        case 'repor':         return await acaoRepor(tenant, body, res);
        case 'faltas_aluno':  return await acaoFaltasAluno(tenant, body, res);
        case 'sugerir':       return await acaoSugerir(tenant, body, res);
        case 'triagem':       return await acaoTriagem(tenant, body, res);
        case 'triagem_aplicar': return await acaoTriagemAplicar(tenant, body, res);
        case 'retomada':      return await acaoRetomada(tenant, body, res);
        case 'retomada_marcar': return await acaoRetomadaMarcar(tenant, body, res);
        case 'remarcar_aluno': return await acaoRemarcarAluno(tenant, body, res);
        case 'desfazer_remarcacao': return await acaoDesfazerRemarcacao(tenant, body, res);
        case 'recepcao':      return await acaoRecepcao(tenant, body, res);
        case 'checkin':       return await acaoCheckin(tenant, body, res);
        case 'feedback':      return await acaoFeedback(tenant, body, res);
        case 'visita_avulsa': return await acaoVisitaAvulsa(tenant, body, res);
        case 'resumo_config': return await acaoResumoConfig(tenant, body, res);
        case 'avisos':        return await acaoAvisos(tenant, body, res);
        case 'resumo_agora':  { const r = await enviarResumo(tenant.id, true); return res.status(200).json(r); }
        case 'ficha_aluno':   return await acaoFichaAluno(tenant, body, res);
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
  let s;
  try { s = await prov.obterStatus(canal); }
  catch (e) {
    // provedor fora: devolve o último estado conhecido, com o aviso — a tela não trava
    return res.status(200).json({ status: canal.status || 'desconhecido', numero: canal.numero || null,
      provedor_fora: true, erro: e.message, ultimo_status_em: canal.conectado_em || null });
  }

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

  // pela fila de retomada vem só o lead: acha a conversa dele ou usa o telefone
  if (!body.conversa_id && !telefone && body.lead_id) {
    const c = await sb(`capta_conversas?lead_id=eq.${body.lead_id}&tenant_id=eq.${tenant.id}&select=id,telefone&order=ultima_mensagem_em.desc&limit=1`).catch(() => []);
    if (c?.[0]) { conversa = c[0]; telefone = c[0].telefone; }
    else {
      const l = await sb(`capta_leads?id=eq.${body.lead_id}&tenant_id=eq.${tenant.id}&select=contato&limit=1`).catch(() => []);
      if (l?.[0]?.contato) telefone = prov.comDDI(l[0].contato);
      else return res.status(404).json({ erro: 'Esse lead não tem telefone.' });
    }
  }

  if (body.conversa_id) {
    const rows = await sb(
      `capta_conversas?id=eq.${body.conversa_id}&tenant_id=eq.${tenant.id}&select=id,telefone,lid&limit=1`
    );
    conversa = rows && rows[0];
    if (!conversa) return res.status(404).json({ erro: 'Conversa não encontrada.' });
    // conversa de número escondido: manda para o @lid, não para "55"+lid
    const digitos = String(conversa.telefone || '').replace(/\D/g, '');
    telefone = digitos.length > 13 || (!digitos && conversa.lid) ? `${conversa.lid || digitos}@lid` : prov.comDDI(conversa.telefone);   // conversa antiga pode ter "55"+lid no telefone: o campo lid é o certo
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
      autor: body.autor && body.autor !== 'bot' ? body.autor : 'humano',
      autor_id: body.usuario_id || null,
      tipo: 'texto',
      texto,
      responde_a: body.responde_a || null,
      provedor_msg_id: envio.provedor_msg_id,
      entrega: 'enviada'
    })
  });

  // Quem responde primeiro fica com o lead: evita duas pessoas atendendo o mesmo pai.
  const quem = body.autor && !['bot','agente','sistema'].includes(body.autor) ? body.autor : null;
  if (quem) {
    const cl = await sb(`capta_conversas?id=eq.${conversa.id}&select=lead_id,atendente&limit=1`).catch(() => []);
    const leadDono = cl?.[0]?.lead_id;
    if (!cl?.[0]?.atendente) {
      await sb(`capta_conversas?id=eq.${conversa.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ atendente: quem }) }).catch(() => null);
    }
    if (leadDono) {
      const ld = await sb(`capta_leads?id=eq.${leadDono}&select=atendente&limit=1`).catch(() => []);
      if (!ld?.[0]?.atendente) {
        await sb(`capta_leads?id=eq.${leadDono}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ atendente: quem }) }).catch(() => null);
        await kommoCampos(tenant.id, leadDono, { atendente: quem }).catch(() => null);
      }
    }
  }

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
    `&select=id,telefone,agente_ativo,status,nao_lidas,ultima_mensagem,ultima_mensagem_em,atendente,resolvida_em,nome,foto_url,lid,aguardando_desde,` +
    `lead:lead_id(id,nome,temperatura,status,etapa_id,atendente,notas,contato,crianca,idade,kommo_lead_id)` +
    `&order=ultima_mensagem_em.desc.nullslast&limit=300`
  );

  // Retorno combinado na última ligação ("pediu pra ligar depois").
  // Vale só o registro mais recente de cada conversa: se alguém ligou de novo
  // e não marcou retorno, o compromisso anterior já foi cumprido.
  try {
    const desde = new Date(Date.now() - 30 * 864e5).toISOString();
    const ligs = await sb(`capta_ligacoes?tenant_id=eq.${tenant.id}&criado_em=gte.${desde}&select=conversa_id,retornar_em,criado_em&order=criado_em.desc&limit=400`);
    const vistas = new Set();
    const porConversa = {};
    for (const l of ligs || []) {
      if (!l.conversa_id || vistas.has(l.conversa_id)) continue;
      vistas.add(l.conversa_id);
      if (l.retornar_em) porConversa[l.conversa_id] = l.retornar_em;
    }
    for (const c of rows || []) if (porConversa[c.id]) c.retornar_em = porConversa[c.id];
  } catch (e) { /* sem tabela de ligações ainda: segue sem retornos */ }

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
    `&select=id,telefone,agente_ativo,nao_lidas,atendente,resolvida_em,nome,foto_url,lid,lead:lead_id(id,nome,temperatura,etapa_id,atendente,notas,contato,crianca,idade,kommo_lead_id)&limit=1`
  );
  if (!conv?.[0]) return res.status(404).json({ erro: 'Conversa não encontrada.' });

  const msgs = await sb(
    `capta_mensagens?conversa_id=eq.${id}&tenant_id=eq.${tenant.id}` +
    `&select=id,direcao,autor,tipo,texto,midia_url,midia_mime,entrega,criado_em,` +
    `transcricao,transcricao_status,responde_a,provedor_msg_id` +
    `&order=criado_em.desc&limit=300`
  );
  // Busca em ordem decrescente para pegar as MAIS RECENTES e devolve em
  // ordem cronológica. Com asc+limit, uma conversa longa (ou com histórico
  // importado) mostrava as 200 primeiras e engolia a mensagem recém-enviada.
  if (Array.isArray(msgs)) msgs.reverse();

  // Abrir a conversa zera o balão de não lidas — quem abriu, leu.
  // "sem resposta" (aguardando_desde) continua de pé até alguém responder
  // ou marcar como respondida: ler não é atender.
  if (conv[0].nao_lidas > 0) {
    await sb(`capta_conversas?id=eq.${id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ nao_lidas: 0 })
    }).catch(() => null);
    conv[0].nao_lidas = 0;
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
async function rodarCron(res, turno) {
  // resumo da manhã para quem ativou
  try {
    const donos = await sb(`capta_tenants?resumo_para=not.is.null&resumo_ativo=is.true&select=id`).catch(() => []);
    for (const d of donos || []) await enviarResumo(d.id).catch(() => null);
  } catch (e) { console.error('[resumo]', e.message); }

  const resumo = { enviados: 0, falhas: 0, negocios: 0, sessoes: 0 };

  try {
    const canais = await sb(`capta_canais?tipo=eq.whatsapp&status=eq.conectado&select=*`);

    for (const canal of canais || []) {
      resumo.negocios++;
      try { await lembretes(canal, resumo, turno || 'manha'); }
      catch (e) { console.error('[cron lembretes]', canal.tenant_id, e.message); }
    }

    for (const canal of canais || []) {
      if (turno === 'tarde') break;   // avisos internos só na passada da manhã
      try { await avisosInternos(canal, resumo); }
      catch (e) { console.error('[cron avisos]', canal.tenant_id, e.message); }
    }

    // O plano Hobby só deixa dois crons por dia, e os dois agora são desta
    // função (manhã e tarde). A sincronização do gasto do Meta Ads, que antes
    // tinha cron próprio, passou a ser chamada aqui na passada da manhã.
    if (turno !== 'tarde' && process.env.CRON_SECRET) {
      try {
        const base = process.env.CAPTA_URL || 'https://capta.riseagencia.com';
        await fetch(`${base}/api/capta-config?sync=${encodeURIComponent(process.env.CRON_SECRET)}`);
      } catch (e) { console.error('[cron meta]', e.message); }
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
// ---------------------------------------------------------------------
// LEMBRETE DA AULA EXPERIMENTAL — uma mensagem por aula, no turno anterior
//
//   aula de MANHÃ   → avisada na VÉSPERA, às 15h ("amanhã, pela manhã")
//   aula de TARDE   → avisada no MESMO DIA, às 8h ("hoje, pela tarde")
//
// O texto afirma que está tudo pronto em vez de perguntar se vem. Perguntar
// "qualquer imprevisto avise" convida ao cancelamento — foi o padrão que a
// operação percebeu e pediu para mudar.
// ---------------------------------------------------------------------
async function lembretes(canal, resumo, turno) {
  const hoje = hojeManaus();
  const amanha = new Date(new Date(hoje + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);

  // manhã (8h): aulas de hoje à tarde · tarde (15h): aulas de amanhã de manhã
  const alvoData = turno === 'tarde' ? amanha : hoje;
  const campo    = turno === 'tarde' ? 'lembrete_d1_em' : 'lembrete_d0_em';

  const ags = await sb(`capta_agendamentos?tenant_id=eq.${canal.tenant_id}&data=eq.${alvoData}` +
    `&status=in.(agendado,confirmado)&${campo}=is.null` +
    `&select=id,data,hora_inicio,crianca_nome,lead:lead_id(id,nome,contato)&order=hora_inicio`).catch(() => []);

  for (const a of ags || []) {
    const h = String(a.hora_inicio || '').slice(0, 5);
    // A tarde na My Robot começa às 14h: aula de 13h ainda é da manhã.
    const deManha = Number(h.slice(0, 2)) < 14;
    // cada turno cuida do seu: de manhã só as aulas da tarde, de tarde só as da manhã
    if (turno === 'tarde' ? !deManha : deManha) continue;
    const fone = a.lead?.contato;
    if (!fone) continue;

    const resp = String(a.lead?.nome || '').trim().split(' ')[0];
    const cri  = String(a.crianca_nome || '').trim().split(' ')[0];
    const saud = turno === 'tarde' ? 'Boa tarde' : 'Bom dia';
    const quando = turno === 'tarde' ? 'amanhã, pela parte da manhã' : 'hoje, pela parte da tarde';

    const texto = `${saud}${resp ? ' ' + resp : ''}, passando aqui para reforçar a aula experimental ` +
      `${cri ? 'do ' + cri + ' ' : ''}que acontecerá ${quando}, às ${h}.\n\n` +
      `Já estamos deixando tudo organizado e ficamos desde já ansiosos e felizes em recebê-los. 😊`;

    try {
      const envio = await prov.enviarTexto(canal, fone, texto);
      // marca antes do resto: no pior caso a família não recebe, o que é
      // melhor do que receber duas vezes
      await sb(`capta_agendamentos?id=eq.${a.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ [campo]: new Date().toISOString() })
      });
      await registrar(canal, { contato: String(fone).replace(/\D/g, ''), lead_id: a.lead?.id }, texto, envio.provedor_msg_id).catch(() => null);
      resumo.enviados++;
      await new Promise(r => setTimeout(r, 1500));   // ritmo humano
    } catch (e) {
      resumo.falhas++;
      console.error('[lembrete]', a.id, e.message);
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
       `&select=id,data,hora_inicio,hora_fim,status,crianca_nome,crianca_idade,turma_id,tipo,aluno_id,` +
       `confirmado_em,criado_em,lead:lead_id(id,nome,contato)&order=data.asc,hora_inicio.asc&limit=300`)
  ]);

  return res.status(200).json({ turmas: turmas || [], horarios: horarios || [], agendamentos: agendamentos || [] });
}

async function acaoAgendar(tenant, body, res) {
  const { turma_id, data, crianca_nome, crianca_idade } = body;
  if (!data) return res.status(400).json({ erro: 'Informe a data.' });
  // A escola aceita aula experimental em qualquer hora aberta, mesmo sem turma
  // regular no horário — nesse caso vem a hora no lugar da turma.
  if (!turma_id && body.hora_inicio == null) return res.status(400).json({ erro: 'Informe o horário.' });

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

  let hIni, hFim;
  if (turma_id) {
    const t = await sb(`capta_turmas?id=eq.${turma_id}&tenant_id=eq.${tenant.id}&select=hora_inicio,hora_fim&limit=1`);
    if (!t?.[0]) return res.status(404).json({ erro: 'Turma não encontrada.' });
    hIni = t[0].hora_inicio; hFim = t[0].hora_fim;
    // hora específica dentro do bloco da turma (a experimental dura 1 hora)
    if (body.hora_inicio != null) {
      const n = Number(String(body.hora_inicio).slice(0, 2));
      hIni = String(n).padStart(2, '0') + ':00:00';
      hFim = String(n + 1).padStart(2, '0') + ':00:00';
    }
  } else if (body.extra) {
    // Agendamento extra: fora do horário comercial, fim de semana, feriado.
    // Não depende de turma nem de vaga aberta e aceita minutos (19:30).
    const [hh0, mm0] = String(body.hora_inicio).split(':');
    const ini = Number(hh0) * 60 + Number(mm0 || 0);
    if (!(ini >= 0 && ini < 24 * 60)) return res.status(400).json({ erro: 'Horário inválido.' });
    const dur = Number(body.duracao_min) > 0 ? Number(body.duracao_min) : 60;
    const fim = Math.min(ini + dur, 24 * 60 - 1);
    const doisP = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`;
    hIni = doisP(ini); hFim = doisP(fim);
  } else {
    const n = Number(String(body.hora_inicio).slice(0, 2));
    hIni = String(n).padStart(2, '0') + ':00:00';
    hFim = String(n + 1).padStart(2, '0') + ':00:00';
  }

  try {
    const criado = await sb('capta_agendamentos', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        tenant_id: tenant.id, lead_id: leadId, turma_id: turma_id || null, data,
        hora_inicio: hIni, hora_fim: hFim,
        crianca_nome: crianca_nome || null,
        crianca_idade: crianca_idade || null,
        status: 'agendado',
        // a coluna "extra" vem do sql-agendamento-extra.sql; sem ela, a
        // gravação abaixo tenta de novo sem o campo e o agendamento entra igual
        ...(body.extra ? { extra: true } : {}),
        criado_por: body.usuario_email || 'painel'
      })
    }).catch(async err => {
      if (body.extra && /column .*extra|extra.* does not exist|PGRST204/i.test(String(err.message))) {
        return await sb('capta_agendamentos', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            tenant_id: tenant.id, lead_id: leadId, turma_id: null, data,
            hora_inicio: hIni, hora_fim: hFim,
            crianca_nome: crianca_nome || null, crianca_idade: crianca_idade || null,
            status: 'agendado', criado_por: body.usuario_email || 'painel'
          })
        });
      }
      throw err;
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
      // Aula marcada tira a conversa de "sem resposta" (o assunto foi tratado),
      // mas ela CONTINUA aberta: ainda falta confirmar presença e lembrar a família.
      await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=eq.${leadId}&resolvida_em=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ aguardando_desde: null })
      }).catch(() => null);
      const tt = turma_id ? await sb(`capta_turmas?id=eq.${turma_id}&select=dia_semana&limit=1`).catch(() => []) : [];
      const campos = { data_aula: `${data}T${String(hIni).slice(0,5)}:00-04:00`, bloco: blocoKommo(tt?.[0]?.dia_semana ?? new Date(data + 'T12:00:00').getDay(), hIni, hFim), crianca: crianca_nome || null, idade: crianca_idade ? Number(crianca_idade) : null };
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
  if (!agendamento_id || !data) return res.status(400).json({ erro: 'Dados incompletos.' });

  const a = await sb(`capta_agendamentos?id=eq.${agendamento_id}&tenant_id=eq.${tenant.id}&select=id,lead_id&limit=1`);
  if (!a?.[0]) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

  // Sem turma: a família pediu um dia/hora fora da grade. Vira encaixe — muda
  // data e hora no próprio agendamento, sem consumir vaga de turma nenhuma.
  if (!turma_id) {
    const hi = String(body.hora_inicio || '').slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(hi)) return res.status(400).json({ erro: 'Informe o horário.' });
    const [h, m] = hi.split(':').map(Number);
    const fim = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    await sb(`capta_agendamentos?id=eq.${agendamento_id}&tenant_id=eq.${tenant.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ data, hora_inicio: `${hi}:00`, hora_fim: fim, turma_id: null, extra: true, status: 'agendado' })
    });
    const leadId = a[0].lead_id;
    if (leadId) {
      const e = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Aula%20agendada&select=id&limit=1`))?.[0];
      if (e) { await moverLead(tenant.id, leadId, e.id, null); await empurrarKommo(tenant.id, leadId, e.id, null).catch(() => null); }
      const campos = { data_aula: `${data}T${hi}:00-04:00` };
      await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos) }).catch(() => null);
      await kommoCampos(tenant.id, leadId, campos).catch(() => null);
      await kommoTag(tenant.id, leadId, 'reagendado').catch(() => null);
    }
    return res.status(200).json({ ok: true, encaixe: true });
  }

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
  const [etapas, leads, motivos, convs] = await Promise.all([
    sb(`capta_etapas?tenant_id=eq.${tenant.id}&select=*&order=ordem`),
    sb(`capta_leads?tenant_id=eq.${tenant.id}` +
       `&select=id,nome,contato,temperatura,score,origem,etapa_id,etapa_em,criado_em,kommo_criado_em,motivo_perda,kommo_lead_id,atendente,tags,fonte,porta,crianca,idade,curso,data_aula,bloco,notas,email,campanha` +
       `&order=etapa_em.desc.nullslast,criado_em.desc&limit=1000`),
    sb(`capta_motivos?tenant_id=eq.${tenant.id}&ativo=is.true&select=id,nome,etapa&order=ordem`)
      .catch(() => []),
    // espera de resposta por lead (vem da conversa)
    sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=not.is.null&resolvida_em=is.null&select=lead_id,aguardando_desde,nao_lidas,ultima_mensagem_em,id`)
      .catch(() => [])
  ]);
  const porLead = {};
  (convs || []).forEach(c => { const a = porLead[c.lead_id]; if (!a || new Date(c.ultima_mensagem_em||0) > new Date(a.ultima_mensagem_em||0)) porLead[c.lead_id] = c; });
  (leads || []).forEach(l => { const c = porLead[l.id]; if (c) { l.aguardando_desde = c.aguardando_desde; l.nao_lidas = c.nao_lidas; l.conversa_id = c.id; l.ultima_mensagem_em = c.ultima_mensagem_em; } });
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
    sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=eq.${id}&select=id,telefone,agente_ativo,status,nao_lidas,atendente,resolvida_em&order=ultima_mensagem_em.desc.nullslast&limit=1`).catch(() => []),
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&lead_id=eq.${id}&select=id,data,hora_inicio,hora_fim,status,crianca_nome,crianca_idade,turma_id,remarcado_para,observacao&order=data.desc&limit=10`).catch(() => []),
    sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&select=status&limit=1`).catch(() => [])
  ]);
  let mensagens = [];
  if (conv?.[0]) {
    mensagens = await sb(`capta_mensagens?conversa_id=eq.${conv[0].id}&tenant_id=eq.${tenant.id}&select=id,direcao,autor,tipo,texto,transcricao,transcricao_status,midia_url,criado_em&order=criado_em.desc&limit=100`).catch(() => []);
    if (Array.isArray(mensagens)) mensagens.reverse();   // as 100 MAIS RECENTES, em ordem cronológica
  }
  // histórico completo: presença de cada aula, matrícula e aluno
  const agIds = (ags || []).map(a => a.id);
  const [presencas, matriculas, aluno] = await Promise.all([
    agIds.length ? sb(`capta_presencas?tenant_id=eq.${tenant.id}&agendamento_id=in.(${agIds.join(',')})&select=agendamento_id,entrada_em,saida_em,feedback,paga_hoje,motivo,comentario`).catch(() => []) : [],
    sb(`capta_matriculas?tenant_id=eq.${tenant.id}&lead_id=eq.${id}&select=id,valor_bruto,fechada_em,fechada_por,status&order=fechada_em.desc`).catch(() => []),
    sb(`capta_alunos?tenant_id=eq.${tenant.id}&lead_id=eq.${id}&select=id,nome,kit,turma_id,status&limit=1`).catch(() => [])
  ]);
  return res.status(200).json({
    conversa: conv?.[0] || null, mensagens: mensagens || [], agendamentos: ags || [],
    presencas: presencas || [], matriculas: matriculas || [], aluno: aluno?.[0] || null,
    canal: canais?.[0]?.status || null
  });
}

// CAMPOS — Fonte / Porta / Quem atendeu / anotações; grava no Capta e no Kommo
const KOMMO_FIELD = { fonte: 3886273, porta: 3886275, atendente: 3881999, data_aula: 3886283, bloco: 3886279, curso: 3886277, pagamento: 3886281 };
async function acaoCampos(tenant, body, res) {
  const id = (body.lead_id || '').trim();
  if (!id) return res.status(400).json({ erro: 'Informe lead_id.' });
  const patch = {};
  for (const k of ['fonte', 'porta', 'atendente', 'notas', 'crianca', 'email']) if (body[k] !== undefined) patch[k] = body[k] || null;
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
  // remarcações de aula de aluno (faltou e assiste em outro dia)
  const remarcacoes = await sb(`capta_remarcacoes?tenant_id=eq.${tenant.id}&select=id,aluno_id,data_original,turma_original,data_nova,turma_nova,hora_inicio,hora_fim,motivo,atendente&order=data_nova.desc&limit=400`).catch(() => []);

  const [turmas, alunos, kits] = await Promise.all([
    sb(`capta_turmas?tenant_id=eq.${tenant.id}&select=id,nome,dia_semana,hora_inicio,hora_fim,capacidade,limite_sala,kit_experimental,ativa&order=dia_semana,hora_inicio`),
    sb(`capta_alunos?tenant_id=eq.${tenant.id}&select=id,nome,nome_curto,kit,matricula,turma_id,lead_id,status,trancado_ate,observacao,confirmado_em,confirmado_por,email_responsavel,boas_vindas_em,criado_em&order=nome`).catch(() => []),
    sb(`capta_kits?tenant_id=eq.${tenant.id}&select=kit,capacidade,cor`).catch(() => [])
  ]);
  return res.status(200).json({ turmas: turmas || [], alunos: alunos || [], kits: kits || [], remarcacoes: remarcacoes || [] });
}

// cria / edita um aluno (nome, kit, turma, status, observação)
async function acaoAluno(tenant, body, res) {
  const campos = {};
  for (const k of ['nome', 'nome_curto', 'kit', 'turma_id', 'status', 'trancado_ate', 'observacao', 'lead_id', 'email_responsavel']) if (body[k] !== undefined) campos[k] = body[k] || null;
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
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&data=gte.${de}&data=lte.${ate}&select=id,lead_id,turma_id,data,hora_inicio,hora_fim,crianca_nome,crianca_idade,status,compareceu_em,observacao,criado_em,motivo_id,remarcado_de,remarcado_para,tipo,aluno_id,repoe_data&order=data,hora_inicio`),
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
  const etapa = async nome => {
    const exata = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.${encodeURIComponent(nome)}&select=id&limit=1`))?.[0]?.id;
    if (exata) return exata;
    // nome pode diferir no funil do cliente ("Perdido" vs "Perdidos")
    const parecida = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=ilike.*${encodeURIComponent(nome.slice(0, 6))}*&select=id&limit=1`).catch(() => []))?.[0]?.id;
    return parecida || null;
  };
  const patchAg = { observacao: body.observacao || null };
  let etapaNome = null, kommoExtra = {}, leadPatch = {};

  if (desfecho === 'faltou') { Object.assign(patchAg, { status: 'faltou' }); etapaNome = 'Aula agendada'; }
  // Perdido: "não matriculou" com o lead encerrado de vez, em vez de Remarketing
  const vaiPerdido = desfecho === 'nao' && body.perdido === true;
  if (desfecho === 'compareceu') { Object.assign(patchAg, { status: 'compareceu', compareceu_em: agora }); }
  // Em andamento: continua em Aula agendada, ganha a tag "em andamento" e a observação vira nota no Kommo
  if (desfecho === 'andamento') { Object.assign(patchAg, { status: 'compareceu', compareceu_em: a.status === 'compareceu' ? undefined : agora }); }
  // Não fechou: vai pra Remarketing com a tag "motivo: …"
  if (desfecho === 'nao') {
    Object.assign(patchAg, { status: 'compareceu', compareceu_em: a.status === 'compareceu' ? undefined : agora });
    etapaNome = vaiPerdido ? 'Perdido' : 'Remarketing';
    leadPatch.motivo_perda = body.motivo || null;
    if (vaiPerdido) leadPatch.status = 'perdido';
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
        // confirmado_em fica nulo: entra na fila do pedagógico para definir
        // turma e kit definitivos (a turma aqui é a da experimental)
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
    if (desfecho === 'faltou') {
      await kommoTag(tenant.id, a.lead_id, 'REAGENDAR').catch(() => null);
      await reabrirParaReagendar(tenant.id, a.lead_id, a.data).catch(() => null);
    }
    if (vaiPerdido && body.motivo) await kommoTag(tenant.id, a.lead_id, 'perdido: ' + String(body.motivo).toLowerCase()).catch(() => null);
  }
  return res.status(200).json({ ok: true, kommo, perdido: vaiPerdido });
}

// Faltou na experimental: o lead volta para a fila de atendimento com a tag
// REAGENDAR e já entra como URGENTE — ninguém pode esperar mais um dia para
// falar com quem não apareceu. O relógio de "sem resposta" nasce em 1h30
// (o corte do urgente) em vez de zero, senão a conversa demoraria a subir.
async function reabrirParaReagendar(tenantId, leadId, dataDaAula) {
  const l = (await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=tags&limit=1`))?.[0];
  const tags = [...new Set([...((l && l.tags) || []), 'REAGENDAR'])];
  await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tags })
  }).catch(() => null);
  const urgenteDesde = new Date(Date.now() - 91 * 60e3).toISOString();
  await sb(`capta_conversas?tenant_id=eq.${tenantId}&lead_id=eq.${leadId}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ resolvida_em: null, aguardando_desde: urgenteDesde })
  }).catch(() => null);
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
// Troca o nome genérico ("Contato do WhatsApp") pelo nome real no CONTATO do
// Kommo — é de lá que o espelho lê o nome; senão a próxima sincronização
// desfaz a correção. O nome do card só muda se também for genérico.
async function kommoRenomear(tenantId, leadId, nome) {
  const token = process.env.KOMMO_TOKEN; if (!token) return false;
  const l = await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id&limit=1`); if (!l?.[0]?.kommo_lead_id) return false;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const r = await fetch(`https://${dominio}/api/v4/leads/${l[0].kommo_lead_id}?with=contacts`, { headers: h });
  if (!r.ok) return false;
  const lead = await r.json();
  const cs = lead._embedded?.contacts || [];
  const cid = (cs.find(c => c.is_main) || cs[0])?.id;
  let ok = false;
  if (cid) ok = (await fetch(`https://${dominio}/api/v4/contacts/${cid}`, { method: 'PATCH', headers: h, body: JSON.stringify({ name: nome }) })).ok;
  const generico = !lead.name || /^(contato do whatsapp|lead #?\d+|novo lead|\+?[\d\s()-]{8,})$/i.test(String(lead.name).trim());
  if (generico) ok = (await fetch(`https://${dominio}/api/v4/leads/${lead.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ name: nome }) })).ok || ok;
  return ok;
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
  // Trocar quem atende também troca o DONO DO LEAD e fica registrado:
  // quem mudou (login), de quem para quem, quando. O histórico é lido
  // pela ação 'atendente_historico' e vira nota no card do Kommo.
  if (body.atendente !== undefined) {
    try {
      const c = (await sb(`capta_conversas?id=eq.${id}&tenant_id=eq.${tenant.id}&select=atendente,lead_id&limit=1`))?.[0];
      const de = c?.atendente || null, para = body.atendente || null;
      if (c && de !== para) {
        const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
        await sb('capta_atendente_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
          tenant_id: tenant.id, conversa_id: id, lead_id: c.lead_id || null,
          de, para, por_nome: quem?.nome || body.por_nome || 'alguém do painel',
          por_email: quem?.email || body.email_atual || null
        }) }).catch(() => null);
        if (c.lead_id) {
          await sb(`capta_leads?id=eq.${c.lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ atendente: para }) }).catch(() => null);
          notaKommoAtendente(tenant.id, c.lead_id, de, para, quem?.nome || body.por_nome || null).catch(() => null);
        }
      }
    } catch (e) { console.error('[atendente]', e.message); }
  }
  // aceita "resolvida" e "resolver" — o painel já mandava o segundo nome
  const fechar = body.resolvida !== undefined ? body.resolvida : body.resolver;
  if (fechar === true) { patch.resolvida_em = new Date().toISOString(); patch.nao_lidas = 0; patch.aguardando_desde = null; }
  if (fechar === false) patch.resolvida_em = null;
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
  const conv = (await sb(`capta_conversas?id=eq.${conversa_id}&tenant_id=eq.${tenant.id}&select=id,telefone,lid,lead_id&limit=1`))?.[0];
  if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada.' });
  const envio = await prov.enviarMidia(canal, String(conv.telefone || '').replace(/\D/g, '').length > 13 ? `${conv.lid || String(conv.telefone).replace(/\D/g, '')}@lid` : conv.telefone, tipo, dados, { nome, legenda });
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
  // Export "com mídia": a linha traz o nome do arquivo que está dentro do .zip.
  //   iPhone:  <anexado: 00000012-AUDIO-2026-09-01-10-22-33.opus>
  //   Android: PTT-20260901-WA0012.opus (arquivo anexado)
  // O arquivo em si sobe depois, um a um, pela ação importar_midia.
  const anexos = [];
  const linhas = msgs.map(m => {
    const daEscola = escola.includes(m.autor.toLowerCase());
    const arq = anexoDaLinha(m.texto);
    const tipo = arq ? tipoPorArquivo(arq.nome) : (/<M[ií]dia oculta>|imagem omitida|áudio omitido|<Media omitted>|v[ií]deo omitido|documento omitido|figurinha omitida/i.test(m.texto) ? 'midia' : 'texto');
    const texto = arq ? (arq.legenda || null) : m.texto.slice(0, 4000);
    const provedor_msg_id = 'import:' + crypto.createHash('md5').update(`${telefone}|${m.quando.toISOString()}|${m.autor}|${m.texto}`).digest('hex').slice(0, 24);
    if (arq) anexos.push({ provedor_msg_id, arquivo: arq.nome, tipo });
    return {
      tenant_id: tenant.id, conversa_id: conv.id,
      direcao: daEscola ? 'saida' : 'entrada',
      autor: daEscola ? m.autor : 'lead',
      tipo, texto, entrega: 'importada', criado_em: m.quando.toISOString(),
      transcricao_status: tipo === 'audio' ? 'pendente' : null,
      provedor_msg_id
    };
  });
  let gravadas = 0;
  for (let i = 0; i < linhas.length; i += 200) {
    const lote = linhas.slice(i, i + 200);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/capta_mensagens?on_conflict=provedor_msg_id`, { method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(lote) });
    if (!r.ok) { const t = await r.text(); if (/provedor_msg_id/.test(t) && /unique|conflict/i.test(t)) { /* sem índice único: insere sem on_conflict */ await sb('capta_mensagens', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(lote) }); } else throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`); }
    gravadas += lote.length;
  }
  const ultima = msgs[msgs.length - 1];
  await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ultima_mensagem: (ultima.texto || '').slice(0, 120) }) }).catch(() => null);

  // Devolve quais mensagens ainda estão sem arquivo, com o nome que o
  // navegador deve procurar dentro do .zip. Quem já tem midia_url (importação
  // repetida) não volta: não sobe o mesmo áudio duas vezes.
  let pendentes = [];
  if (anexos.length) {
    const ids = anexos.map(a => `"${a.provedor_msg_id}"`).join(',');
    const rows = await sb(`capta_mensagens?conversa_id=eq.${conv.id}&provedor_msg_id=in.(${ids})&select=id,provedor_msg_id,midia_url`).catch(() => []);
    for (const r of rows || []) {
      if (r.midia_url) continue;
      const a = anexos.find(x => x.provedor_msg_id === r.provedor_msg_id);
      if (a) pendentes.push({ mensagem_id: r.id, arquivo: a.arquivo, tipo: a.tipo });
    }
  }
  return res.status(200).json({ ok: true, conversa_id: conv.id, importadas: gravadas, midias: pendentes });
}

// "<anexado: X>" (iPhone, também <attached: X>) ou "X (arquivo anexado)" (Android, também (file attached)).
// Legenda, quando existe, vem na linha seguinte — o parser já juntou com \n.
function anexoDaLinha(texto) {
  const t = String(texto || '');
  let m = t.match(/<(?:anexado|attached|adjunto):\s*([^>]+)>/i);
  if (m) return { nome: m[1].trim(), legenda: t.replace(m[0], '').trim().slice(0, 4000) };
  m = t.match(/^(.+?\.[A-Za-z0-9]{2,5})\s*\((?:arquivo anexado|file attached|archivo adjunto)\)/i);
  if (m) return { nome: m[1].trim(), legenda: t.replace(m[0], '').trim().slice(0, 4000) };
  return null;
}
const MIME_IMPORT = {
  opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/mp4', wav: 'audio/wav', amr: 'audio/amr',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain', vcf: 'text/vcard'
};
function extDe(nome) { return String(nome || '').split('.').pop().toLowerCase(); }
function tipoPorArquivo(nome) {
  const e = extDe(nome), mime = MIME_IMPORT[e] || '';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return /sticker|STK-/i.test(nome) || e === 'webp' ? 'figurinha' : 'imagem';
  if (mime.startsWith('video/')) return 'video';
  return 'documento';
}
// Sobe um arquivo do .zip exportado para a mensagem já importada.
// Vem em base64 (data URL), um por chamada — o mesmo caminho do enviar_midia,
// dentro do limite de corpo do Vercel (~4,5 MB). Guarda igual ao webhook:
// capta-midia/<tenant>/<mensagem>.<ext> + linha em capta_midias.
async function acaoImportarMidia(tenant, body, res) {
  const { mensagem_id, dados, nome } = body;
  if (!mensagem_id || !dados) return res.status(400).json({ erro: 'Dados incompletos.' });
  const [m] = await sb(`capta_mensagens?id=eq.${mensagem_id}&tenant_id=eq.${tenant.id}&entrega=eq.importada&select=id,tipo,midia_url&limit=1`).catch(() => []);
  if (!m) return res.status(404).json({ erro: 'Mensagem importada não encontrada.' });
  if (m.midia_url) return res.status(200).json({ ok: true, ja: true });

  const b64 = String(dados).replace(/^data:[^;]*;base64,/, '');
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) return res.status(400).json({ erro: 'Arquivo vazio.' });
  const ext0 = extDe(nome);
  const mime = MIME_IMPORT[ext0] || (String(dados).match(/^data:([^;]+);/) || [])[1] || 'application/octet-stream';
  const ext = mime === 'audio/ogg' ? 'ogg' : mime === 'audio/mp4' ? 'm4a' : mime === 'image/jpeg' ? 'jpg' : (ext0 || 'bin');
  const caminho = `${tenant.id}/${m.id}.${ext}`;

  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/capta-midia/${caminho}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': mime, 'x-upsert': 'true' }, body: bytes
  });
  if (!up.ok) return res.status(500).json({ erro: `Não consegui guardar o arquivo (${up.status}).` });
  await sb('capta_midias', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tenant_id: tenant.id, mensagem_id: m.id, caminho, mime, tamanho: bytes.length }) }).catch(() => null);
  await sb(`capta_mensagens?id=eq.${m.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ midia_url: caminho, midia_mime: mime }) });
  return res.status(200).json({ ok: true, caminho });
}


// ---------------------------------------------------------------------
// EQUIPE E PERMISSÕES
// Papéis: gestor (tudo) · atendente (atende e agenda) · secretaria (alunos e agenda) · leitura (só vê)
// ---------------------------------------------------------------------
const PAPEIS = {
  gestor:     { nome: 'Gestor',     desc: 'Vê e faz tudo, inclusive equipe e painel.',              telas: ['atendimento','painel','pipeline','conversas','leads','agenda','aula','alunos','eventos','ajustes'], pode: ['*'] },
  atendente:  { nome: 'Atendente',  desc: 'Atende, agenda e dá baixa nas aulas. Não vê o painel.',  telas: ['atendimento','pipeline','conversas','leads','agenda','aula'],                                   pode: ['agenda','agendar','remarcar','presenca','funil','mover','lead','campos','experimentais','desfecho','desfazer','conversas','mensagens','midia','enviar','enviar_midia','conversa_atualizar','respostas','importar_historico','importar_midia','atendente_historico','ligacao','ligacoes','lead_novo','nota','notas','acesso','alunos','eu'] },
  secretaria: { nome: 'Secretaria', desc: 'Cuida dos alunos e da agenda. Não atende no WhatsApp.',  telas: ['atendimento','agenda','aula','alunos'],                                                          pode: ['agenda','agendar','remarcar','presenca','experimentais','desfecho','desfazer','alunos','aluno','aluno_confirmar','turmas_vagas','transferir_aluno','boas_vindas','lead_novo','nota','notas','repor','faltas_aluno','vagas_kit','remarcar_aluno','lead','funil','eu'] },
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
// ---------------------------------------------------------------------
// LIGAÇÃO — o Capta não disca: quem liga é o telefone de quem atende.
// O que ele faz é guardar o que aconteceu. Isso importa porque hoje uma
// conversa resolvida por telefone continuava marcada como "sem resposta":
// o lead tinha sido atendido e o painel dizia o contrário.
// resultado: falou | nao_atendeu | numero_errado | ligar_depois | caixa_postal
// ---------------------------------------------------------------------
const RESULTADOS_LIGACAO = {
  falou:         'falou com o lead',
  nao_atendeu:   'não atendeu',
  caixa_postal:  'caiu na caixa postal',
  numero_errado: 'número errado',
  ligar_depois:  'pediu para ligar depois'
};
async function acaoLigacao(tenant, body, res) {
  const { resultado, observacao, retornar_em } = body;
  if (!RESULTADOS_LIGACAO[resultado]) return res.status(400).json({ erro: 'Resultado da ligação inválido.' });

  let conv = null, leadId = (body.lead_id || '').trim() || null;
  if (body.conversa_id) {
    conv = (await sb(`capta_conversas?id=eq.${body.conversa_id}&tenant_id=eq.${tenant.id}&select=id,telefone,lead_id,atendente&limit=1`))?.[0];
    if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada.' });
    leadId = leadId || conv.lead_id;
  }
  if (!conv && !leadId) return res.status(400).json({ erro: 'Informe conversa_id ou lead_id.' });

  const lead = leadId ? (await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenant.id}&select=id,nome,contato,atendente,kommo_lead_id&limit=1`))?.[0] : null;
  const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
  const porNome = quem?.nome || body.por_nome || 'alguém do painel';

  await sb('capta_ligacoes', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id, lead_id: leadId, conversa_id: conv?.id || null,
    telefone: conv?.telefone || lead?.contato || null,
    resultado, observacao: observacao || null, retornar_em: retornar_em || null,
    por_nome: porNome, por_email: quem?.email || body.email_atual || null
  }) }).catch(e => { throw e; });

  // Falou = atendido: sai da fila de "sem resposta" e ganha dono, se não tinha.
  if (resultado === 'falou' && conv) {
    const patch = { aguardando_desde: null };
    if (!conv.atendente && porNome !== 'alguém do painel') patch.atendente = porNome;
    await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }).catch(() => null);
    if (leadId && patch.atendente) await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ atendente: patch.atendente }) }).catch(() => null);
  }

  // Nota no card do Kommo, pra quem acompanha por lá ver a ligação.
  if (lead?.kommo_lead_id) {
    const quando = retornar_em ? ` · retornar ${new Date(retornar_em).toLocaleString('pt-BR', { timeZone: 'America/Manaus', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
    notaKommoTexto(tenant.id, lead.kommo_lead_id, `Capta · ligação (${porNome}): ${RESULTADOS_LIGACAO[resultado]}${quando}${observacao ? ` — ${observacao}` : ''}`).catch(() => null);
  }
  return res.status(200).json({ ok: true });
}

async function acaoLigacoes(tenant, body, res) {
  const filtros = [];
  if (body.conversa_id) filtros.push(`conversa_id=eq.${body.conversa_id}`);
  if (body.lead_id) filtros.push(`lead_id=eq.${body.lead_id}`);
  if (!filtros.length) return res.status(400).json({ erro: 'Informe conversa_id ou lead_id.' });
  const filtro = filtros.length > 1 ? `or=(${filtros.join(',')})` : filtros[0];
  const linhas = await sb(`capta_ligacoes?tenant_id=eq.${tenant.id}&${filtro}&select=resultado,observacao,retornar_em,por_nome,telefone,criado_em&order=criado_em.desc&limit=30`).catch(() => []);
  return res.status(200).json({ ligacoes: linhas || [], rotulos: RESULTADOS_LIGACAO });
}

// Quem já cuidou desta conversa, na ordem: quem passou, para quem, e o
// login de quem fez a troca.
async function acaoAtendenteHistorico(tenant, body, res) {
  const id = (body.conversa_id || '').trim();
  const leadId = (body.lead_id || '').trim();
  if (!id && !leadId) return res.status(400).json({ erro: 'Informe conversa_id ou lead_id.' });
  const filtro = id ? `conversa_id=eq.${id}` : `lead_id=eq.${leadId}`;
  const linhas = await sb(`capta_atendente_log?tenant_id=eq.${tenant.id}&${filtro}&select=de,para,por_nome,por_email,criado_em&order=criado_em.desc&limit=30`).catch(() => []);
  return res.status(200).json({ historico: linhas || [] });
}

// Nota no card do Kommo, para quem trabalha lá ver a troca de dono.
async function notaKommoAtendente(tenantId, leadId, de, para, porQuem) {
  const l = (await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=kommo_lead_id&limit=1`))?.[0];
  if (!l?.kommo_lead_id) return;
  await notaKommoTexto(tenantId, l.kommo_lead_id, `Capta · quem atende: ${de || 'sem dono'} → ${para || 'sem dono'}${porQuem ? ` (alterado por ${porQuem})` : ''}`);
}

async function notaKommoTexto(tenantId, kommoLeadId, texto) {
  const token = process.env.KOMMO_TOKEN; if (!token || !kommoLeadId) return;
  const dominio = process.env.KOMMO_DOMAIN || 'roboticanorte.kommo.com';
  await fetch(`https://${dominio}/api/v4/leads/${kommoLeadId}/notes`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ note_type: 'common', params: { text: texto } }])
  }).catch(() => {});
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
      if (l.ganho_em || /venda ganha|aluno ativo|matriculado/i.test(nome(l.etapa_id))) { b.matriculas++; b.receita += Number(l.valor) || 0; }
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
  const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&evento_id=eq.${id}&select=id,nome,contato,temperatura,score,etapa_id,atendente,data_aula,ganho_em,valor,criado_em,kommo_lead_id,tags,kommo_criado_em&order=criado_em.desc`).catch(() => []);
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
// MAPEAR AULAS — leads parados em "Aula agendada" sem agendamento no Capta.
// Descobre o dia e a hora combinados: primeiro pelo campo "Data da aula" do
// Kommo; se ele estiver vazio, a IA lê a conversa do WhatsApp (e as notas do
// lead) e extrai. Devolve uma PROPOSTA por lead, com confiança e o trecho
// que a justifica — quem agenda é a tela, depois que a pessoa confere.
// Vem em lotes pequenos (até 8) por causa do tempo limite da função.
// ---------------------------------------------------------------------
async function acaoMapearAulas(tenant, body, res) {
  const ids = Array.isArray(body.lead_ids) ? body.lead_ids.slice(0, 8) : [];
  if (!ids.length) return res.status(400).json({ erro: 'Informe lead_ids.' });
  const chave = process.env.ANTHROPIC_API_KEY;
  const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&id=in.(${ids.join(',')})&select=id,nome,contato,crianca,idade,notas,data_aula,etapa_em,kommo_lead_id`).catch(() => []);
  const hoje = new Date(Date.now() - 4 * 3600e3);   // Manaus (UTC-4)
  const DIAS = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  const fmtMsg = m => {
    const d = new Date(new Date(m.criado_em).getTime() - 4 * 3600e3);
    const quando = `${d.toISOString().slice(0, 10)} (${DIAS[d.getUTCDay()]}) ${d.toISOString().slice(11, 16)}`;
    const quem = m.direcao === 'saida' ? 'ESCOLA' : 'RESPONSÁVEL';
    const txt = m.texto || m.transcricao || (m.tipo && m.tipo !== 'texto' ? `[${m.tipo}]` : '');
    return `[${quando}] ${quem}: ${String(txt).replace(/\s+/g, ' ').slice(0, 400)}`;
  };
  const resultados = await Promise.all((leads || []).map(async l => {
    const base = { lead_id: l.id, nome: l.nome, crianca: l.crianca, idade: l.idade, kommo_lead_id: l.kommo_lead_id };
    // 1) campo do Kommo já traz dia e hora
    if (l.data_aula) {
      const d = new Date(l.data_aula);
      if (!isNaN(d) && d.getUTCHours() + d.getUTCMinutes() > 0) {
        const loc = new Date(d.getTime() - 4 * 3600e3);
        return { ...base, data: loc.toISOString().slice(0, 10), hora: loc.toISOString().slice(11, 16), confianca: 'alta', fonte: 'campo "Data da aula" do Kommo', trecho: null };
      }
    }
    // 2) conversa
    const conv = (await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=eq.${l.id}&select=id&order=ultima_mensagem_em.desc.nullslast&limit=1`).catch(() => []))?.[0];
    const msgs = conv ? await sb(`capta_mensagens?conversa_id=eq.${conv.id}&select=direcao,tipo,texto,transcricao,criado_em&order=criado_em.desc&limit=60`).catch(() => []) : [];
    const fala = (msgs || []).reverse().map(fmtMsg).filter(x => !/: $/.test(x));
    if (!fala.length && !l.notas) return { ...base, data: null, hora: null, confianca: 'nenhuma', fonte: 'sem conversa no Capta', trecho: null };
    if (!chave) return { ...base, data: null, hora: null, confianca: 'nenhuma', fonte: 'IA não configurada', trecho: null };
    try {
      const rr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300,
          system: `Você lê conversas de WhatsApp entre uma escola de robótica infantil em Manaus e responsáveis, e descobre QUANDO ficou combinada a aula experimental. Hoje é ${hoje.toISOString().slice(0, 10)} (${DIAS[hoje.getUTCDay()]}). Cada mensagem traz a data em que foi enviada: resolva "amanhã", "sábado", "semana que vem" a partir da data da mensagem que combinou, não de hoje. Considere combinado só o que a escola confirmou ou o responsável aceitou; se depois remarcaram, vale a última combinação. Responda SOMENTE um JSON: {"data":"AAAA-MM-DD" ou null,"hora":"HH:MM" ou null,"crianca":nome ou null,"idade":número ou null,"confianca":"alta"|"media"|"baixa"|"nenhuma","trecho":"a frase da conversa que mostra a combinação, curta"}. Sem hora explícita, hora null. Nunca invente.`,
          messages: [{ role: 'user', content: `LEAD: ${l.nome || ''}${l.crianca ? ` · filho(a): ${l.crianca}` : ''}${l.idade ? `, ${l.idade} anos` : ''}\nNOTAS: ${l.notas || '—'}\n\nCONVERSA:\n${fala.join('\n')}` }] }) });
      const jj = await rr.json();
      const txt = (jj.content || []).filter(x => x.type === 'text').map(x => x.text).join('').replace(/```json|```/g, '').trim();
      const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
      return { ...base, crianca: base.crianca || j.crianca || null, idade: base.idade || j.idade || null, data: j.data || null, hora: j.hora || null, confianca: j.confianca || 'baixa', fonte: 'conversa do WhatsApp', trecho: j.trecho || null };
    } catch (e) {
      return { ...base, data: null, hora: null, confianca: 'nenhuma', fonte: 'IA não conseguiu ler', trecho: null };
    }
  }));
  return res.status(200).json({ leads: resultados });
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


// ---------------------------------------------------------------------
// RECEPÇÃO — tablet de check-in/out e monitor da sala
// ---------------------------------------------------------------------
async function acaoRecepcao(tenant, body, res) {
  const dia = body.data || hojeManaus();
  const dow = new Date(dia + 'T12:00:00').getDay();
  const [turmas, alunos, ags, presencas] = await Promise.all([
    sb(`capta_turmas?tenant_id=eq.${tenant.id}&ativa=is.true&dia_semana=eq.${dow}&select=id,nome,hora_inicio,hora_fim,limite_sala&order=hora_inicio`).catch(() => []),
    sb(`capta_alunos?tenant_id=eq.${tenant.id}&status=eq.ativo&select=id,nome,nome_curto,kit,turma_id`).catch(() => []),
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&data=eq.${dia}&status=in.(agendado,confirmado,compareceu)&select=id,lead_id,turma_id,hora_inicio,hora_fim,crianca_nome,crianca_idade,status,compareceu_em,observacao`).catch(() => []),
    sb(`capta_presencas?tenant_id=eq.${tenant.id}&data=eq.${dia}&select=id,aluno_id,agendamento_id,entrada_em,saida_em,feedback,paga_hoje,motivo`).catch(() => [])
  ]);
  const ids = [...new Set((ags || []).map(a => a.lead_id).filter(Boolean))];
  const leads = ids.length ? await sb(`capta_leads?tenant_id=eq.${tenant.id}&id=in.(${ids.join(',')})&select=id,nome,contato,temperatura,atendente,crianca,idade,kommo_lead_id,notas`).catch(() => []) : [];
  return res.status(200).json({ data: dia, turmas: turmas || [], alunos: alunos || [], agendamentos: ags || [], presencas: presencas || [], leads: leads || [] });
}

// check-in / check-out — aluno ativo (aluno_id) ou aula experimental (agendamento_id)
async function acaoCheckin(tenant, body, res) {
  const dia = body.data || hojeManaus();
  const { aluno_id, agendamento_id, saida } = body;
  if (!aluno_id && !agendamento_id) return res.status(400).json({ erro: 'Informe o aluno ou a aula.' });
  const filtro = aluno_id ? `aluno_id=eq.${aluno_id}` : `agendamento_id=eq.${agendamento_id}`;
  const ja = (await sb(`capta_presencas?tenant_id=eq.${tenant.id}&data=eq.${dia}&${filtro}&select=id,entrada_em,saida_em&limit=1`).catch(() => []))?.[0];
  const agora = new Date().toISOString();
  let reg;
  if (!ja) {
    reg = (await sb('capta_presencas', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
      tenant_id: tenant.id, data: dia, aluno_id: aluno_id || null, agendamento_id: agendamento_id || null, entrada_em: agora }) }))[0];
  } else if (saida || (ja.entrada_em && !ja.saida_em && saida !== false)) {
    const extra = {}; if (body.nota != null) extra.feedback = Number(body.nota); if (body.comentario) extra.comentario = String(body.comentario).slice(0, 400);
    await sb(`capta_presencas?id=eq.${ja.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ saida_em: agora, ...extra }) });
    reg = { ...ja, saida_em: agora };
  } else reg = ja;
  // aula experimental: entrar marca presença no agendamento
  if (agendamento_id && !ja) await sb(`capta_agendamentos?id=eq.${agendamento_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'compareceu', compareceu_em: agora }) }).catch(() => null);
  return res.status(200).json({ ok: true, presenca: reg });
}

// feedback do check-out da aula experimental (e desfecho automático quando fecha na hora)
async function acaoFeedback(tenant, body, res) {
  const { agendamento_id, nota, paga_hoje, motivo, comentario, pagamento, valor } = body;
  if (!agendamento_id) return res.status(400).json({ erro: 'Informe a aula.' });
  const dia = body.data || hojeManaus();
  const p = (await sb(`capta_presencas?tenant_id=eq.${tenant.id}&data=eq.${dia}&agendamento_id=eq.${agendamento_id}&select=id&limit=1`).catch(() => []))?.[0];
  const dados = { feedback: nota ?? null, paga_hoje: paga_hoje ?? null, motivo: motivo || null, comentario: comentario || null, saida_em: new Date().toISOString() };
  if (p) await sb(`capta_presencas?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
  else await sb('capta_presencas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tenant_id: tenant.id, data: dia, agendamento_id, entrada_em: new Date().toISOString(), ...dados }) });
  // fecha o ciclo: paga hoje = matrícula; não paga = motivo registrado, lead segue em remarketing
  if (paga_hoje === true) return acaoDesfecho(tenant, { agendamento_id, desfecho: 'matriculou', pagamento: pagamento || null, valor: valor || null, atendente: body.atendente, observacao: `desfecho: matriculou · ${pagamento || 'na recepção'}` }, res);
  if (paga_hoje === false && motivo) return acaoDesfecho(tenant, { agendamento_id, desfecho: 'nao', motivo, atendente: body.atendente, observacao: `desfecho: nao · ${motivo}` }, res);

  // Nota baixa: ninguém filtra quem pode avaliar (o Google proíbe), mas o time
  // precisa saber na hora para ligar antes que a família vá embora chateada.
  if (nota != null && Number(nota) <= 3) await alertarNotaBaixa(tenant, agendamento_id, Number(nota), comentario).catch(() => null);

  // Convite para avaliar no Google, logo depois do check-out — é quando a
  // família ainda está com a experiência fresca. Vai o texto pronto, para a
  // pessoa só colar, e o link direto da avaliação.
  let convite = null;
  if (body.convidar_avaliacao !== false) convite = await convidarAvaliacao(tenant, agendamento_id, { nota, comentario }).catch(e => ({ erro: e.message }));
  return res.status(200).json({ ok: true, convite });
}

// Nota 3 ou menos no tablet: a conversa volta para a fila como urgente, com a
// tag ATENDER, e fica a nota do que a família disse. É o caminho legítimo —
// resolver o problema em vez de esconder a avaliação.
async function alertarNotaBaixa(tenant, agendamentoId, nota, comentario) {
  const [ag] = await sb(`capta_agendamentos?id=eq.${agendamentoId}&tenant_id=eq.${tenant.id}&select=id,crianca_nome,lead_id&limit=1`).catch(() => []);
  if (!ag?.lead_id) return;
  const texto = `Aula experimental avaliada com ${nota} estrela${nota === 1 ? '' : 's'} no tablet${comentario ? `: ${comentario}` : '.'} Ligar antes de convidar para nova visita.`;
  await sb('capta_notas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id, lead_id: ag.lead_id, texto, autor_nome: 'tablet da recepção'
  }) }).catch(() => null);

  const l = (await sb(`capta_leads?id=eq.${ag.lead_id}&tenant_id=eq.${tenant.id}&select=tags,kommo_lead_id&limit=1`).catch(() => []))?.[0];
  const tags = [...new Set([...((l && l.tags) || []), 'ATENDER'])];
  await sb(`capta_leads?id=eq.${ag.lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tags }) }).catch(() => null);
  // urgente já: o relógio nasce em 1h30, que é o corte do urgente na inbox
  await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=eq.${ag.lead_id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ resolvida_em: null, aguardando_desde: new Date(Date.now() - 91 * 60e3).toISOString() })
  }).catch(() => null);
  if (l?.kommo_lead_id) {
    await kommoTag(tenant.id, ag.lead_id, 'feedback baixo').catch(() => null);
    await notaKommoTexto(tenant.id, l.kommo_lead_id, `Capta · ${texto}`).catch(() => null);
  }
}

async function convidarAvaliacao(tenant, agendamentoId, fb) {
  const [t] = await sb(`capta_tenants?id=eq.${tenant.id}&select=nome,link_avaliacao&limit=1`);
  if (!t?.link_avaliacao) return { pulado: 'sem link de avaliação configurado' };
  const [canal] = await sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&status=eq.conectado&select=*&limit=1`).catch(() => []);
  if (!canal) return { pulado: 'WhatsApp não conectado' };
  const [ag] = await sb(`capta_agendamentos?id=eq.${agendamentoId}&tenant_id=eq.${tenant.id}&select=id,crianca_nome,lead:lead_id(id,nome,contato)&limit=1`).catch(() => []);
  const fone = ag?.lead?.contato;
  if (!fone) return { pulado: 'lead sem telefone' };

  const primeiroNome = String(ag.lead.nome || '').trim().split(' ')[0];
  const crianca = String(ag.crianca_nome || '').trim().split(' ')[0];
  // O comentário que a família deu no tablet vira o rascunho da avaliação.
  const dito = String(fb.comentario || '').replace(/^(gostou de|melhorar):\s*/i, '').trim();
  const rascunho = dito
    ? `${dito.charAt(0).toUpperCase()}${dito.slice(1)}. ${crianca ? `${crianca} adorou a aula` : 'Adoramos a aula'} na ${t.nome}!`
    : `${crianca ? `${crianca} adorou` : 'Adoramos'} a aula experimental na ${t.nome}. Equipe atenciosa e crianças envolvidas do começo ao fim.`;

  const texto = `${primeiroNome ? `Oi, ${primeiroNome}! ` : 'Oi! '}Obrigado pela visita de hoje 🤖\n\n` +
    `Sua opinião ajuda outras famílias a nos encontrar. Se puder avaliar a escola no Google, leva menos de um minuto:\n${t.link_avaliacao}\n\n` +
    `Se quiser, é só copiar e colar o texto abaixo:\n\n_${rascunho}_`;

  const envio = await prov.enviarTexto(canal, fone, texto);
  // registra na conversa, para o histórico não ter buraco
  await registrar(canal, { contato: String(fone).replace(/\D/g, ''), lead_id: ag.lead.id }, texto, envio?.provedor_msg_id).catch(() => null);
  return { ok: true, para: fone };
}


// Visitante que chegou sem agendamento: cria o lead, a aula de hoje e já marca presença.
async function acaoVisitaAvulsa(tenant, body, res) {
  const fone = String(body.telefone || '').replace(/\D/g, '');
  const crianca = String(body.crianca || '').trim();
  if (!crianca || fone.length < 10) return res.status(400).json({ erro: 'Informe o nome da criança e o WhatsApp.' });
  const dia = hojeManaus(), dow = new Date(dia + 'T12:00:00').getDay();
  const agoraMin = new Date().getHours() * 60 + new Date().getMinutes();
  const turmas = await sb(`capta_turmas?tenant_id=eq.${tenant.id}&ativa=is.true&dia_semana=eq.${dow}&select=id,hora_inicio,hora_fim&order=hora_inicio`).catch(() => []);
  const turma = (turmas || []).find(t => { const ini = Number(String(t.hora_inicio).slice(0,2)) * 60 + Number(String(t.hora_inicio).slice(3,5)); const fim = Number(String(t.hora_fim).slice(0,2)) * 60 + Number(String(t.hora_fim).slice(3,5)); return agoraMin >= ini - 30 && agoraMin <= fim; }) || (turmas || [])[0];
  if (!turma) return res.status(409).json({ erro: 'Não há turma hoje pra registrar a visita.' });
  // lead: reaproveita se o telefone já existir
  const existente = (await sb(`capta_leads?tenant_id=eq.${tenant.id}&contato=eq.${fone}&select=id&limit=1`).catch(() => []))?.[0];
  let leadId = existente?.id;
  if (!leadId) {
    const novoLead = await sb('capta_leads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
      tenant_id: tenant.id, nome: crianca, contato: fone, crianca, idade: body.idade ? Number(body.idade) : null,
      origem: 'my robot', fonte: 'direto', porta: 'my robot', status: 'contatado', temperatura: 'Quente',
      notas: 'Visita espontânea registrada na recepção' }) });
    leadId = novoLead?.[0]?.id;
  }
  const ag = await sb('capta_agendamentos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
    tenant_id: tenant.id, lead_id: leadId || null, turma_id: turma.id, data: dia, hora_inicio: turma.hora_inicio, hora_fim: turma.hora_fim,
    crianca_nome: crianca, crianca_idade: body.idade ? Number(body.idade) : null, status: 'compareceu', compareceu_em: new Date().toISOString(),
    observacao: 'visita espontânea (recepção)', criado_por: 'recepcao' }) });
  const agId = ag?.[0]?.id;
  if (agId) await sb('capta_presencas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id, data: dia, agendamento_id: agId, entrada_em: new Date().toISOString() }) }).catch(() => null);
  if (leadId) { const e = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Aula%20agendada&select=id&limit=1`).catch(() => []))?.[0];
    if (e) { await moverLead(tenant.id, leadId, e.id, null).catch(() => null); await empurrarKommo(tenant.id, leadId, e.id, null).catch(() => null); } }
  return res.status(200).json({ ok: true, agendamento_id: agId, lead_id: leadId });
}


// ---------------------------------------------------------------------
// RESUMO DA MANHÃ — o dono abre o WhatsApp e já sabe como está o dia
// ---------------------------------------------------------------------
async function acaoResumoConfig(tenant, body, res) {
  if (body.salvar) {
    const c = body.salvar;
    const dados = { resumo_para: (c.telefone || '').replace(/\D/g, '') || null, resumo_ativo: c.ativo !== false, resumo_hora: c.hora || '08:00' };
    if (c.link_avaliacao !== undefined) dados.link_avaliacao = String(c.link_avaliacao || '').trim() || null;
    if (c.email_remetente !== undefined) {
      const r = String(c.email_remetente || '').trim();
      if (r && !/^[^<]*<[^@]+@[^>]+>$|^[^@\s]+@[^@\s]+$/.test(r)) return res.status(400).json({ erro: 'Use o formato Nome <email@dominio.com> ou só o e-mail.' });
      dados.email_remetente = r || null;
    }
    await sb(`capta_tenants?id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
  }
  const [t] = await sb(`capta_tenants?id=eq.${tenant.id}&select=resumo_para,resumo_ativo,resumo_hora,email_remetente,link_avaliacao&limit=1`);
  return res.status(200).json({ config: t || {} });
}

// Quem recebe aviso interno, e de quê. Uma linha por pessoa.
async function acaoAvisos(tenant, body, res) {
  if (body.apagar) await sb(`capta_avisos?id=eq.${body.apagar}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (body.salvar) {
    const a = body.salvar;
    const fone = String(a.telefone || '').replace(/\D/g, '');
    if (!fone) return res.status(400).json({ erro: 'Informe o WhatsApp.' });
    const dados = { nome: a.nome || null, telefone: fone.startsWith('55') ? fone : `55${fone}`, tipos: Array.isArray(a.tipos) ? a.tipos : [], ativo: a.ativo !== false };
    if (a.id) await sb(`capta_avisos?id=eq.${a.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(dados) });
    else await sb('capta_avisos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tenant_id: tenant.id, ...dados }) });
  }
  if (body.testar) {
    const [canal] = await sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&status=eq.conectado&select=*&limit=1`).catch(() => []);
    if (!canal) return res.status(400).json({ erro: 'WhatsApp não está conectado.' });
    const r = { enviados: 0, falhas: 0 };
    await avisosInternos(canal, r);
    return res.status(200).json({ ok: true, ...r, avisos: await sb(`capta_avisos?tenant_id=eq.${tenant.id}&select=id,nome,telefone,tipos,ativo&order=criado_em`).catch(() => []) });
  }
  const lista = await sb(`capta_avisos?tenant_id=eq.${tenant.id}&select=id,nome,telefone,tipos,ativo&order=criado_em`).catch(() => []);
  return res.status(200).json({ avisos: lista || [] });
}

function plural(n, um, muitos) { return `${n} ${n === 1 ? um : muitos}`; }
async function montarResumo(tenantId) {
  const hoje = hojeManaus();
  const ontem = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const mes = hoje.slice(0, 7);
  const [tenant] = await sb(`capta_tenants?id=eq.${tenantId}&select=nome&limit=1`);
  const [ags, leads, etapas, alunos, conversas] = await Promise.all([
    sb(`capta_agendamentos?tenant_id=eq.${tenantId}&data=eq.${hoje}&status=in.(agendado,confirmado,compareceu)&select=id,hora_inicio,crianca_nome,status,lead_id&order=hora_inicio`).catch(() => []),
    sb(`capta_leads?tenant_id=eq.${tenantId}&select=id,nome,temperatura,etapa_id,etapa_em,criado_em,kommo_criado_em,ganho_em,valor,data_aula&limit=2000`).catch(() => []),
    sb(`capta_etapas?tenant_id=eq.${tenantId}&select=id,nome`).catch(() => []),
    sb(`capta_alunos?tenant_id=eq.${tenantId}&status=eq.ativo&select=id`).catch(() => []),
    sb(`capta_conversas?tenant_id=eq.${tenantId}&nao_lidas=gt.0&resolvida_em=is.null&select=id`).catch(() => [])
  ]);
  const nomeEt = id => (etapas.find(e => e.id === id) || {}).nome || '';
  const dt = l => l.kommo_criado_em || l.criado_em || '';
  const novos = (leads || []).filter(l => dt(l).slice(0, 10) === ontem).length;
  const doMes = (leads || []).filter(l => dt(l).slice(0, 7) === mes);
  const mats = doMes.filter(l => l.ganho_em || /venda ganha|aluno ativo|matriculado/i.test(nomeEt(l.etapa_id)));
  const receita = mats.reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const parados = (leads || []).filter(l => /novo lead|em contato|qualificado/i.test(nomeEt(l.etapa_id)) && l.etapa_em && (Date.now() - new Date(l.etapa_em)) / 864e5 >= 3).length;
  const quentesSemAula = (leads || []).filter(l => (l.temperatura || '').toLowerCase() === 'quente' && !l.data_aula && !/aula agendada|matr|aluno|venda ganha|perdid/i.test(nomeEt(l.etapa_id))).length;

  const L = [];
  L.push(`☀️ *Bom dia!* Resumo da ${tenant?.nome || 'unidade'} — ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`);
  L.push('');
  if (ags?.length) {
    L.push(`🤖 *Aulas experimentais hoje: ${ags.length}*`);
    for (const a of ags.slice(0, 8)) L.push(`   ${String(a.hora_inicio).slice(0,5)} · ${a.crianca_nome || 'visitante'}${a.status === 'confirmado' ? ' ✅ confirmou' : a.status === 'compareceu' ? ' · já chegou' : ''}`);
    if (ags.length > 8) L.push(`   e mais ${ags.length - 8}`);
  } else L.push('🤖 *Nenhuma aula experimental hoje*');
  L.push('');
  L.push(`📈 *No mês:* ${plural(mats.length, 'matrícula', 'matrículas')}${receita ? ` · R$ ${receita.toLocaleString('pt-BR')}` : ''} · ${plural(doMes.length, 'lead novo', 'leads novos')}`);
  L.push(`👥 ${plural((alunos || []).length, 'aluno ativo', 'alunos ativos')}`);
  L.push('');
  const pend = [];
  if (conversas?.length) pend.push(`💬 ${plural(conversas.length, 'conversa esperando resposta', 'conversas esperando resposta')}`);
  if (quentesSemAula) pend.push(`🔥 ${plural(quentesSemAula, 'lead quente sem aula marcada', 'leads quentes sem aula marcada')}`);
  if (parados) pend.push(`⏳ ${plural(parados, 'lead parado há 3+ dias', 'leads parados há 3+ dias')}`);
  if (novos) pend.push(`✨ ${plural(novos, 'lead chegou ontem', 'leads chegaram ontem')}`);
  if (pend.length) { L.push('*Para hoje:*'); pend.forEach(x => L.push(`   ${x}`)); }
  else L.push('Tudo em dia por aqui 👏');
  return L.join('\n');
}
async function enviarResumo(tenantId, forcar) {
  const [t] = await sb(`capta_tenants?id=eq.${tenantId}&select=resumo_para,resumo_ativo&limit=1`);
  if (!t?.resumo_para) return { erro: 'Sem número configurado para o resumo.' };
  if (!forcar && t.resumo_ativo === false) return { pulado: 'desligado' };
  const [canal] = await sb(`capta_canais?tenant_id=eq.${tenantId}&tipo=eq.whatsapp&status=eq.conectado&select=*&limit=1`).catch(() => []);
  if (!canal) return { erro: 'WhatsApp não está conectado.' };
  const texto = await montarResumo(tenantId);
  await prov.enviarTexto(canal, t.resumo_para, texto);
  return { ok: true, enviado_para: t.resumo_para };
}


// ---------------------------------------------------------------------
// FICHA DO ALUNO — frequência, kit, satisfação e a origem dele
// ---------------------------------------------------------------------
async function acaoFichaAluno(tenant, body, res) {
  const id = body.aluno_id; if (!id) return res.status(400).json({ erro: 'Informe o aluno.' });
  const [al] = await sb(`capta_alunos?id=eq.${id}&tenant_id=eq.${tenant.id}&select=*&limit=1`);
  if (!al) return res.status(404).json({ erro: 'Aluno não encontrado.' });
  const [turmas, presencas, lead, matriculas] = await Promise.all([
    sb(`capta_turmas?tenant_id=eq.${tenant.id}&select=id,nome,dia_semana,hora_inicio,hora_fim`).catch(() => []),
    sb(`capta_presencas?tenant_id=eq.${tenant.id}&aluno_id=eq.${id}&select=data,entrada_em,saida_em,feedback,comentario&order=data.desc&limit=180`).catch(() => []),
    al.lead_id ? sb(`capta_leads?id=eq.${al.lead_id}&select=id,nome,contato,email,fonte,porta,origem,criado_em,kommo_lead_id,evento_id,temperatura`).catch(() => []) : [],
    al.lead_id ? sb(`capta_matriculas?tenant_id=eq.${tenant.id}&lead_id=eq.${al.lead_id}&select=valor_bruto,fechada_em,fechada_por,status&order=fechada_em.desc`).catch(() => []) : []
  ]);
  // aulas previstas desde a matrícula (uma por semana, no dia da turma)
  const turma = (turmas || []).find(t => t.id === al.turma_id);
  const inicio = (matriculas?.[0]?.fechada_em) || String(al.criado_em || '').slice(0, 10);
  let previstas = 0;
  if (turma && inicio) {
    const d = new Date(inicio + 'T12:00:00'), hoje = new Date();
    while (d <= hoje) { if (d.getDay() === turma.dia_semana) previstas++; d.setDate(d.getDate() + 1); }
  }
  const presentes = (presencas || []).filter(p => p.entrada_em).length;
  const notas = (presencas || []).filter(p => p.feedback).map(p => ({ data: p.data, nota: p.feedback, comentario: p.comentario }));
  return res.status(200).json({
    aluno: al, turma: turma || null, presencas: presencas || [], previstas, presentes,
    frequencia: previstas ? Math.round(presentes / previstas * 100) : null,
    notas, lead: lead?.[0] || null, matriculas: matriculas || []
  });
}


// ---------------------------------------------------------------------
// TRANSCRIÇÃO DE ÁUDIO — o áudio do WhatsApp vira texto no chat
// Usa a API da Anthropic (ANTHROPIC_API_KEY). Sem a chave, fica pendente.
// ---------------------------------------------------------------------
// transcreve e grava; devolve o texto (usado pela triagem e pela sugestão de resposta)
async function transcreverAudio(tenant, id) {
  const groq = process.env.GROQ_API_KEY, openai = process.env.OPENAI_API_KEY;
  if (!groq && !openai) return null;
  const [m] = await sb(`capta_mensagens?id=eq.${id}&tenant_id=eq.${tenant.id}&select=id,midia_url,midia_mime,transcricao&limit=1`);
  if (!m || !m.midia_url) return null;
  if (m.transcricao) return m.transcricao;
  const assin = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/capta-midia/${m.midia_url}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 }) }).then(r => r.json());
  const bin = Buffer.from(await (await fetch(`${SUPABASE_URL}/storage/v1${assin.signedURL || assin.signedUrl}`)).arrayBuffer());
  if (!bin.length || bin.length > 24 * 1024 * 1024) return null;
  const mime = m.midia_mime || 'audio/ogg';
  const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : mime.includes('wav') ? 'wav' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([bin], { type: mime }), `audio.${ext}`);
  form.append('model', groq ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe');
  form.append('language', 'pt'); form.append('response_format', 'json');
  const r = await fetch(groq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions',
    { method: 'POST', headers: { Authorization: `Bearer ${groq || openai}` }, body: form });
  const j = await r.json().catch(() => ({}));
  const texto = (j.text || '').trim();
  if (!r.ok || !texto) return null;
  await sb(`capta_mensagens?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ transcricao: texto.slice(0, 4000), transcricao_status: 'pronta' }) }).catch(() => null);
  return texto;
}

async function acaoTranscrever(tenant, body, res) {
  // O Claude não transcreve áudio: isso exige um serviço de fala.
  // Aceitamos Groq (grátis, roda Whisper) ou OpenAI. Basta uma das chaves.
  const groq = process.env.GROQ_API_KEY, openai = process.env.OPENAI_API_KEY;
  const id = body.mensagem_id;
  if (!id) return res.status(400).json({ erro: 'Informe a mensagem.' });
  const [m] = await sb(`capta_mensagens?id=eq.${id}&tenant_id=eq.${tenant.id}&select=id,tipo,midia_url,midia_mime,texto,transcricao,transcricao_status&limit=1`);
  if (!m) return res.status(404).json({ erro: 'Mensagem não encontrada.' });
  if (m.transcricao) return res.status(200).json({ transcricao: m.transcricao, ja: true });
  if (!groq && !openai) return res.status(200).json({ erro: 'Transcrição de áudio ainda não está ativa: falta a chave do serviço de voz (Groq ou OpenAI).' });
  if (!m.midia_url) return res.status(400).json({ erro: 'O áudio não está guardado no Capta.' });

  await sb(`capta_mensagens?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ transcricao_status: 'processando' }) }).catch(() => null);
  try {
    // 1) baixa o áudio do nosso armazenamento
    const assin = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/capta-midia/${m.midia_url}`, {
      method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 300 }) }).then(r => r.json());
    const url = `${SUPABASE_URL}/storage/v1${assin.signedURL || assin.signedUrl}`;
    const bin = Buffer.from(await (await fetch(url)).arrayBuffer());
    if (!bin.length) throw new Error('Áudio vazio.');
    if (bin.length > 24 * 1024 * 1024) throw new Error('Áudio grande demais (máximo 24 MB).');

    // 2) manda para o serviço de voz
    const mime = m.midia_mime || 'audio/ogg';
    const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : mime.includes('wav') ? 'wav' : 'ogg';
    const form = new FormData();
    form.append('file', new Blob([bin], { type: mime }), `audio.${ext}`);
    form.append('model', groq ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe');
    form.append('language', 'pt');
    form.append('response_format', 'json');
    const alvo = groq ? 'https://api.groq.com/openai/v1/audio/transcriptions'
                      : 'https://api.openai.com/v1/audio/transcriptions';
    const r = await fetch(alvo, { method: 'POST', headers: { Authorization: `Bearer ${groq || openai}` }, body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `O serviço de voz recusou (${r.status}).`);
    let texto = (j.text || '').trim();
    if (!texto) throw new Error('Não consegui entender o áudio.');

    // 3) com a chave da Anthropic, dá um trato no texto (pontuação e nomes)
    if (process.env.ANTHROPIC_API_KEY && texto.length > 40) {
      try {
        const rr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000,
            system: 'Você arruma a pontuação de transcrições de áudio de WhatsApp de pais falando com uma escola de robótica infantil em Manaus. Corrija só pontuação, maiúsculas e palavras claramente truncadas. NÃO invente, não resuma, não mude o sentido nem o jeito de falar. Devolva apenas o texto corrigido.',
            messages: [{ role: 'user', content: texto }] }) });
        const jj = await rr.json();
        const limpo = (jj.content || []).filter(x => x.type === 'text').map(x => x.text).join('').trim();
        if (limpo && limpo.length > texto.length * 0.6) texto = limpo;
      } catch (e) { /* se falhar, fica a transcrição crua */ }
    }

    await sb(`capta_mensagens?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ transcricao: texto.slice(0, 4000), transcricao_status: 'pronta' }) });
    return res.status(200).json({ transcricao: texto });
  } catch (e) {
    await sb(`capta_mensagens?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ transcricao_status: 'erro' }) }).catch(() => null);
    await registrarFalha(tenant.id, 'transcricao', e.message).catch(() => null);
    return res.status(200).json({ erro: e.message });
  }
}



// ---------------------------------------------------------------------
// REPOSIÇÃO — aluno que faltou repõe a aula em até 7 dias, no kit dele
// ---------------------------------------------------------------------
async function acaoVagasKit(tenant, body, res) {
  const kit = body.kit || 'First';
  const dias = Math.min(Number(body.dias) || 7, 30);
  const horarios = await rpc('capta_vagas_por_kit', { p_tenant: tenant.id, p_kit: kit, p_dias: dias }).catch(() => []);
  return res.status(200).json({ horarios: horarios || [], kit });
}

// aulas da turma do aluno nos últimos 21 dias em que ele não teve presença
async function acaoFaltasAluno(tenant, body, res) {
  const id = body.aluno_id; if (!id) return res.status(400).json({ erro: 'Informe o aluno.' });
  const [al] = await sb(`capta_alunos?id=eq.${id}&tenant_id=eq.${tenant.id}&select=id,nome,kit,turma_id&limit=1`);
  if (!al) return res.status(404).json({ erro: 'Aluno não encontrado.' });
  const [turma] = al.turma_id ? await sb(`capta_turmas?id=eq.${al.turma_id}&select=dia_semana,hora_inicio,hora_fim,nome&limit=1`) : [];
  const de = new Date(Date.now() - 21 * 864e5 - 4 * 3600e3).toISOString().slice(0, 10);
  const [presencas, reposicoes] = await Promise.all([
    sb(`capta_presencas?tenant_id=eq.${tenant.id}&aluno_id=eq.${id}&data=gte.${de}&select=data,entrada_em`).catch(() => []),
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&aluno_id=eq.${id}&tipo=eq.reposicao&select=id,data,hora_inicio,status,repoe_data&order=data.desc&limit=10`).catch(() => [])
  ]);
  const veio = new Set((presencas || []).filter(p => p.entrada_em).map(p => p.data));
  const reposto = new Set((reposicoes || []).map(r => r.repoe_data).filter(Boolean));
  const faltas = [];
  if (turma) {
    const hoje = hojeManaus();
    for (let d = new Date(de + 'T12:00:00'); d.toISOString().slice(0, 10) <= hoje; d.setDate(d.getDate() + 1)) {
      const dia = d.toISOString().slice(0, 10);
      if (d.getDay() !== turma.dia_semana) continue;
      if (veio.has(dia) || reposto.has(dia)) continue;
      faltas.push({ data: dia, hora_inicio: turma.hora_inicio });
    }
  }
  return res.status(200).json({ aluno: al, turma: turma || null, faltas: faltas.reverse(), reposicoes: reposicoes || [] });
}

// NOTAS — cada anotação é uma linha com autor e data, em vez de um campo
// único que a próxima pessoa sobrescreve. Vai também para o card do Kommo,
// já que os dois sistemas rodam em paralelo.
// Lead que veio direto: apareceu na escola ou ligou, sem ter passado pelo
// site nem pelo WhatsApp. Reaproveita o cadastro se o telefone já existir,
// para não criar o mesmo lead duas vezes.
// =====================================================================
// LGPD
// Três coisas que a lei pede e que agora vivem no painel: registro de quem
// acessou os dados (art. 37), pedidos do titular com prazo de 15 dias
// (art. 18) e expurgo do que não precisa mais ser guardado (art. 15/16).
// =====================================================================

// =====================================================================
// METAS — o quadro da parede virando painel.
// O Capta mede sozinho o que passa por ele (matrículas, leads, mensagens,
// ligações, aulas marcadas e "falar efetivamente"). Avaliações no Google e
// eventos ninguém consegue medir por API: esses são lançados à mão.
// =====================================================================
const PRAZO_TEMP = { quente: 120, morno: 480, frio: 1440 };   // minutos, igual ao alerta da inbox

async function acaoMetas(tenant, body, res) {
  if (body.salvar) {
    const m = body.salvar;
    await sb(`capta_metas?tenant_id=eq.${tenant.id}&chave=eq.${encodeURIComponent(m.chave)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ dia: m.dia ?? null, semana: m.semana ?? null, mes: m.mes ?? null })
    });
  }
  if (body.lancar) {
    const l = body.lancar;
    const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
    await sb('capta_metas_lancamentos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      tenant_id: tenant.id, chave: l.chave, valor: Number(l.valor) || 1,
      data: l.data || hojeManaus(), por_nome: quem?.nome || body.por_nome || null
    }) });
  }

  const hoje = hojeManaus();
  const base = new Date(hoje + 'T12:00:00Z');
  const diaSemana = base.getUTCDay();                       // 0 domingo
  const seg = new Date(base.getTime() - ((diaSemana + 6) % 7) * 864e5).toISOString().slice(0, 10);
  const mes1 = hoje.slice(0, 8) + '01';

  const metas = await sb(`capta_metas?tenant_id=eq.${tenant.id}&select=*&order=ordem`).catch(() => []);

  // tudo em uma passada, com os períodos que interessam
  const [leads, ags, msgs, ligs, lanc] = await Promise.all([
    sb(`capta_leads?tenant_id=eq.${tenant.id}&criado_em=gte.${mes1}T00:00:00&select=id,criado_em,etapa_id,temperatura`).catch(() => []),
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&criado_em=gte.${mes1}T00:00:00&select=id,criado_em,status,observacao`).catch(() => []),
    sb(`capta_mensagens?tenant_id=eq.${tenant.id}&direcao=eq.saida&criado_em=gte.${mes1}T00:00:00&select=id,criado_em,conversa_id`).catch(() => []),
    sb(`capta_ligacoes?tenant_id=eq.${tenant.id}&criado_em=gte.${mes1}T00:00:00&select=id,criado_em`).catch(() => []),
    sb(`capta_metas_lancamentos?tenant_id=eq.${tenant.id}&data=gte.${mes1}&select=chave,data,valor`).catch(() => [])
  ]);

  // matrículas: agendamento com desfecho "matriculou"
  const matric = (ags || []).filter(a => /desfecho:\s*matriculou/i.test(a.observacao || ''));

  // "falar efetivamente": conversa em que o lead esperava e alguém respondeu
  // dentro do prazo da temperatura dele. Vem das respostas do período.
  const falar = await contarFalarEfetivo(tenant.id, mes1);

  const noPeriodo = (lista, campo, desde) => (lista || []).filter(x => String(x[campo] || '').slice(0, 10) >= desde).length;
  const feito = {
    matriculas: [ noPeriodo(matric, 'criado_em', hoje), noPeriodo(matric, 'criado_em', seg), matric.length ],
    leads:      [ noPeriodo(leads, 'criado_em', hoje), noPeriodo(leads, 'criado_em', seg), (leads||[]).length ],
    mensagens:  [ noPeriodo(msgs, 'criado_em', hoje), noPeriodo(msgs, 'criado_em', seg), (msgs||[]).length ],
    ligacoes:   [ noPeriodo(ligs, 'criado_em', hoje), noPeriodo(ligs, 'criado_em', seg), (ligs||[]).length ],
    aulas:      [ noPeriodo(ags, 'criado_em', hoje), noPeriodo(ags, 'criado_em', seg), (ags||[]).length ],
    falar:      [ falar.hoje, falar.semana, falar.mes ]
  };
  for (const ch of ['avaliacoes', 'eventos']) {
    const l = (lanc || []).filter(x => x.chave === ch);
    const soma = arr => arr.reduce((t, x) => t + Number(x.valor || 0), 0);
    feito[ch] = [ soma(l.filter(x => x.data === hoje)), soma(l.filter(x => x.data >= seg)), soma(l) ];
  }

  return res.status(200).json({ metas: metas || [], feito, desde: { hoje, semana: seg, mes: mes1 } });
}

// Conta as respostas que saíram dentro do prazo da temperatura do lead.
// Uma conversa conta uma vez por dia — o que se mede é atendimento feito,
// não mensagem enviada (isso já é outro indicador).
async function contarFalarEfetivo(tenantId, desde) {
  const msgs = await sb(`capta_mensagens?tenant_id=eq.${tenantId}&criado_em=gte.${desde}T00:00:00` +
    `&select=conversa_id,direcao,criado_em&order=conversa_id,criado_em&limit=4000`).catch(() => []);
  if (!msgs?.length) return { hoje: 0, semana: 0, mes: 0 };
  const convIds = [...new Set(msgs.map(m => m.conversa_id))].slice(0, 300);
  const convs = convIds.length
    ? await sb(`capta_conversas?id=in.(${convIds.join(',')})&select=id,lead:lead_id(temperatura)`).catch(() => [])
    : [];
  const temp = {}; (convs || []).forEach(c => temp[c.id] = String(c.lead?.temperatura || '').toLowerCase());

  const porConversa = {};
  for (const m of msgs) (porConversa[m.conversa_id] = porConversa[m.conversa_id] || []).push(m);

  const dias = new Set();   // "conversa|dia" que contou
  for (const [cid, lista] of Object.entries(porConversa)) {
    const prazo = PRAZO_TEMP[temp[cid]] || 240;
    let esperandoDesde = null;
    for (const m of lista) {
      if (m.direcao === 'entrada') { if (!esperandoDesde) esperandoDesde = new Date(m.criado_em); continue; }
      if (esperandoDesde) {
        const min = (new Date(m.criado_em) - esperandoDesde) / 60000;
        if (min <= prazo) dias.add(`${cid}|${String(m.criado_em).slice(0, 10)}`);
        esperandoDesde = null;
      }
    }
  }
  const hoje = hojeManaus();
  const base = new Date(hoje + 'T12:00:00Z');
  const seg = new Date(base.getTime() - ((base.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
  const lista = [...dias].map(x => x.split('|')[1]);
  return {
    hoje: lista.filter(d => d === hoje).length,
    semana: lista.filter(d => d >= seg).length,
    mes: lista.length
  };
}

// =====================================================================
// CASAR CONVERSAS @lid COM OS LEADS
// O WhatsApp vem escondendo o número: em vez do telefone, manda um @lid.
// A conversa nasce sem dono e a pessoa some do Pipeline e da agenda — em
// 19/set/2026 eram 248 de 297 conversas assim.
// A Z-API não converte @lid em telefone (o WhatsApp não deixa), mas faz o
// caminho inverso: dado um telefone, ela diz qual é o @lid. Então perguntamos
// o @lid de cada lead que já temos e ligamos as conversas por ele.
// Roda em lotes: GET não serve, a chamada é por ação, com &lote=.
// =====================================================================
// conta linhas sem trazer tudo
async function sbCount(path) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: 'count=exact' } });
    return Number(r.headers.get('content-range')?.split('/')?.[1] || 0);
  } catch (e) { return null; }
}

// Dispara a rodada de lembretes na hora, sem esperar o cron. Serve para
// testar o texto e para o dia em que o cron falhar.
async function acaoLembretesAgora(tenant, body, res) {
  const [canal] = await sb(`capta_canais?tenant_id=eq.${tenant.id}&tipo=eq.whatsapp&status=eq.conectado&select=*&limit=1`).catch(() => []);
  if (!canal) return res.status(400).json({ erro: 'WhatsApp não está conectado.' });
  const r = { enviados: 0, falhas: 0 };
  await lembretes(canal, r, body.turno === 'tarde' ? 'tarde' : 'manha');
  return res.status(200).json({ ok: true, ...r });
}

// Registro de acesso. Chamado pelas telas ao abrir e nas ações sensíveis.
// Não bloqueia nada: se falhar, a pessoa continua trabalhando.
async function acaoAcesso(tenant, body, res) {
  const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
  await sb('capta_acessos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id,
    usuario_nome: quem?.nome || body.por_nome || null,
    usuario_email: quem?.email || body.email_atual || null,
    tela: body.tela || null, acao: body.o || 'abriu',
    alvo_tipo: body.alvo_tipo || null, alvo_id: body.alvo_id || null,
    ip: (body._ip || '').slice(0, 45) || null
  }) }).catch(() => null);
  return res.status(200).json({ ok: true });
}

// O que o painel mostra em Ajustes → LGPD: últimos acessos, pedidos abertos
// e quantos leads já podem ser expurgados.
async function acaoLgpd(tenant, body, res) {
  const [t] = await sb(`capta_tenants?id=eq.${tenant.id}&select=retencao_meses&limit=1`);
  const meses = t?.retencao_meses || null;
  const [acessos, pedidos, consent] = await Promise.all([
    sb(`capta_acessos?tenant_id=eq.${tenant.id}&select=usuario_nome,usuario_email,tela,acao,criado_em&order=criado_em.desc&limit=80`).catch(() => []),
    sb(`capta_pedidos_titular?tenant_id=eq.${tenant.id}&select=*&order=status.asc,prazo.asc&limit=60`).catch(() => []),
    sb(`capta_consentimentos?tenant_id=eq.${tenant.id}&select=id&limit=1`).catch(() => [])
  ]);
  let candidatos = [];
  if (meses) {
    const corte = new Date(Date.now() - meses * 30 * 864e5).toISOString();
    candidatos = await sb(`capta_expurgo_candidatos?tenant_id=eq.${tenant.id}&ultimo_toque=lt.${corte}&select=lead_id,nome,contato,ultimo_toque&order=ultimo_toque&limit=500`).catch(() => []);
  }
  return res.status(200).json({
    retencao_meses: meses, acessos: acessos || [], pedidos: pedidos || [],
    candidatos: candidatos || [], tem_consentimento: !!(consent || []).length
  });
}

async function acaoLgpdConfig(tenant, body, res) {
  const m = body.retencao_meses === '' || body.retencao_meses == null ? null : Number(body.retencao_meses);
  if (m != null && (!Number.isFinite(m) || m < 1 || m > 120)) return res.status(400).json({ erro: 'Use um prazo entre 1 e 120 meses.' });
  await sb(`capta_tenants?id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ retencao_meses: m }) });
  return await acaoLgpd(tenant, body, res);
}

// Expurgo: anonimiza os leads que passaram do prazo. Não apaga a linha —
// tira o que identifica a pessoa e mantém origem, etapa e datas, senão o
// histórico do negócio some junto.
async function acaoExpurgar(tenant, body, res) {
  const ids = Array.isArray(body.lead_ids) ? body.lead_ids.slice(0, 200) : null;
  let alvos = ids;
  if (!alvos) {
    const [t] = await sb(`capta_tenants?id=eq.${tenant.id}&select=retencao_meses&limit=1`);
    if (!t?.retencao_meses) return res.status(400).json({ erro: 'Defina o prazo de retenção antes de expurgar.' });
    const corte = new Date(Date.now() - t.retencao_meses * 30 * 864e5).toISOString();
    const c = await sb(`capta_expurgo_candidatos?tenant_id=eq.${tenant.id}&ultimo_toque=lt.${corte}&select=lead_id&limit=200`).catch(() => []);
    alvos = (c || []).map(x => x.lead_id);
  }
  if (!alvos.length) return res.status(200).json({ ok: true, apagados: 0 });
  let n = 0;
  for (const id of alvos) {
    try { await rpc('capta_anonimizar_lead', { p_lead: id }); n++; }
    catch (e) { console.error('[expurgo]', id, e.message); }
  }
  const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
  await sb('capta_acessos', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id, usuario_nome: quem?.nome || null, usuario_email: quem?.email || body.email_atual || null,
    tela: 'lgpd', acao: `expurgou ${n} leads`
  }) }).catch(() => null);
  return res.status(200).json({ ok: true, apagados: n });
}

// Pedido do titular: abrir, atualizar e concluir. Exclusão concluída
// dispara a anonimização do lead.
async function acaoPedidoTitular(tenant, body, res) {
  if (body.abrir) {
    const p = body.abrir;
    if (!p.nome || !p.tipo) return res.status(400).json({ erro: 'Informe o nome e o tipo do pedido.' });
    const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
    await sb('capta_pedidos_titular', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      tenant_id: tenant.id, lead_id: p.lead_id || null, aluno_id: p.aluno_id || null,
      nome: p.nome, contato: p.contato || null, email: p.email || null,
      tipo: p.tipo, detalhe: p.detalhe || null, aberto_por: quem?.nome || body.por_nome || null
    }) });
  }
  if (body.atualizar) {
    const u = body.atualizar;
    const campos = {};
    if (u.status) campos.status = u.status;
    if (u.resposta !== undefined) campos.resposta = u.resposta || null;
    if (u.status === 'concluido') campos.concluido_em = new Date().toISOString();
    await sb(`capta_pedidos_titular?id=eq.${u.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos) });
    // exclusão concluída = apagar de verdade os dados do titular
    if (u.status === 'concluido' && u.anonimizar && u.lead_id) {
      try { await rpc('capta_anonimizar_lead', { p_lead: u.lead_id }); } catch (e) { console.error('[titular]', e.message); }
    }
  }
  return await acaoLgpd(tenant, body, res);
}

async function acaoLeadNovo(tenant, body, res) {
  const nome = String(body.nome || '').trim();
  const fone = String(body.contato || '').replace(/\D/g, '');
  if (!nome || fone.length < 10) return res.status(400).json({ erro: 'Informe o nome e o WhatsApp.' });
  const comDDI = fone.startsWith('55') ? fone : `55${fone}`;
  const [ja] = await sb(`capta_leads?tenant_id=eq.${tenant.id}&or=(contato.eq.${fone},contato.eq.${comDDI})&select=id&limit=1`).catch(() => []);
  if (ja) return res.status(200).json({ lead_id: ja.id, ja_existia: true });

  const etapaId = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Novo%20lead&select=id&limit=1`).catch(() => []))?.[0]?.id || null;
  const criado = await sb('capta_leads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
    tenant_id: tenant.id, nome, contato: comDDI,
    crianca: body.crianca || null, idade: body.idade ? Number(body.idade) : null,
    origem: 'my robot', fonte: 'direto', porta: 'my robot',
    temperatura: 'Quente', status: 'contatado', etapa_id: etapaId,
    atendente: body.por_nome || null,
    notas: 'Procurou a escola direto (cadastrado no agendamento)'
  }) });
  const leadId = criado?.[0]?.id;
  if (!leadId) return res.status(500).json({ erro: 'Não consegui criar o lead.' });
  return res.status(200).json({ lead_id: leadId, ja_existia: false });
}

async function acaoNota(tenant, body, res) {
  const texto = String(body.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Escreva a nota.' });
  if (!body.lead_id && !body.aluno_id) return res.status(400).json({ erro: 'Informe o lead ou o aluno.' });
  if (body.apagar) {
    await sb(`capta_notas?id=eq.${body.apagar}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return res.status(200).json({ ok: true });
  }
  const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
  const autor = quem?.nome || body.por_nome || 'alguém do painel';
  await sb('capta_notas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id, lead_id: body.lead_id || null, aluno_id: body.aluno_id || null,
    texto: texto.slice(0, 4000), autor_nome: autor, autor_email: quem?.email || body.email_atual || null
  }) });
  // espelha no Kommo, para quem trabalha por lá
  if (body.lead_id) {
    const [l] = await sb(`capta_leads?id=eq.${body.lead_id}&tenant_id=eq.${tenant.id}&select=kommo_lead_id&limit=1`).catch(() => []);
    if (l?.kommo_lead_id) notaKommoTexto(tenant.id, l.kommo_lead_id, `Capta · ${autor}: ${texto.slice(0, 600)}`).catch(() => null);
  }
  return res.status(200).json({ ok: true, autor });
}

async function acaoNotas(tenant, body, res) {
  const filtro = body.lead_id ? `lead_id=eq.${body.lead_id}` : body.aluno_id ? `aluno_id=eq.${body.aluno_id}` : null;
  if (!filtro) return res.status(400).json({ erro: 'Informe o lead ou o aluno.' });
  const linhas = await sb(`capta_notas?tenant_id=eq.${tenant.id}&${filtro}&select=id,texto,autor_nome,criado_em&order=criado_em.desc&limit=50`).catch(() => []);
  return res.status(200).json({ notas: linhas || [] });
}

// MUDANÇA DEFINITIVA DE TURMA — diferente da reposição, que é só uma aula
// em outro dia. Aqui o aluno troca o dia/horário fixo dele. Antes de
// confirmar com a família é preciso saber se cabe: a resposta vem de
// 'turmas_vagas', que mostra sala e kit de cada turma.
async function acaoTurmasVagas(tenant, body, res) {
  const kit = body.kit || null;
  const [turmas, alunos, kits] = await Promise.all([
    sb(`capta_turmas?tenant_id=eq.${tenant.id}&select=id,nome,dia_semana,hora_inicio,hora_fim,capacidade,limite_sala,ativa&order=dia_semana,hora_inicio`).catch(() => []),
    sb(`capta_alunos?tenant_id=eq.${tenant.id}&status=eq.ativo&select=id,turma_id,kit`).catch(() => []),
    sb(`capta_kits?tenant_id=eq.${tenant.id}&select=kit,capacidade`).catch(() => [])
  ]);
  const capKit = {}; (kits || []).forEach(k => capKit[k.kit] = k.capacidade);
  const lista = (turmas || []).filter(t => t.ativa !== false).map(t => {
    const naTurma = (alunos || []).filter(a => a.turma_id === t.id);
    const sala = t.limite_sala || t.capacidade || 18;
    const doKit = kit ? naTurma.filter(a => a.kit === kit).length : null;
    const capacidadeKit = kit ? (capKit[kit] ?? null) : null;
    return {
      id: t.id, nome: t.nome, dia_semana: t.dia_semana,
      hora_inicio: t.hora_inicio, hora_fim: t.hora_fim,
      na_sala: naTurma.length, limite_sala: sala,
      sala_livre: Math.max(0, sala - naTurma.length),
      kit, do_kit: doKit, capacidade_kit: capacidadeKit,
      kit_livre: capacidadeKit == null ? null : Math.max(0, capacidadeKit - doKit)
    };
  });
  return res.status(200).json({ turmas: lista });
}

// Move o aluno de turma de vez, checando vaga de sala e de kit.
async function acaoTransferirAluno(tenant, body, res) {
  const { aluno_id, turma_id } = body;
  if (!aluno_id || !turma_id) return res.status(400).json({ erro: 'Informe o aluno e a turma.' });
  const [al] = await sb(`capta_alunos?id=eq.${aluno_id}&tenant_id=eq.${tenant.id}&select=id,nome,nome_curto,kit,turma_id,observacao&limit=1`);
  if (!al) return res.status(404).json({ erro: 'Aluno não encontrado.' });
  if (al.turma_id === turma_id) return res.status(400).json({ erro: 'O aluno já está nessa turma.' });
  const [t] = await sb(`capta_turmas?id=eq.${turma_id}&tenant_id=eq.${tenant.id}&select=id,nome,dia_semana,hora_inicio,capacidade,limite_sala&limit=1`);
  if (!t) return res.status(404).json({ erro: 'Turma não encontrada.' });

  const naTurma = await sb(`capta_alunos?tenant_id=eq.${tenant.id}&turma_id=eq.${turma_id}&status=eq.ativo&select=id,kit`).catch(() => []);
  const sala = t.limite_sala || t.capacidade || 18;
  if ((naTurma || []).length >= sala && !body.forcar) return res.status(409).json({ erro: `Essa turma já está com ${sala} de ${sala} lugares na sala.`, cheio: 'sala' });
  if (al.kit) {
    const [k] = await sb(`capta_kits?tenant_id=eq.${tenant.id}&kit=eq.${encodeURIComponent(al.kit)}&select=capacidade&limit=1`).catch(() => []);
    const cap = k?.capacidade;
    const usados = (naTurma || []).filter(a => a.kit === al.kit).length;
    if (cap != null && usados >= cap && !body.forcar) return res.status(409).json({ erro: `Não há kit ${al.kit} livre nesse horário (${usados} de ${cap} em uso).`, cheio: 'kit' });
  }

  const hoje = hojeManaus();
  const antiga = al.turma_id ? (await sb(`capta_turmas?id=eq.${al.turma_id}&select=nome,dia_semana,hora_inicio&limit=1`).catch(() => []))?.[0] : null;
  const DIAS_T = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  const descr = x => x ? `${DIAS_T[x.dia_semana] || ''} ${String(x.hora_inicio || '').slice(0, 5)}` : 'sem turma';
  const nota = `Mudou de turma em ${hoje.split('-').reverse().join('/')}: ${descr(antiga)} → ${descr(t)}${body.por_nome ? ` (${body.por_nome})` : ''}`;

  await sb(`capta_alunos?id=eq.${aluno_id}&tenant_id=eq.${tenant.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ turma_id, atualizado_em: new Date().toISOString(),
      observacao: al.observacao ? `${al.observacao} · ${nota}` : nota })
  });

  // As reposições já marcadas continuam valendo; aulas futuras da turma antiga
  // não existem como registro (a turma é fixa), então não há o que remarcar.
  return res.status(200).json({ ok: true, de: descr(antiga), para: descr(t) });
}

// O pedagógico confirma o aluno na grade: turma e kit definitivos.
// Enquanto não confirma, ele aparece na fila de entrada da tela de Alunos.
async function acaoAlunoConfirmar(tenant, body, res) {
  const { aluno_id, turma_id, kit, nome } = body;
  if (!aluno_id) return res.status(400).json({ erro: 'Informe o aluno.' });
  const email = String(body.email || '').trim().toLowerCase();
  if (email && !email.includes('@')) return res.status(400).json({ erro: 'E-mail inválido.' });
  const campos = { confirmado_em: new Date().toISOString(), confirmado_por: body.por_nome || null };
  if (turma_id) campos.turma_id = turma_id;
  if (kit) campos.kit = kit;
  if (nome) campos.nome = nome;
  if (email) campos.email_responsavel = email;
  await sb(`capta_alunos?id=eq.${aluno_id}&tenant_id=eq.${tenant.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(campos)
  });
  // guarda também no lead, para não perder o e-mail se o aluno for recriado
  if (email) {
    const [al] = await sb(`capta_alunos?id=eq.${aluno_id}&select=lead_id&limit=1`).catch(() => []);
    if (al?.lead_id) await sb(`capta_leads?id=eq.${al.lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ email }) }).catch(() => null);
  }
  let boasVindas = null;
  if (body.enviar_boas_vindas) boasVindas = await enviarBoasVindas(tenant, aluno_id).catch(e => ({ erro: e.message }));
  return res.status(200).json({ ok: true, boas_vindas: boasVindas });
}

// Boas-vindas por e-mail para a família, quando o aluno entra na grade.
// Sai pelo Resend (mesmo serviço do login). Manda uma vez só: se já foi,
// devolve 'ja_enviado' em vez de repetir.
async function enviarBoasVindas(tenant, alunoId) {
  const chave = process.env.RESEND_API_KEY;
  if (!chave) return { erro: 'RESEND_API_KEY não configurada.' };
  const [al] = await sb(`capta_alunos?id=eq.${alunoId}&tenant_id=eq.${tenant.id}&select=id,nome,nome_curto,kit,turma_id,email_responsavel,boas_vindas_em,lead_id&limit=1`);
  if (!al) return { erro: 'Aluno não encontrado.' };
  if (al.boas_vindas_em) return { ja_enviado: true };
  let para = al.email_responsavel;
  if (!para && al.lead_id) para = (await sb(`capta_leads?id=eq.${al.lead_id}&select=email&limit=1`).catch(() => []))?.[0]?.email;
  if (!para) return { erro: 'Sem e-mail do responsável.' };

  const [turma] = al.turma_id ? await sb(`capta_turmas?id=eq.${al.turma_id}&select=nome,dia_semana,hora_inicio,hora_fim&limit=1`).catch(() => []) : [];
  const [resp] = al.lead_id ? await sb(`capta_leads?id=eq.${al.lead_id}&select=nome&limit=1`).catch(() => []) : [];
  const DIAS_E = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  const quando = turma ? `${DIAS_E[turma.dia_semana] || ''}, das ${String(turma.hora_inicio).slice(0, 5)} às ${String(turma.hora_fim).slice(0, 5)}` : 'a combinar';
  const primeiro = String(al.nome_curto || al.nome || '').trim().split(' ')[0];
  const escola = tenant.nome || 'a escola';
  // Remetente: o da própria escola (Ajustes) na frente do global, porque o
  // e-mail vai para a família — tem que chegar com o nome de quem ela conhece.
  const de = tenant.email_remetente || process.env.CAPTA_FROM_EMAIL || 'Capta <onboarding@resend.dev>';

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;color:#141A2E;line-height:1.6">
    <h2 style="margin:0 0 6px">Bem-vindo à ${escola}, ${primeiro}! 🤖</h2>
    <p style="margin:12px 0">${resp?.nome ? `Oi, ${String(resp.nome).split(' ')[0]}! ` : ''}A matrícula ${primeiro ? 'do ' + primeiro : ''} está confirmada. Já separamos o lugar dele na turma:</p>
    <table style="border-collapse:collapse;margin:14px 0;font-size:15px">
      <tr><td style="padding:5px 14px 5px 0;color:#697089">Aluno</td><td style="padding:5px 0"><b>${al.nome || ''}</b></td></tr>
      <tr><td style="padding:5px 14px 5px 0;color:#697089">Turma</td><td style="padding:5px 0"><b>${quando}</b></td></tr>
      ${al.kit ? `<tr><td style="padding:5px 14px 5px 0;color:#697089">Kit</td><td style="padding:5px 0"><b>${al.kit}</b></td></tr>` : ''}
    </table>
    <p style="margin:12px 0">No primeiro dia, chegue uns 10 minutinhos antes. Não precisa levar material: o kit fica aqui com a gente.</p>
    <p style="margin:12px 0">Qualquer dúvida, responda este e-mail ou fale com a gente no WhatsApp.</p>
    <p style="margin:18px 0 0;color:#697089;font-size:13px">Até logo!<br>Equipe ${escola}</p>
  </div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: de, to: para, subject: `Matrícula confirmada${primeiro ? ' — ' + primeiro : ''} · ${escola}`, html })
  });
  if (!r.ok) return { erro: 'Resend: ' + (await r.text()).slice(0, 160) };
  await sb(`capta_alunos?id=eq.${alunoId}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ boas_vindas_em: new Date().toISOString() }) }).catch(() => null);
  return { ok: true, para };
}

async function acaoRepor(tenant, body, res) {
  const { aluno_id, turma_id, data, repoe_data } = body;
  if (!aluno_id || !turma_id || !data) return res.status(400).json({ erro: 'Dados incompletos.' });
  const [al] = await sb(`capta_alunos?id=eq.${aluno_id}&tenant_id=eq.${tenant.id}&select=id,nome,nome_curto,kit&limit=1`);
  if (!al) return res.status(404).json({ erro: 'Aluno não encontrado.' });
  const [t] = await sb(`capta_turmas?id=eq.${turma_id}&select=hora_inicio,hora_fim&limit=1`);
  if (!t) return res.status(404).json({ erro: 'Turma não encontrada.' });
  // Prazo: 7 dias é o padrão da recepção. Quem cuida do pedagógico (gestor e
  // secretaria) pode marcar fora disso — reposição de quem ficou doente duas
  // semanas não cabe em 7 dias. Até 120 dias, para não marcar em 2030 por engano.
  const semLimite = ['gestor', 'secretaria'].includes(body._papel);
  const limite = new Date(Date.now() + (semLimite ? 120 : 7) * 864e5 - 4 * 3600e3).toISOString().slice(0, 10);
  if (data > limite) return res.status(400).json({ erro: semLimite ? 'Escolha uma data nos próximos 120 dias.' : 'A reposição precisa ser em até 7 dias.' });
  // Duas aulas no mesmo dia: bloqueado para a recepção, permitido no pedagógico
  // (aluno que faltou muito às vezes repõe duas no mesmo dia, em horários diferentes).
  const ja = await sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&aluno_id=eq.${aluno_id}&data=eq.${data}&select=id,hora_inicio&limit=5`).catch(() => []);
  if (ja?.length && !semLimite) return res.status(409).json({ erro: 'Este aluno já tem aula marcada nesse dia.' });
  if (ja?.length && ja.some(x => String(x.hora_inicio || '').slice(0, 5) === String(t.hora_inicio || '').slice(0, 5)))
    return res.status(409).json({ erro: 'Já existe reposição desse aluno nesse mesmo horário.' });
  const novo = await sb('capta_agendamentos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
    tenant_id: tenant.id, tipo: 'reposicao', aluno_id, turma_id, data,
    hora_inicio: t.hora_inicio, hora_fim: t.hora_fim,
    crianca_nome: al.nome_curto || al.nome, status: 'agendado',
    repoe_data: repoe_data || null,
    observacao: `reposição${repoe_data ? ' da aula de ' + repoe_data.split('-').reverse().join('/') : ''} · kit ${al.kit || ''}`,
    criado_por: body.atendente || 'painel' }) });
  return res.status(200).json({ ok: true, agendamento: novo?.[0] || null });
}


// ---------------------------------------------------------------------
// SUGESTÃO DE RESPOSTA — a IA lê a conversa e propõe o que dizer agora
// ---------------------------------------------------------------------
async function acaoSugerir(tenant, body, res) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return res.status(200).json({ erro: 'Sugestão de resposta ainda não está ativa nesta conta.' });
  const convId = body.conversa_id, leadId = body.lead_id;
  if (!convId && !leadId) return res.status(400).json({ erro: 'Informe a conversa.' });

  // 1) conversa, lead e etapa
  const conv = convId
    ? (await sb(`capta_conversas?id=eq.${convId}&tenant_id=eq.${tenant.id}&select=id,lead_id&limit=1`))?.[0]
    : (await sb(`capta_conversas?lead_id=eq.${leadId}&tenant_id=eq.${tenant.id}&select=id,lead_id&limit=1`))?.[0];
  const idLead = conv?.lead_id || leadId;
  const [lead] = idLead ? await sb(`capta_leads?id=eq.${idLead}&select=nome,contato,temperatura,crianca,idade,fonte,porta,etapa_id,notas,data_aula&limit=1`) : [];
  const [etapa] = lead?.etapa_id ? await sb(`capta_etapas?id=eq.${lead.etapa_id}&select=nome&limit=1`) : [];
  const msgs = conv ? await sb(`capta_mensagens?conversa_id=eq.${conv.id}&select=id,direcao,autor,texto,transcricao,tipo,criado_em,midia_url&order=criado_em.desc&limit=25`).catch(() => []) : [];
  for (const m of (msgs || []).filter(x => x.tipo === 'audio' && !x.transcricao && x.midia_url).slice(0, 3)) { const t = await transcreverAudio(tenant, m.id).catch(() => null); if (t) m.transcricao = t; }
  const historico = (msgs || []).reverse()
    .map(m => `${m.direcao === 'entrada' ? 'CLIENTE' : 'ESCOLA'}: ${(m.texto || m.transcricao || '[' + (m.tipo || 'mídia') + ']').slice(0, 400)}`)
    .join('\n') || '(ainda sem mensagens)';

  // 2) vagas reais para oferecer
  const horarios = await rpc('capta_vagas_experimental', { p_tenant: tenant.id, p_dias: 10 }).catch(() => []);
  const livres = (horarios || []).filter(h => (h.vagas ?? 0) > 0).slice(0, 6)
    .map(h => `${['domingo','segunda','terça','quarta','quinta','sexta','sábado'][new Date(h.data + 'T12:00:00').getDay()]} ${h.data.split('-').reverse().slice(0,2).join('/')} às ${String(h.hora_inicio).slice(0,5)}`);

  // 3) respostas prontas da escola, pra manter o tom
  const prontas = await sb(`capta_respostas?tenant_id=eq.${tenant.id}&select=titulo,texto&limit=8`).catch(() => []);

  const contexto = [
    `Etapa atual: ${etapa?.nome || 'não definida'}`,
    lead?.temperatura ? `Temperatura: ${lead.temperatura}` : null,
    lead?.crianca ? `Criança: ${lead.crianca}${lead.idade ? ', ' + lead.idade + ' anos' : ''}` : 'Criança: ainda não sabemos nome e idade',
    lead?.data_aula ? `Já tem aula marcada para ${new Date(lead.data_aula).toLocaleString('pt-BR')}` : 'Sem aula marcada',
    lead?.notas ? `Anotações: ${lead.notas}` : null,
    livres.length ? `Vagas reais para aula experimental: ${livres.join(' · ')}` : 'Sem vaga nos próximos dias',
  ].filter(Boolean).join('\n');

  const sistema = `Você ajuda a recepção da My Robot Manaus, escola de robótica para crianças em Manaus, a responder pais no WhatsApp.
Objetivo da conversa: entender a criança (nome e idade), despertar interesse e marcar a AULA EXPERIMENTAL exclusiva de 1 hora (nunca chame de gratuita ou sem custo). O valor da mensalidade só é apresentado pessoalmente, depois da aula.
Regras: escreva como uma pessoa de Manaus escreve no WhatsApp — curto, caloroso, no máximo 3 linhas, no máximo 1 emoji, sem formalidade de e-mail, sem "prezado". Nunca invente preço, endereço, horário ou vaga: use apenas os horários listados no contexto. Ofereça no máximo duas opções de horário. Se ainda não souber nome e idade da criança, pergunte isso antes de oferecer horário.
Devolva SOMENTE um JSON no formato {"sugestoes":[{"titulo":"...","texto":"..."}]} com 3 opções de resposta diferentes entre si (por exemplo: uma direta, uma que pergunta algo, uma que contorna objeção). O "titulo" tem no máximo 4 palavras.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 900, system: sistema,
        messages: [{ role: 'user', content:
          `CONTEXTO DO LEAD\n${contexto}\n\n` +
          (prontas?.length ? `TOM DA ESCOLA (respostas que ela já usa)\n${prontas.map(p => '- ' + p.texto).join('\n')}\n\n` : '') +
          `CONVERSA (mais antiga primeiro)\n${historico}\n\nO que a escola deve responder agora?` }]
      })
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'A IA recusou o pedido.');
    const txt = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('').trim();
    let sug = [];
    try { sug = JSON.parse(txt.replace(/```json|```/g, '').trim()).sugestoes || []; }
    catch { sug = [{ titulo: 'Sugestão', texto: txt.slice(0, 600) }]; }
    return res.status(200).json({ sugestoes: sug.slice(0, 3), vagas: livres });
  } catch (e) {
    await registrarFalha(tenant.id, 'sugestao', e.message).catch(() => null);
    return res.status(200).json({ erro: e.message });
  }
}


// ---------------------------------------------------------------------
// TRIAGEM — a IA lê a conversa e PROPÕE a etapa. Quem decide é a pessoa.
// Qualificado e Aula agendada disparam evento de conversão na Meta (webhook
// do Kommo), por isso são marcados como "um de cada vez".
// ---------------------------------------------------------------------
const ETAPAS_META = ['qualificado', 'aula agendada'];   // não mover em lote

async function acaoTriagem(tenant, body, res) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return res.status(200).json({ erro: 'Triagem ainda não está ativa nesta conta.' });
  const limite = Math.min(Number(body.limite) || 8, 15);

  const etapas = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&select=id,nome,tipo&order=ordem.asc`);
  // conversas com mensagem do cliente, do lead mais parado para o mais recente
  const convs = await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=not.is.null&select=id,lead_id,ultima_mensagem_em&order=ultima_mensagem_em.desc&limit=120`);
  const vistos = new Set(); const alvo = [];
  for (const c of convs || []) {
    if (vistos.has(c.lead_id)) continue; vistos.add(c.lead_id);
    alvo.push(c); if (alvo.length >= limite * 3) break;
  }
  const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&id=in.(${alvo.map(c => c.lead_id).join(',')})&select=id,nome,contato,temperatura,crianca,idade,etapa_id,etapa_em,notas,data_aula`);
  const porId = Object.fromEntries((leads || []).map(l => [l.id, l]));

  const saida = [];
  for (const c of alvo) {
    if (saida.length >= limite) break;
    const lead = porId[c.lead_id]; if (!lead) continue;
    const etapaAtual = (etapas || []).find(e => e.id === lead.etapa_id);
    // não mexe em quem já é aluno ou já foi perdido de propósito
    if (etapaAtual && ['ganha', 'perdida'].includes(etapaAtual.tipo)) continue;

    let msgs = await sb(`capta_mensagens?conversa_id=eq.${c.id}&select=id,direcao,autor,texto,transcricao,tipo,criado_em,midia_url&order=criado_em.desc&limit=30`).catch(() => []);
    // áudio sem transcrição: transcreve antes, senão a IA lê "[audio]" e erra
    const pend = (msgs || []).filter(m => m.tipo === 'audio' && !m.transcricao && m.midia_url).slice(0, 4);
    for (const m of pend) { const t = await transcreverAudio(tenant, m.id).catch(() => null); if (t) m.transcricao = t; }
    const hist = (msgs || []).reverse()
      .map(m => `${m.direcao === 'entrada' ? 'CLIENTE' : 'ESCOLA'}: ${(m.texto || m.transcricao || '[' + (m.tipo || 'mídia') + ']').slice(0, 300)}`).join('\n');
    if (!hist || hist.length < 30) continue;    // conversa vazia não dá para julgar

    const sistema = `Você organiza o funil de uma escola de robótica infantil em Manaus, lendo conversas de WhatsApp com pais.
Classifique em UMA etapa, seguindo exatamente estes critérios:
- "Novo lead": ninguém da escola respondeu ainda.
- "Em contato": a escola já respondeu, mas ainda não se sabe nome e idade da criança nem houve conversa sobre horário/valor.
- "Qualificado": sabe-se NOME e IDADE da criança E a família falou sobre horário ou valor. Interesse real, falta marcar a aula.
- "Aula agendada": há dia e hora combinados na conversa.
- "Matrícula em andamento": já fez a aula experimental e falou em fechar/pagar.
- "Remarketing": disse que não pode agora, vai pensar, achou caro, horário não bate — mas pode voltar.
- "Perdido": sem interesse, idade fora da faixa, pediu para não receber mais, ou sumiu há muito tempo depois de várias tentativas.
Na dúvida entre duas, escolha a MENOS avançada.
Se na conversa a família COMBINOU um dia e hora para a aula experimental, extraia: "aula_data" (AAAA-MM-DD) e "aula_hora" (HH:MM). Use a data de hoje informada para resolver "sábado", "amanhã", "dia 20". Se a aula combinada JÁ PASSOU, a etapa não pode ser "Aula agendada": use "Matrícula em andamento" se a família demonstrou querer fechar, ou "Remarketing" se sumiu depois da aula.
Responda SOMENTE com JSON:
{"etapa":"<nome exato>","motivo":"<até 15 palavras citando o que na conversa indica isso>","confianca":"alta|media|baixa","crianca":"<nome ou null>","idade":<número ou null>,"aula_data":"<AAAA-MM-DD ou null>","aula_hora":"<HH:MM ou null>"}`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 400, system: sistema,
          messages: [{ role: 'user', content: `Hoje é ${hojeManaus()} (${['domingo','segunda','terça','quarta','quinta','sexta','sábado'][new Date(hojeManaus()+'T12:00:00').getDay()]}).\nEtapa atual: ${etapaAtual?.nome || 'nenhuma'}\nCriança conhecida: ${lead.crianca || 'não'}${lead.idade ? ', ' + lead.idade + ' anos' : ''}\n\nCONVERSA\n${hist}` }] })
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      const txt = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('').trim();
      const p = JSON.parse(txt.replace(/```json|```/g, '').trim());
      const destino = (etapas || []).find(e => e.nome.toLowerCase().trim() === String(p.etapa || '').toLowerCase().trim());
      if (!destino || destino.id === lead.etapa_id) continue;   // já está certo
      saida.push({
        lead_id: lead.id, nome: lead.nome, contato: lead.contato,
        etapa_atual: etapaAtual?.nome || null, etapa_atual_id: lead.etapa_id || null,
        etapa_nova: destino.nome, etapa_nova_id: destino.id,
        motivo: p.motivo || '', confianca: p.confianca || 'media',
        crianca: p.crianca || null, idade: p.idade || null,
        aula_data: /^\d{4}-\d{2}-\d{2}$/.test(String(p.aula_data||'')) ? p.aula_data : null,
        aula_hora: /^\d{2}:\d{2}$/.test(String(p.aula_hora||'')) ? p.aula_hora : null,
        aula_passou: /^\d{4}-\d{2}-\d{2}$/.test(String(p.aula_data||'')) ? p.aula_data < hojeManaus() : null,
        avisa_meta: ETAPAS_META.includes(destino.nome.toLowerCase().trim()),
        conversa_id: c.id
      });
    } catch (e) { /* uma conversa que falha não derruba a triagem */ }
  }
  return res.status(200).json({ sugestoes: saida, restantes: Math.max(0, vistos.size - saida.length) });
}

async function acaoTriagemAplicar(tenant, body, res) {
  const itens = Array.isArray(body.itens) ? body.itens.slice(0, 30) : [];
  if (!itens.length) return res.status(400).json({ erro: 'Nada para aplicar.' });
  const etapas = await sb(`capta_etapas?tenant_id=eq.${tenant.id}&select=id,nome`);
  const feitos = [], falhas = [];
  for (const it of itens) {
    const destino = (etapas || []).find(e => e.id === it.etapa_nova_id);
    if (!destino) { falhas.push({ lead_id: it.lead_id, erro: 'etapa não encontrada' }); continue; }
    // trava: as duas etapas que disparam evento de conversão exigem confirmação individual
    if (ETAPAS_META.includes(destino.nome.toLowerCase().trim()) && !it.confirmado_individual) {
      falhas.push({ lead_id: it.lead_id, erro: 'esta etapa precisa ser confirmada uma a uma' }); continue;
    }
    try {
      // aula combinada na conversa vira agendamento de verdade, com criança, dia e hora
      let agendado = null;
      if (/aula agendada/i.test(destino.nome) && it.aula_data && it.aula_data >= hojeManaus()) {
        const hora = it.aula_hora || '09:00';
        const h = Number(hora.slice(0, 2));
        const [turma] = await sb(`capta_turmas?tenant_id=eq.${tenant.id}&ativa=eq.true&dia_semana=eq.${new Date(it.aula_data + 'T12:00:00').getDay()}&hora_inicio=lte.${hora}:00&hora_fim=gt.${hora}:00&select=id&limit=1`).catch(() => []);
        const ja = await sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&lead_id=eq.${it.lead_id}&data=eq.${it.aula_data}&status=in.(agendado,confirmado)&select=id&limit=1`).catch(() => []);
        if (!ja?.length) {
          const novo = await sb('capta_agendamentos', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
            tenant_id: tenant.id, lead_id: it.lead_id, turma_id: turma?.id || null, data: it.aula_data,
            hora_inicio: String(h).padStart(2,'0') + ':00:00', hora_fim: String(h+1).padStart(2,'0') + ':00:00',
            crianca_nome: it.crianca || null, crianca_idade: it.idade || null, status: 'agendado', tipo: 'experimental',
            observacao: 'marcada pela triagem: combinado na conversa', criado_por: 'triagem' }) }).catch(() => null);
          agendado = novo?.[0] || null;
          if (agendado) await sb(`capta_leads?id=eq.${it.lead_id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ data_aula: `${it.aula_data}T${hora}:00-04:00` }) }).catch(() => null);
        }
      }
      await moverLead(tenant.id, it.lead_id, destino.id, it.motivo || 'triagem');
      await empurrarKommo(tenant.id, it.lead_id, destino.id, it.motivo || null).catch(() => null);
      if (agendado) await kommoCampos(tenant.id, it.lead_id, { data_aula: `${it.aula_data}T${it.aula_hora || '09:00'}:00-04:00`, curso: 'First' }).catch(() => null);
      if (it.crianca || it.idade || it.nota) {
        const patch = { ...(it.crianca ? { crianca: it.crianca } : {}), ...(it.idade ? { idade: it.idade } : {}) };
        if (it.nota) {
          const [l] = await sb(`capta_leads?id=eq.${it.lead_id}&select=notas&limit=1`).catch(() => [{}]);
          const carimbo = new Date().toLocaleDateString('pt-BR');
          patch.notas = ((l?.notas || '') + `\n[${carimbo}${it.atendente ? ' · ' + it.atendente : ''}] ${it.nota}`).trim().slice(0, 4000);
          await kommoNota(tenant.id, it.lead_id, it.nota).catch(() => null);
        }
        await sb(`capta_leads?id=eq.${it.lead_id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }).catch(() => null);
      }
      feitos.push(it.lead_id);
    } catch (e) { falhas.push({ lead_id: it.lead_id, erro: e.message }); }
  }
  return res.status(200).json({ movidos: feitos.length, falhas });
}


// ---------------------------------------------------------------------
// FILA DE RETOMADA — lead que já custou dinheiro e está parado.
// Devolve poucos por vez, com a mensagem pronta, e guarda quem já foi falado
// para a pessoa não aparecer de novo amanhã.
// ---------------------------------------------------------------------
async function acaoRetomada(tenant, body, res) {
  const hoje = hojeManaus();
  const limite = Math.min(Number(body.limite) || 10, 30);

  const [etapas, leads, ags, convs, feitas] = await Promise.all([
    sb(`capta_etapas?tenant_id=eq.${tenant.id}&select=id,nome,tipo,ordem&order=ordem.asc`),
    sb(`capta_leads?tenant_id=eq.${tenant.id}&select=id,nome,contato,temperatura,crianca,idade,etapa_id,etapa_em,criado_em,fonte,porta,atendente,notas,campanha,kommo_lead_id&limit=1500`),
    sb(`capta_agendamentos?tenant_id=eq.${tenant.id}&select=lead_id,data,status&order=data.desc&limit=800`).catch(() => []),
    sb(`capta_conversas?tenant_id=eq.${tenant.id}&select=id,lead_id,ultima_mensagem_em,nao_lidas,resolvida_em&limit=500`).catch(() => []),
    sb(`capta_retomadas?tenant_id=eq.${tenant.id}&select=lead_id,acao,adiar_ate,criado_em&order=criado_em.desc&limit=1000`).catch(() => [])
  ]);

  const etapaDe = id => (etapas || []).find(e => e.id === id) || {};
  const temAula = new Set((ags || []).filter(a => ['agendado','confirmado','compareceu'].includes(a.status)).map(a => a.lead_id));
  const convDe = Object.fromEntries((convs || []).map(c => [c.lead_id, c]));
  // quem já foi trabalhado: descartado nunca mais; enviado/adiado só depois do prazo
  const bloqueado = new Map();
  for (const r of feitas || []) {
    if (bloqueado.has(r.lead_id)) continue;
    if (r.acao === 'descartado') { bloqueado.set(r.lead_id, '9999-12-31'); continue; }
    const ate = r.adiar_ate || new Date(new Date(r.criado_em).getTime() + 5 * 864e5).toISOString().slice(0, 10);
    bloqueado.set(r.lead_id, ate);
  }
  const livre = id => { const ate = bloqueado.get(id); return !ate || ate < hoje; };
  const dias = d => d ? Math.floor((new Date(hoje + 'T12:00') - new Date(d)) / 864e5) : 999;

  const fila = [];
  for (const l of leads || []) {
    if (!livre(l.id)) continue;
    const et = etapaDe(l.etapa_id);
    if (['ganha','perdida'].includes(et.tipo)) continue;       // aluno ou já perdido de propósito
    if (!l.contato) continue;
    const c = convDe[l.id];
    const paradoHa = dias(l.etapa_em || l.criado_em);
    const quente = String(l.temperatura || '').toLowerCase() === 'quente';
    let motivo = null, urgencia = 0, porque = '';

    if ((c?.nao_lidas || 0) > 0 && !c?.resolvida_em) {
      motivo = 'sem_resposta'; urgencia = 100;
      porque = 'mandou mensagem e ninguém respondeu';
    } else if (quente && !temAula.has(l.id)) {
      motivo = 'quente_sem_aula'; urgencia = 90;
      porque = 'está quente e não tem aula marcada';
    } else if ((l.porta === 'evento' || l.fonte === 'evento') && /novo lead/i.test(et.nome || '')) {
      motivo = 'evento'; urgencia = 80;
      porque = 'deixou o contato num evento e ninguém retomou';
    } else if (paradoHa >= 3 && /em contato|qualificado/i.test(et.nome || '')) {
      motivo = 'parado'; urgencia = 60 + Math.min(paradoHa, 30);
      porque = `parado há ${paradoHa} dias em ${et.nome}`;
    } else if (/remarketing/i.test(et.nome || '') && paradoHa >= 20) {
      motivo = 'remarketing'; urgencia = 40;
      porque = `em remarketing há ${paradoHa} dias`;
    }
    if (!motivo) continue;
    fila.push({
      lead_id: l.id, nome: l.nome, contato: l.contato, crianca: l.crianca, idade: l.idade,
      temperatura: l.temperatura, etapa: et.nome, etapa_id: l.etapa_id, atendente: l.atendente, notas: l.notas,
      kommo_lead_id: l.kommo_lead_id || null, conversa_id: c?.id || null,
      fonte: l.fonte, porta: l.porta, criado_em: l.criado_em,
      motivo, porque, parado_ha: paradoHa, urgencia
    });
  }
  fila.sort((a, b) => b.urgencia - a.urgencia || b.parado_ha - a.parado_ha);

  // duas vagas reais para oferecer na mensagem
  const horarios = await rpc('capta_vagas_experimental', { p_tenant: tenant.id, p_dias: 10 }).catch(() => []);
  const livres = (horarios || []).filter(h => (h.vagas ?? 0) > 0).slice(0, 8)
    .map(h => ({ data: h.data, hora: String(h.hora_inicio).slice(0, 5), turma_id: h.turma_id }));

  return res.status(200).json({
    total: fila.length,
    fila: fila.slice(0, limite),
    vagas: livres,
    por_motivo: fila.reduce((a, x) => { a[x.motivo] = (a[x.motivo] || 0) + 1; return a; }, {})
  });
}

async function acaoRetomadaMarcar(tenant, body, res) {
  const { lead_id, acao, motivo, observacao, adiar_dias } = body;
  if (!lead_id || !acao) return res.status(400).json({ erro: 'Informe o lead e a ação.' });
  const adiar = adiar_dias ? new Date(Date.now() + Number(adiar_dias) * 864e5 - 4 * 3600e3).toISOString().slice(0, 10) : null;
  await sb('capta_retomadas', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    tenant_id: tenant.id, lead_id, acao, motivo: motivo || null,
    atendente: body.atendente || null, observacao: observacao || null, adiar_ate: adiar }) });
  return res.status(200).json({ ok: true });
}


// ---------------------------------------------------------------------
// REMARCAÇÃO DE AULA DE ALUNO — faltou e vai assistir em outro dia.
// A aula da semana muda de lugar: some (esmaecida) do dia original e
// aparece no dia novo, com a etiqueta "remarcado" nos dois.
// ---------------------------------------------------------------------
async function acaoRemarcarAluno(tenant, body, res) {
  const { aluno_id, data_original, data_nova, turma_nova, hora_inicio } = body;
  if (!aluno_id || !data_original || !data_nova) return res.status(400).json({ erro: 'Informe o aluno, o dia da aula e o novo dia.' });
  const [al] = await sb(`capta_alunos?id=eq.${aluno_id}&tenant_id=eq.${tenant.id}&select=id,nome,nome_curto,kit,turma_id&limit=1`);
  if (!al) return res.status(404).json({ erro: 'Aluno não encontrado.' });

  let hIni = hora_inicio ? String(hora_inicio).slice(0, 5) + ':00' : null, hFim = null, turma = turma_nova || null;
  if (turma) {
    const [t] = await sb(`capta_turmas?id=eq.${turma}&select=hora_inicio,hora_fim&limit=1`);
    if (t) { hIni = hIni || t.hora_inicio; hFim = t.hora_fim; }
  }
  if (hIni && !hFim) { const n = Number(String(hIni).slice(0, 2)); hFim = String(n + 2).padStart(2, '0') + ':00:00'; }  // aula do aluno: 2 horas

  const linha = {
    tenant_id: tenant.id, aluno_id, data_original, turma_original: al.turma_id || null,
    data_nova, turma_nova: turma, hora_inicio: hIni, hora_fim: hFim,
    motivo: body.motivo || null, atendente: body.atendente || null
  };
  // se já havia remarcação para o mesmo dia, substitui
  await sb(`capta_remarcacoes?tenant_id=eq.${tenant.id}&aluno_id=eq.${aluno_id}&data_original=eq.${data_original}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null);
  const nova = await sb('capta_remarcacoes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(linha) });
  return res.status(200).json({ ok: true, remarcacao: nova?.[0] || null });
}

async function acaoDesfazerRemarcacao(tenant, body, res) {
  const { id, aluno_id, data_original } = body;
  if (id) await sb(`capta_remarcacoes?id=eq.${id}&tenant_id=eq.${tenant.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  else if (aluno_id && data_original) await sb(`capta_remarcacoes?tenant_id=eq.${tenant.id}&aluno_id=eq.${aluno_id}&data_original=eq.${data_original}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  else return res.status(400).json({ erro: 'Informe a remarcação.' });
  return res.status(200).json({ ok: true });
}


// ---------------------------------------------------------------------
// CASAR POR @lid — conversas que chegaram sem número de verdade.
// Para cada lead com telefone, pergunta o @lid à Z-API e liga à conversa.
// Roda em lotes (a Z-API limita), guardando o @lid no lead para não repetir.
// ---------------------------------------------------------------------
async function acaoCasarLid(tenant, canal, body, res) {
  if (!canal) return res.status(400).json({ erro: 'Sem canal de WhatsApp.' });
  const limite = Math.min(Number(body.limite) || 40, 80);

  // ---- 0) fundir duplicadas: a mesma pessoa como conversa A (número real) e B (@lid) ----
  // Descobre o @lid das conversas com número real (pergunta à Z-API), e quando
  // acha uma conversa B com esse @lid, move as mensagens dela para A e apaga B.
  let fundidas = 0, falhas = 0;
  const reais = await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lid=is.null&select=id,telefone,lead_id&order=ultima_mensagem_em.desc.nullslast&limit=${limite}`).catch(() => []);
  for (const a of reais || []) {
    const dig = String(a.telefone || '').replace(/\D/g, '');
    if (!dig || dig.length > 13) continue;                       // já é @lid, pula
    const lid = await prov.lidDoTelefone(canal, a.telefone).catch(() => undefined);
    if (lid === undefined) { falhas++; if (falhas >= 3) break; continue; }   // provedor fora: não marca nada
    await sb(`capta_conversas?id=eq.${a.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lid: lid || 'sem' }) }).catch(() => null);
    if (!lid) continue;
    const bs = await sb(`capta_conversas?tenant_id=eq.${tenant.id}&id=neq.${a.id}&or=(lid.eq.${lid},telefone.eq.${lid},telefone.eq.55${lid})&select=id,nao_lidas`).catch(() => []);
    for (const b of bs || []) {
      await sb(`capta_mensagens?conversa_id=eq.${b.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ conversa_id: a.id }) }).catch(() => null);
      await sb(`capta_conversas?id=eq.${b.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null);
      fundidas++;
    }
    if (bs?.length) {
      // recalcula última mensagem e espera da conversa A
      const ult = await sb(`capta_mensagens?conversa_id=eq.${a.id}&select=texto,criado_em,direcao,tipo&order=criado_em.desc&limit=1`).catch(() => []);
      if (ult?.[0]) await sb(`capta_conversas?id=eq.${a.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ultima_mensagem: ult[0].texto || `[${ult[0].tipo}]`, ultima_mensagem_em: ult[0].criado_em, aguardando_desde: ult[0].direcao === 'entrada' ? undefined : null }) }).catch(() => null);
    }
  }
  const convs = await sb(`capta_conversas?tenant_id=eq.${tenant.id}&lead_id=is.null&select=id,telefone,lid,nome&limit=300`).catch(() => []);
  const pend = (convs || []).filter(c => (c.lid && c.lid !== 'sem') || String(c.telefone || '').replace(/\D/g, '').length > 13);
  if (!pend.length) return res.status(200).json({ ok: true, ligadas: 0, restantes: 0, aviso: 'Nenhuma conversa com @lid pendente.' });
  const lids = new Map(); pend.forEach(c => { const l = ((c.lid && c.lid !== 'sem') ? c.lid : String(c.telefone).replace(/\D/g, '')); lids.set(l, c); });

  // leads ainda sem @lid conhecido
  const leads = await sb(`capta_leads?tenant_id=eq.${tenant.id}&contato=not.is.null&lid=is.null&select=id,nome,contato&order=criado_em.desc&limit=${limite}`).catch(() => []);
  let ligadas = 0, consultados = 0;
  for (const l of leads || []) {
    if (falhas >= 3) break;
    const lid = await prov.lidDoTelefone(canal, l.contato).catch(() => undefined);
    consultados++;
    if (lid === undefined) { falhas++; continue; }                         // provedor fora: tenta na próxima rodada
    await sb(`capta_leads?id=eq.${l.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lid: lid || 'sem' }) }).catch(() => null);
    if (!lid) continue;
    const c = lids.get(lid);
    if (c) {
      await sb(`capta_conversas?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ lead_id: l.id, telefone: prov.comDDI(l.contato) || c.telefone, lid }) }).catch(() => null);
      // mensagens da conversa passam a contar para o lead
      ligadas++; lids.delete(lid);
    }
  }
  // também tenta pelo @lid já conhecido dos leads
  const comLid = await sb(`capta_leads?tenant_id=eq.${tenant.id}&lid=not.is.null&lid=neq.sem&select=id,lid,contato`).catch(() => []);
  for (const l of comLid || []) { const c = lids.get(l.lid); if (c) {
    await sb(`capta_conversas?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lead_id: l.id, telefone: prov.comDDI(l.contato) || c.telefone }) }).catch(() => null);
    ligadas++; lids.delete(l.lid); } }
  const faltamLeads = (await sb(`capta_leads?tenant_id=eq.${tenant.id}&contato=not.is.null&lid=is.null&select=id&limit=1000`).catch(() => [])).length;
  return res.status(200).json({ ok: true, fundidas, ligadas, consultados, falhas_provedor: falhas, conversas_pendentes: lids.size, leads_por_consultar: faltamLeads,
    aviso: falhas >= 3 ? 'A Z-API não respondeu (ou respondeu sem @lid). Nada foi marcado; confira a instância e rode de novo.' : undefined });
}

// ---------------------------------------------------------------------
// IDENTIFICAR CONTATO DE NÚMERO OCULTO (@lid)
// O WhatsApp esconde o número de algumas pessoas: a conversa chega só com
// um @lid e não há como descobrir o telefone por API. Quem descobre é o
// atendente, na conversa. Esta ação:
//   modo 'ler'    → procura nome/telefone nas mensagens (regex; com ia:true
//                   a IA lê a conversa) e diz se o telefone já é de um lead
//   modo 'salvar' → acha ou cria o lead, guarda o @lid nele e liga a
//                   conversa; se o lead já tinha conversa pelo número real,
//                   junta as duas
// ---------------------------------------------------------------------
function fonesNoTexto(t) {
  const achados = [];
  const re = /(?:\+?55[\s.-]?)?\(?\b(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/g;
  let m;
  while ((m = re.exec(String(t || '')))) {
    const ddd = Number(m[1]);
    if (ddd < 11 || ddd > 99) continue;
    const d = `${m[1]}${m[2]}${m[3]}`;
    if (d.length === 10 || d.length === 11) achados.push('55' + d);
  }
  return achados;
}

async function acaoIdentificar(tenant, body, res) {
  const convId = body.conversa_id;
  if (!convId) return res.status(400).json({ erro: 'Informe a conversa.' });
  const [conv] = await sb(`capta_conversas?id=eq.${convId}&tenant_id=eq.${tenant.id}&select=id,telefone,lid,nome,lead_id,atendente&limit=1`).catch(() => []);
  if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada.' });
  const lidConv = (conv.lid && conv.lid !== 'sem') ? conv.lid
    : (String(conv.telefone || '').replace(/\D/g, '').length > 13 ? String(conv.telefone).replace(/\D/g, '') : null);

  const leadDoFone = async fone => {
    const d = String(fone || '').replace(/\D/g, ''); if (d.length < 10) return null;
    const oito = d.slice(-8);
    const ls = await sb(`capta_leads?tenant_id=eq.${tenant.id}&contato=like.*${oito}&select=id,nome,contato,etapa_id,crianca&limit=5`).catch(() => []);
    const ddd = d.replace(/^55/, '').slice(0, 2);
    return (ls || []).find(l => String(l.contato || '').replace(/\D/g, '').replace(/^55/, '').startsWith(ddd)) || null;
  };

  // ------------------------------------------------------------ LER
  if ((body.modo || 'ler') === 'ler') {
    const msgs = await sb(`capta_mensagens?conversa_id=eq.${conv.id}&select=direcao,texto,transcricao,tipo,criado_em&order=criado_em.desc&limit=60`).catch(() => []);
    const cron = (msgs || []).reverse();
    // telefones escritos pelo CLIENTE (os da escola são o próprio número da unidade)
    const fones = [...new Set(cron.filter(m => m.direcao === 'entrada').flatMap(m => fonesNoTexto(m.texto || m.transcricao)))];
    const nomeWhats = (conv.nome && !/@lid$/i.test(conv.nome) && !/^\+?[\d\s()-]{10,}$/.test(conv.nome) && !/^(contato do whats ?app|contato sem n[uú]mero|my robot manaus)/i.test(conv.nome)) ? conv.nome : '';
    let out = { nome: nomeWhats || '', telefone: fones[0] || '', crianca: '', idade: '', de_onde: fones[0] ? 'número escrito na conversa' : (nomeWhats ? 'nome do perfil do WhatsApp' : ''), ia: false };

    if (body.ia) {
      const chave = process.env.ANTHROPIC_API_KEY;
      if (!chave) out.aviso = 'A leitura por IA não está ativa nesta conta; usei só o que dá pra achar sem IA.';
      else if (cron.length) {
        const historico = cron.map(m => `${m.direcao === 'entrada' ? 'CLIENTE' : 'ESCOLA'}: ${(m.texto || m.transcricao || '[' + (m.tipo || 'mídia') + ']').slice(0, 400)}`).join('\n');
        try {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001', max_tokens: 300,
              system: 'Você extrai dados de uma conversa de WhatsApp entre uma escola e um CLIENTE (em geral mãe ou pai). Devolva SOMENTE JSON: {"nome":"","telefone":"","crianca":"","idade":"","trecho":""}. nome = nome do CLIENTE (quem escreve), nunca o da escola nem o da criança. telefone = número de WhatsApp que o CLIENTE informou, só dígitos com DDD. crianca/idade = da criança, se aparecer. trecho = a frase curta da conversa de onde tirou o nome ou telefone. Deixe vazio o que não estiver escrito; nunca invente.',
              messages: [{ role: 'user', content: historico.slice(-12000) }]
            })
          });
          const j = await r.json();
          if (j.error) throw new Error(j.error.message || 'A IA recusou o pedido.');
          const txt = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
          const d = JSON.parse(txt.replace(/```json|```/g, '').trim());
          const tel = fonesNoTexto(d.telefone)[0] || (String(d.telefone || '').replace(/\D/g, '').length >= 10 ? '55' + String(d.telefone).replace(/\D/g, '').replace(/^55/, '') : '');
          out = { nome: d.nome || out.nome, telefone: tel || out.telefone, crianca: d.crianca || '', idade: d.idade ? String(d.idade).replace(/\D/g, '') : '', de_onde: d.trecho ? `a IA leu: "${String(d.trecho).slice(0, 120)}"` : out.de_onde, ia: true };
        } catch (e) {
          await registrarFalha(tenant.id, 'identificar', e.message).catch(() => null);
          out.aviso = 'A IA não conseguiu ler agora; mostrei só o que dá pra achar sem IA.';
        }
      }
    }
    const existente = out.telefone ? await leadDoFone(out.telefone) : null;
    return res.status(200).json({ ...out, lead_existente: existente ? { id: existente.id, nome: existente.nome, contato: existente.contato } : null });
  }

  // ------------------------------------------------------------ SALVAR
  const nome = String(body.nome || '').trim();
  // Conversa já ligada a um lead sem nome de verdade ("Contato do WhatsApp",
  // criado pelo Kommo): só completa o cadastro — no Capta e no Kommo.
  if (conv.lead_id) {
    if (!nome) return res.status(400).json({ erro: 'Escreva o nome da pessoa.' });
    const [ld] = await sb(`capta_leads?id=eq.${conv.lead_id}&tenant_id=eq.${tenant.id}&select=id,etapa_id,crianca&limit=1`).catch(() => []);
    if (!ld) return res.status(404).json({ erro: 'Lead não encontrado.' });
    const patch = { nome };
    if (body.crianca) patch.crianca = String(body.crianca).trim();
    if (body.idade) patch.idade = Number(body.idade) || null;
    if (!ld.etapa_id) patch.etapa_id = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Novo%20lead&select=id&limit=1`).catch(() => []))?.[0]?.id || null;
    await sb(`capta_leads?id=eq.${ld.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ nome }) }).catch(() => null);
    const kommo = await kommoRenomear(tenant.id, ld.id, nome).catch(() => false);
    if (body.crianca || body.idade) kommoNota(tenant.id, ld.id, `Capta: cadastro completado — responsável ${nome}${body.crianca ? ', criança ' + body.crianca : ''}${body.idade ? ', ' + body.idade + ' anos' : ''}`).catch(() => null);
    return res.status(200).json({ ok: true, lead_id: ld.id, lead_nome: nome, lead_criado: false, completado: true, kommo, conversa_id: conv.id });
  }
  let fone = String(body.telefone || '').replace(/\D/g, '');
  if (!nome) return res.status(400).json({ erro: 'Escreva o nome da pessoa.' });
  if (fone.length < 10 || fone.length > 13) return res.status(400).json({ erro: 'Telefone inválido: use DDD + número, ex.: 92 99999-9999.' });
  fone = fone.startsWith('55') && fone.length >= 12 ? fone : '55' + fone;

  const quem = await usuarioDe(tenant.id, body.email_atual).catch(() => null);
  const autor = quem?.nome || body.por_nome || conv.atendente || null;

  let lead = await leadDoFone(fone), criado = false;
  if (!lead) {
    const etapaId = (await sb(`capta_etapas?tenant_id=eq.${tenant.id}&nome=eq.Novo%20lead&select=id&limit=1`).catch(() => []))?.[0]?.id || null;
    const ins = await sb('capta_leads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
      tenant_id: tenant.id, nome, contato: fone, lid: lidConv,
      crianca: body.crianca || null, idade: body.idade ? Number(body.idade) || null : null,
      origem: 'whatsapp-direto', porta: 'whatsapp-direto', status: 'contatado', etapa_id: etapaId,
      atendente: autor, notas: 'Chegou pelo WhatsApp com número oculto (@lid); identificado na inbox' + (autor ? ` por ${autor}` : '')
    }) }).catch(() => null);
    lead = ins?.[0] || await leadDoFone(fone);   // o gatilho de unificação pode ter absorvido o insert
    criado = !!ins?.[0];
    if (!lead) return res.status(500).json({ erro: 'Não consegui criar o lead.' });
  }
  if (lidConv) await sb(`capta_leads?id=eq.${lead.id}&tenant_id=eq.${tenant.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ lid: lidConv }) }).catch(() => null);
  if (!criado && (body.crianca || body.idade)) {
    const patch = {}; if (body.crianca && !lead.crianca) patch.crianca = body.crianca; if (body.idade) patch.idade = Number(body.idade) || null;
    if (Object.keys(patch).length) await sb(`capta_leads?id=eq.${lead.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }).catch(() => null);
  }

  // o lead já tinha conversa pelo número real? junta as duas nela
  const oito = fone.slice(-8);
  const outras = (await sb(`capta_conversas?tenant_id=eq.${tenant.id}&id=neq.${conv.id}&or=(lead_id.eq.${lead.id},telefone.like.*${oito})&select=id,lid,nao_lidas,aguardando_desde&order=ultima_mensagem_em.desc.nullslast&limit=1`).catch(() => [])) || [];
  let ficou = conv.id, unida = false;
  if (outras[0]) {
    const a = outras[0];
    await sb(`capta_mensagens?conversa_id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ conversa_id: a.id }) });
    const [cv] = await sb(`capta_conversas?id=eq.${conv.id}&select=nao_lidas&limit=1`).catch(() => []);
    await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    const [ult] = await sb(`capta_mensagens?conversa_id=eq.${a.id}&select=texto,tipo,criado_em,direcao&order=criado_em.desc&limit=1`).catch(() => []);
    await sb(`capta_conversas?id=eq.${a.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      lead_id: lead.id, lid: (a.lid && a.lid !== 'sem') ? a.lid : lidConv,
      nao_lidas: (a.nao_lidas || 0) + (cv?.nao_lidas || 0),
      ...(ult ? { ultima_mensagem: ult.texto || `[${ult.tipo}]`, ultima_mensagem_em: ult.criado_em,
        aguardando_desde: ult.direcao === 'entrada' ? (a.aguardando_desde || ult.criado_em) : null } : {})
    }) }).catch(() => null);
    ficou = a.id; unida = true;
  } else {
    await sb(`capta_conversas?id=eq.${conv.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      lead_id: lead.id, telefone: fone, lid: lidConv, nome
    }) });
  }
  return res.status(200).json({ ok: true, lead_id: lead.id, lead_nome: lead.nome || nome, lead_criado: criado, conversa_id: ficou, unida });
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
  await fecharConversaPorEtapa(tenantId, leadId, etapaId);
  avisarMeta(tenantId, leadId, etapaId).catch(() => null);   // nunca segura a fila
}

// ---------------------------------------------------------------------
// META ADS — conversão avisada pelo Capta
// Antes quem avisava era o Kommo, por webhook de etapa. Em 18/set/2026 o
// Kommo bloqueou o IP da Vercel e o rastreio parou junto — as campanhas
// deixariam de otimizar por matrícula. Agora o Capta avisa direto.
// O identificador do evento é o mesmo dos dois caminhos, então se o Kommo
// voltar a mandar, a Meta reconhece e não conta a conversão duas vezes.
// ---------------------------------------------------------------------
const META_ETAPA = [
  [/qualificado/i,            'lead'],
  [/aula agendada/i,          'schedule'],
  [/aluno ativo|matr[ií]cula/i, 'purchase'],
];
async function avisarMeta(tenantId, leadId, etapaId) {
  const segredo = process.env.CAPTA_META_SECRET || process.env.CRON_SECRET;
  if (!segredo || !leadId || !etapaId) return;

  const [et] = await sb(`capta_etapas?id=eq.${etapaId}&select=nome&limit=1`).catch(() => []);
  const regra = META_ETAPA.find(([re]) => re.test(et?.nome || ''));
  if (!regra) return;

  const [l] = await sb(`capta_leads?id=eq.${leadId}&tenant_id=eq.${tenantId}&select=contato,email,nome,kommo_lead_id,fonte,curso&limit=1`).catch(() => []);
  if (!l?.contato && !l?.email) return;

  const base = process.env.MYROBOT_URL || 'https://www.myrobotmanaus.com';
  await fetch(`${base}/api/meta-capi?event=${regra[1]}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      direto: true, segredo,
      // mesmo id do caminho antigo, para a Meta juntar os dois
      lead_id: l.kommo_lead_id || `capta-${leadId}`,
      telefone: l.contato || undefined,
      email: l.email || undefined,
      nome: l.nome || undefined,
      utm_source: l.fonte || undefined,
      trilha: l.curso || undefined,
    })
  }).catch(() => null);
}

// Etapas que encerram o atendimento: matriculado, aula marcada, perdido,
// desistiu. A conversa sai das abertas e para de contar como "sem resposta";
// se o lead escrever de novo, o webhook reabre sozinho.
// "Aula agendada" NÃO entra: entre marcar e dar a aula é justamente quando o
// time confirma presença, lembra e remarca. Fecha só o que acabou mesmo.
const ETAPA_ENCERRA = /matr[ií]cul|aluno ativo|perdido|desist|trancad/i;
async function fecharConversaPorEtapa(tenantId, leadId, etapaId) {
  if (!leadId || !etapaId) return;
  try {
    const e = (await sb(`capta_etapas?id=eq.${etapaId}&tenant_id=eq.${tenantId}&select=nome&limit=1`))?.[0];
    if (!e) return;
    const fecha = ETAPA_ENCERRA.test(e.nome || '');
    await sb(`capta_conversas?tenant_id=eq.${tenantId}&lead_id=eq.${leadId}${fecha ? '&resolvida_em=is.null' : '&resolvida_em=not.is.null'}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(fecha
        ? { resolvida_em: new Date().toISOString(), nao_lidas: 0, aguardando_desde: null }
        : { resolvida_em: null })
    });
  } catch (err) { console.error('[fecharConversaPorEtapa]', err.message); }
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
