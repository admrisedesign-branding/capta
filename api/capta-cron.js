// /api/capta-cron.js — o relógio do Capta
//
// Roda uma vez por dia (limite do plano Hobby do Vercel: 2 crons/dia) e faz:
//   1. lembrete da véspera e do dia para as aulas experimentais
//   2. fecha sessões de bot paradas
//
// Sem isso o agente só responde e nunca persegue — e é a perseguição que
// segura o comparecimento.
//
// Proteção: exige o header do Vercel Cron ou ?chave=CRON_SECRET.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZAPI_CLIENT_TOKEN, CRON_SECRET

const prov = require('./_lib/whatsapp-provedor');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wpoeigoledhzyvomudgf.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

async function rpc(nome, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error(`${nome}: ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

module.exports = async function handler(req, res) {
  const autorizado = req.headers['x-vercel-cron']
    || (CRON_SECRET && req.query.chave === CRON_SECRET);
  if (!autorizado) return res.status(401).json({ erro: 'não autorizado' });

  const resumo = { enviados: 0, falhas: 0, sessoes: 0, negocios: 0 };

  try {
    // Só negócios com WhatsApp conectado.
    const canais = await sb(
      `capta_canais?tipo=eq.whatsapp&status=eq.conectado&select=*`
    );

    for (const canal of canais || []) {
      resumo.negocios++;
      try { await lembretes(canal, resumo); }
      catch (e) { console.error('[cron lembretes]', canal.tenant_id, e.message); }
    }

    try { resumo.sessoes = await rpc('capta_bot_abandonar_paradas', { p_horas: 48 }); }
    catch { /* a tabela do bot pode ainda não existir em produção */ }

  } catch (e) {
    console.error('[cron]', e.message);
    return res.status(500).json({ erro: e.message, resumo });
  }

  return res.status(200).json({ ok: true, ...resumo });
};

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
      ? `Oi! Tudo certo pra amanhã às ${hora}? A aula ${primeiro ? 'do ' + primeiro + ' ' : ''}já está reservada 😊`
      : `Bom dia! Passando pra lembrar da aula ${primeiro ? 'do ' + primeiro + ' ' : ''}hoje às ${hora}. Tá tudo preparado!`;

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

// =====================================================================
// CONFIGURAR NO VERCEL
//
// Criar (ou editar) vercel.json na RAIZ do repositório:
//
// {
//   "crons": [
//     { "path": "/api/capta-cron", "schedule": "0 12 * * *" }
//   ]
// }
//
// 12:00 UTC = 8:00 em Manaus. O lembrete do dia sai de manhã cedo e o da
// véspera chega em horário civilizado.
//
// O plano Hobby permite 2 execuções por dia. Se quiser um segundo horário
// (por exemplo 21:00 UTC = 17:00 em Manaus, pegando quem agendou durante
// o dia), acrescentar outra linha em "crons".
// =====================================================================


// =====================================================================
// NOTAS
//
// 1. NÃO EXISTE resgate de no-show automático aqui. Marcar quem faltou é
//    manual (botão na agenda ou totem), e o cron roda uma vez por dia —
//    o resgate precisa sair na mesma tarde para funcionar. Isso fica com
//    o humano por enquanto.
//
// 2. RITMO: 1,5s entre mensagens, de propósito. Conexão não oficial é
//    banida por disparo rápido. Se um dia a fila passar de ~200 por
//    execução, o limite de 10s da função Hobby estoura — aí é fatiar a
//    fila ou subir para o Pro.
//
// 3. A pesquisa pós-aula (capta_pesquisas_pendentes) ainda não entra
//    aqui: depende das tabelas de pesquisa, que só existem no capta-dev.
//
// 4. CRON_SECRET permite testar chamando na mão:
//    https://capta.riseagencia.com/api/capta-cron?chave=SEU_SEGREDO
//    Sem ele, só o próprio Vercel consegue executar.
// =====================================================================
