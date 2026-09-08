/* lead-painel.js — a gaveta do lead, igual em todas as telas do Capta.
   Uso:  LeadPainel.init({ slug, token, getLead:(id)=>lead, getEtapas:()=>[...], onMover:(lead, etapaId, motivo)=>{}, onAgendou:(lead)=>{}, onExcluir:(lead)=>{}, leadsApi:'/api/capta-leads' })
         LeadPainel.abrir(id, 'conversa'|'dados'|'agendar')   LeadPainel.fechar()
   Abas: Conversa (chat do WhatsApp, atendente, resolver, respostas prontas, anexos, importar .txt) · Dados · Agendar aula.  */
(function () {
  const CSS = `
  #lp{position:fixed;top:0;right:0;height:100vh;width:0;overflow:hidden;transition:.22s cubic-bezier(.4,0,.2,1);border-left:1px solid var(--line,#E9ECF3);background:var(--card,#fff);display:flex;flex-direction:column;z-index:80;box-shadow:-10px 0 40px rgba(20,26,46,.12);font-family:inherit}
  #lp.aberto{width:560px;max-width:96vw}
  #lp-scrim{position:fixed;inset:0;background:rgba(20,26,46,.18);z-index:75;display:none}#lp-scrim.on{display:block}
  #lp .cab{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:flex-start}
  #lp .av{width:38px;height:38px;border-radius:10px;background:var(--brand-soft,rgba(46,91,255,.1));color:var(--brand,#2E5BFF);font-weight:800;display:grid;place-items:center;flex:0 0 38px}
  #lp h3{font-size:15px;font-weight:800;line-height:1.2;margin:0}#lp .sub{font-size:12px;color:var(--muted,#697089);margin-top:2px}
  #lp .cab .x{margin-left:auto;border:0;background:transparent;color:var(--faint,#9AA1B4);font-size:20px;line-height:1;cursor:pointer}
  #lp .abas{display:flex;border-bottom:1px solid var(--line);padding:0 10px}
  #lp .abas button{border:0;background:transparent;font-weight:700;font-size:12.5px;color:var(--muted);padding:10px 12px;border-bottom:2px solid transparent;cursor:pointer;font-family:inherit}
  #lp .abas button.on{color:var(--brand);border-color:var(--brand)}
  #lp .corpo{flex:1;overflow-y:auto;padding:12px 18px;display:flex;flex-direction:column}
  #lp .sec{font-size:11px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;margin:12px 0 6px}
  #lp .chips{display:flex;flex-wrap:wrap;gap:6px}#lp .chip{border:1px solid var(--line);background:var(--card);border-radius:99px;padding:5px 10px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit}
  #lp .chip.on{background:var(--brand);border-color:var(--brand);color:#fff}#lp .chip.ganha.on{background:var(--verde,#16A34A);border-color:var(--verde,#16A34A)}#lp .chip.perdida.on{background:var(--faint);border-color:var(--faint)}
  #lp .campo label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}#lp .campo select,#lp .campo input,#lp .campo textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-family:inherit;font-size:13px;color:var(--ink,#141A2E);background:var(--card)}
  #lp .campo textarea{min-height:70px;resize:vertical}#lp .l2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  #lp .btn{border:0;background:var(--brand);color:#fff;font-weight:700;font-size:12.5px;padding:8px 14px;border-radius:9px;cursor:pointer;font-family:inherit}#lp .btn.g{background:var(--card);color:var(--muted);border:1px solid var(--line)}#lp .btn:disabled{opacity:.5;cursor:default}
  #lp .acoes{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--bg,#F4F6FB)}
  #lp .acoes select,#lp .acoes button{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:6px 9px;font-size:12px;font-weight:700;color:var(--muted);font-family:inherit;cursor:pointer}
  #lp .acoes button.ok{background:var(--verde,#16A34A);border-color:var(--verde,#16A34A);color:#fff}
  #lp .robo{font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:1px solid var(--line);border-radius:9px;color:var(--muted)}#lp .robo i{width:7px;height:7px;border-radius:50%;background:var(--faint)}#lp .robo.on i{background:var(--verde,#16A34A)}
  #lp .msgs{display:flex;flex-direction:column;gap:6px;flex:1}
  #lp .msg{max-width:88%;padding:8px 10px;border-radius:12px;font-size:13px;line-height:1.45;background:var(--line-2,#F1F3F8);align-self:flex-start;white-space:pre-wrap}
  #lp .msg.saida{background:var(--brand-soft,rgba(46,91,255,.1));align-self:flex-end}#lp .msg small{display:block;color:var(--faint);font-size:10.5px;margin-top:3px}
  #lp .msg img{max-width:100%;border-radius:8px;display:block;margin-top:4px}#lp .msg audio{width:100%;margin-top:4px}
  #lp .aviso{margin:8px 0;background:rgba(224,147,15,.14);border:1px solid rgba(224,147,15,.28);border-radius:11px;padding:8px 12px;font-size:12.5px;color:#8A5A04;line-height:1.5}
  #lp .aviso-p{border:1px dashed var(--line);border-radius:12px;padding:14px;color:var(--faint);font-size:12.5px;line-height:1.6;text-align:center}
  #lp .escrever{display:flex;gap:6px;padding:10px 18px;border-top:1px solid var(--line);align-items:flex-end;position:relative}
  #lp .escrever textarea{flex:1;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-family:inherit;font-size:13.5px;resize:none;max-height:120px;color:var(--ink);background:var(--card)}
  #lp .ico{border:1px solid var(--line);background:var(--card);border-radius:10px;width:38px;height:38px;display:grid;place-items:center;font-size:16px;cursor:pointer;color:var(--muted)}
  #lp .rapidas{position:absolute;left:18px;right:18px;bottom:64px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px rgba(20,26,46,.15);max-height:260px;overflow-y:auto;z-index:5}
  #lp .rp{padding:9px 12px;border-bottom:1px solid var(--line-2);cursor:pointer;font-size:13px}#lp .rp:hover{background:var(--brand-softer,rgba(46,91,255,.06))}#lp .rp b{display:block;font-size:12px}#lp .rp small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
  #lp .vaga{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:8px;background:var(--brand-softer,rgba(46,91,255,.06))}#lp .vaga b{font-size:14px}#lp .vaga .liv{color:var(--muted);font-size:12px;margin-top:2px}#lp .vaga .acs{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
  #lp .ag-item{font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line-2);display:flex;justify-content:space-between}#lp .ag-item .st{color:var(--muted)}
  #lp .salvo{font-size:11.5px;color:var(--verde,#16A34A);font-weight:600;margin-left:8px}
  #lp .lnk{font-weight:700;color:var(--brand);text-decoration:none;cursor:pointer}
  #lp .del{width:100%;margin-top:14px;background:none;border:1px solid var(--line);color:var(--muted);border-radius:10px;padding:8px;font-size:12.5px;cursor:pointer;font-family:inherit}
  @media(max-width:760px){#lp.aberto{width:100%}}
  `;
  const FONTES = ['anúncio','instagram','google busca','google business','evento','direto','indicação'];
  const PORTAS = ['site','whatsapp-bot','whatsapp-direto','evento','my robot'];
  const ATEND = ['Rafael','Bento','RISE'];
  const EU = () => (window.CaptaUser && CaptaUser.nome()) || '';
  const DIAS_N = ['dom','seg','ter','qua','qui','sex','sáb'];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const hhmm = t => String(t || '').slice(0, 5);
  const dataBR = d => { const [a,m,dd] = String(d).split('-'); return `${dd}/${m}`; };
  const nomeDia = d => DIAS_N[new Date(d + 'T12:00:00').getDay()];
  const hora = iso => new Date(iso).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  const say = (m, o) => (window.toast ? toast(m, o) : (o && o.tipo === 'erro' ? alert(m.replace(/<[^>]+>/g,'')) : null));

  let cfg = {}, S = { lead: null, aba: 'conversa', info: null, agenda: null, idx: { manha:0, tarde:0, sab:0 }, etapas: [], rapidas: null, timer: null, timerMsg: null };

  async function api(acao, extra = {}) {
    const r = await fetch('/api/capta-whatsapp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ acao, slug: cfg.slug, token: cfg.token, email_atual: (window.CaptaUser && CaptaUser.email && CaptaUser.email()) || undefined, ...extra }) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`); return d;
  }
  function monta() {
    if (document.getElementById('lp')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const sc = document.createElement('div'); sc.id = 'lp-scrim'; sc.onclick = fechar; document.body.appendChild(sc);
    const a = document.createElement('aside'); a.id = 'lp'; document.body.appendChild(a);
    document.addEventListener('click', e => { if (!e.target.closest('#lp .rapidas') && !e.target.closest('#lp .ico')) { const b = document.getElementById('lp-rapidas'); if (b) b.innerHTML = ''; } });
  }
  async function etapas() {
    if (cfg.getEtapas) { const e = cfg.getEtapas(); if (e && e.length) return e; }
    if (!S.etapas.length) { try { S.etapas = (await api('funil')).etapas || []; } catch (e) {} }
    return S.etapas;
  }
  async function abrir(id, aba) {
    monta();
    const l = cfg.getLead ? cfg.getLead(id) : null; if (!l) return;
    S = { ...S, lead: l, aba: aba || 'conversa', info: null, agenda: null, idx: { manha:0, tarde:0, sab:0 } };
    document.getElementById('lp').classList.add('aberto'); document.getElementById('lp-scrim').classList.add('on');
    await etapas(); desenhar();
    try { S.info = await api('lead', { lead_id: id }); } catch (e) { S.info = { erro: e.message }; }
    desenhar(); if (S.aba === 'agendar') carregarAgenda();
    clearInterval(S.timerMsg); S.timerMsg = setInterval(async () => { if (S.lead && S.aba === 'conversa') { try { const i = await api('lead', { lead_id: S.lead.id }); const n = (i.mensagens||[]).length; if (n !== (S.info?.mensagens||[]).length) { S.info = i; desenhar(); } } catch (e) {} } }, 15000);
  }
  function fechar() { const a = document.getElementById('lp'); if (a) a.classList.remove('aberto'); const s = document.getElementById('lp-scrim'); if (s) s.classList.remove('on'); S.lead = null; clearTimeout(S.timer); clearInterval(S.timerMsg); }
  function aba(a) { S.aba = a; desenhar(); if (a === 'agendar' && !S.agenda) carregarAgenda(); }

  function desenhar() {
    const l = S.lead; if (!l) return;
    const et = (cfg.getEtapas ? cfg.getEtapas() : S.etapas) || S.etapas; const etAtual = et.find(e => e.id === l.etapa_id);
    const ini = (l.nome || '?').trim().split(/\s+/).map(x => x[0]).slice(0,2).join('').toUpperCase();
    const abas = [['conversa','Conversa'],['dados','Dados'],['agendar','Agendar aula']];
    document.getElementById('lp').innerHTML = `
      <div class="cab"><div class="av">${esc(ini)}</div>
        <div style="min-width:0"><h3>${esc(l.nome || 'Sem nome')}</h3>
          <div class="sub">${esc(l.contato || '')}${l.temperatura ? ' · ' + esc(l.temperatura) : ''}${l.atendente ? ' · ' + esc(l.atendente) : ''}${etAtual ? ' · ' + esc(etAtual.nome) : ''}${l.kommo_lead_id ? ` · <a class="lnk" href="https://roboticanorte.kommo.com/leads/detail/${l.kommo_lead_id}" target="_blank" rel="noopener">Kommo ↗</a>` : ''}</div></div>
        <button class="x" onclick="LeadPainel.fechar()" title="Fechar">×</button></div>
      <div class="abas">${abas.map(([k,t]) => `<button class="${S.aba===k?'on':''}" onclick="LeadPainel.aba('${k}')">${t}</button>`).join('')}</div>
      ${S.aba === 'conversa' ? vConversa(l, et) : S.aba === 'dados' ? vDados(l, et) : vAgendar(l)}`;
    const ta = document.getElementById('lp-txt'); if (ta) { ta.oninput = () => { ta.style.height='auto'; ta.style.height = Math.min(ta.scrollHeight,120)+'px'; if (ta.value === '/') { ta.value=''; rapidas(); } }; ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } }; }
    const ms = document.getElementById('lp-msgs'); if (ms) ms.scrollTop = ms.scrollHeight;
  }
  function chipsEtapa(l, et) {
    return `<div class="sec">Etapa</div><div class="chips">${et.map(e => `<button class="chip ${e.tipo||''} ${l.etapa_id===e.id?'on':''}" onclick="LeadPainel.mudarEtapa('${e.id}')">${esc(e.nome)}</button>`).join('')}</div>`;
  }
  async function mudarEtapa(etapaId) {
    const l = S.lead; if (!l || l.etapa_id === etapaId) return;
    const et = await etapas(); const e = et.find(x => x.id === etapaId); let motivo = null;
    if (e && e.tipo === 'perdida') { motivo = prompt('Motivo da perda (opcional):') || null; }
    const antes = l.etapa_id; l.etapa_id = etapaId; l.etapa_em = new Date().toISOString(); desenhar();
    try { if (cfg.onMover) await cfg.onMover(l, etapaId, motivo); else await api('mover', { lead_id: l.id, etapa_id: etapaId, motivo });
      if (!l.atendente && EU()) { api('campos', { lead_id: l.id, atendente: EU() }).catch(()=>{}); l.atendente = EU(); }
      say(`<b>${esc(l.nome||'Lead')}</b> → ${esc(e ? e.nome : '')} · Kommo atualizado`, { acao:'desfazer', onAcao: () => mudarEtapa(antes) }); }
    catch (err) { l.etapa_id = antes; desenhar(); say(err.message, { tipo:'erro' }); }
  }

  // ---------- Conversa ----------
  function vConversa(l, et) {
    const i = S.info, c = i && i.conversa; const conectado = i && i.canal === 'conectado';
    const acoes = `<div class="acoes">
      ${c ? `<span class="robo ${c.agente_ativo?'on':''}"><i></i>${c.agente_ativo ? 'Robô' : 'Você'}</span>
      <select onchange="LeadPainel.atribuir(this.value)" title="Quem está atendendo"><option value="">— atendente —</option>${[...new Set([...ATEND, EU()].filter(Boolean))].map(a=>`<option ${(c.atendente||EU())===a?'selected':''}>${a}</option>`).join('')}</select>
      ${c.resolvida_em ? `<button onclick="LeadPainel.resolver(false)">Reabrir</button>` : `<button class="ok" onclick="LeadPainel.resolver(true)">Resolver ✓</button>`}` : `<span class="robo"><i></i>${conectado ? 'sem conversa ainda' : 'WhatsApp não conectado'}</span>`}
      <button onclick="LeadPainel.importarTxt()" title="Importar histórico exportado do WhatsApp (.txt)">Importar .txt</button>
      <span style="margin-left:auto;display:flex;gap:6px">${l.contato ? `<a class="lnk" style="font-size:12px" href="https://wa.me/${String(l.contato).replace(/\D/g,'')}" target="_blank" rel="noopener">abrir no WhatsApp ↗</a>` : ''}</span></div>`;
    let corpo;
    if (!i) corpo = `<div class="aviso-p">Carregando…</div>`;
    else if (i.mensagens && i.mensagens.length) corpo = `<div class="msgs" id="lp-msgs">${i.mensagens.map(m => `<div class="msg ${m.direcao==='saida'?'saida':''}">${m.tipo==='imagem'&&m.midia_url ? `<div data-midia="${m.id}" data-tipo="imagem">🖼️ imagem</div>` : m.tipo==='audio'&&m.midia_url ? `<div data-midia="${m.id}" data-tipo="audio">🎤 áudio</div>` : ''}${esc(m.texto || m.transcricao || (m.midia_url ? '' : '['+(m.tipo||'mídia')+']'))}<small>${esc(m.autor||'')} · ${hora(m.criado_em)}</small></div>`).join('')}</div>`;
    else corpo = `<div class="aviso-p">${conectado ? 'Ainda não há conversa com este lead pelo Capta. Escreva abaixo pra começar.' : 'A conversa aparece aqui quando o WhatsApp da unidade estiver conectado.'}${l.kommo_lead_id ? `<br><a class="lnk" href="https://roboticanorte.kommo.com/leads/detail/${l.kommo_lead_id}" target="_blank" rel="noopener">Ver a conversa no Kommo ↗</a>` : ''}</div>`;
    setTimeout(carregarMidias, 50);
    return `${acoes}<div class="corpo">${chipsEtapa(l, et)}<div class="sec">Conversa</div>${corpo}</div>
      ${c && c.agente_ativo ? `<div class="aviso" style="margin:0 18px 8px">Se você responder por aqui, o robô para de responder nesta conversa.</div>` : ''}
      <div id="lp-rapidas"></div>
      ${conectado ? `<div class="escrever"><button class="ico" title="Respostas prontas (ou digite /)" onclick="LeadPainel.rapidas()">⚡</button><button class="ico" title="Anexar" onclick="document.getElementById('lp-anexo').click()">📎</button><input type="file" id="lp-anexo" style="display:none" accept="image/*,audio/*,.pdf,.doc,.docx" onchange="LeadPainel.anexo(this)"><textarea id="lp-txt" rows="1" placeholder="Escreva uma mensagem — / para respostas prontas"></textarea><button class="btn" id="lp-btn" onclick="LeadPainel.enviar()">Enviar</button></div>` : ''}`;
  }
  async function carregarMidias() {
    for (const el of document.querySelectorAll('#lp [data-midia]')) {
      try { const { url } = await api('midia', { mensagem_id: el.dataset.midia }); el.innerHTML = el.dataset.tipo === 'imagem' ? `<img src="${url}" alt="">` : `<audio controls src="${url}"></audio>`; } catch (e) {}
      el.removeAttribute('data-midia');
    }
  }
  async function enviar() {
    const ta = document.getElementById('lp-txt'); const texto = (ta.value||'').trim(); if (!texto || !S.lead) return;
    const btn = document.getElementById('lp-btn'); btn.disabled = true; ta.value = ''; ta.style.height = 'auto';
    try { await api('enviar', { autor: EU() || 'atendente', ...(S.info?.conversa ? { conversa_id: S.info.conversa.id, texto } : { telefone: S.lead.contato, texto }) }); S.info = await api('lead', { lead_id: S.lead.id }); desenhar(); say('Enviado', { tipo:'ok', ms:1500 }); }
    catch (e) { say(e.message, { tipo:'erro' }); btn.disabled = false; }
  }
  async function atribuir(quem) { if (!S.info?.conversa) return; try { await api('conversa_atualizar', { conversa_id: S.info.conversa.id, atendente: quem }); S.info.conversa.atendente = quem || null; say(quem ? `Conversa com ${esc(quem)}` : 'Sem atendente'); } catch (e) { say(e.message, { tipo:'erro' }); } }
  async function resolver(sim) { if (!S.info?.conversa) return; try { await api('conversa_atualizar', { conversa_id: S.info.conversa.id, resolvida: sim }); S.info.conversa.resolvida_em = sim ? new Date().toISOString() : null; desenhar(); say(sim ? 'Conversa resolvida' : 'Conversa reaberta', sim ? { acao:'desfazer', onAcao:() => resolver(false) } : {}); } catch (e) { say(e.message, { tipo:'erro' }); } }
  async function rapidas() {
    if (!S.rapidas) { try { S.rapidas = (await api('respostas')).respostas || []; } catch (e) { S.rapidas = []; } }
    const box = document.getElementById('lp-rapidas'); if (!box) return;
    box.innerHTML = `<div class="rapidas">${S.rapidas.map(r => `<div class="rp" onclick="LeadPainel.usarRapida('${r.id}')"><b>${esc(r.titulo)}</b><small>${esc(r.texto)}</small></div>`).join('')}<div class="rp" style="color:var(--brand);font-weight:700;text-align:center" onclick="LeadPainel.novaRapida()">+ nova resposta pronta</div></div>`;
  }
  function usarRapida(id) { const r = (S.rapidas||[]).find(x => x.id === id); const ta = document.getElementById('lp-txt'); if (r && ta) { const nome = (S.lead.nome||'').split(' ')[0]; ta.value = (ta.value ? ta.value + ' ' : '') + r.texto.replace(/\{nome\}/g, nome); ta.focus(); ta.dispatchEvent(new Event('input')); } const b = document.getElementById('lp-rapidas'); if (b) b.innerHTML = ''; }
  async function novaRapida() { const titulo = prompt('Nome da resposta (ex.: Valor):'); if (!titulo) return; const texto = prompt('Texto ({nome} vira o nome da pessoa):'); if (!texto) return; try { S.rapidas = (await api('respostas', { salvar: { titulo, texto } })).respostas; say('Resposta salva', { tipo:'ok' }); rapidas(); } catch (e) { say(e.message, { tipo:'erro' }); } }
  function anexo(input) {
    const f = input.files && input.files[0]; input.value = ''; if (!f || !S.lead || !S.info?.conversa) return say('Comece a conversa por texto antes de anexar.', { tipo:'erro' });
    if (f.size > 8*1024*1024) return say('Arquivo acima de 8 MB.', { tipo:'erro' });
    const tipo = f.type.startsWith('image/') ? 'imagem' : f.type.startsWith('audio/') ? 'audio' : 'documento';
    const rd = new FileReader(); rd.onload = async () => { try { await api('enviar_midia', { conversa_id: S.info.conversa.id, tipo, dados: rd.result, nome: f.name, legenda: (document.getElementById('lp-txt')?.value||'').trim() || undefined }); S.info = await api('lead', { lead_id: S.lead.id }); desenhar(); say('Enviado', { tipo:'ok' }); } catch (e) { say(e.message, { tipo:'erro' }); } }; rd.readAsDataURL(f);
  }
  function importarTxt() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,text/plain';
    inp.onchange = () => { const f = inp.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => previaImport(rd.result); rd.readAsText(f); };
    inp.click();
  }
  async function previaImport(texto) {
    let pv; try { pv = await api('importar_historico', { texto, previa: true }); } catch (e) { return say(e.message, { tipo:'erro' }); }
    const autores = Object.entries(pv.autores).sort((a,b)=>b[1]-a[1]);
    const box = document.createElement('div'); box.id = 'lp-imp'; box.style.cssText = 'position:fixed;inset:0;background:rgba(20,26,46,.42);display:grid;place-items:center;padding:20px;z-index:90';
    box.innerHTML = `<div style="background:#fff;border-radius:16px;padding:22px;width:100%;max-width:440px;font-family:inherit"><h3 style="font-size:16px;font-weight:700;margin:0">Importar conversa</h3><p style="color:#697089;font-size:13px;margin:6px 0 0;line-height:1.5">${pv.total} mensagens, de ${new Date(pv.de).toLocaleDateString('pt-BR')} a ${new Date(pv.ate).toLocaleDateString('pt-BR')}.<br>Marque quem é <b>a escola</b> (o resto é o lead):</p>
      <div id="lp-imp-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px">${autores.map(([n,q]) => `<button data-n="${esc(n)}" style="border:1px solid #E9ECF3;background:#fff;border-radius:99px;padding:6px 11px;font-size:12.5px;font-weight:600;color:#697089;cursor:pointer;font-family:inherit" onclick="this.dataset.on=this.dataset.on?'':'1';this.style.background=this.dataset.on?'#2E5BFF':'#fff';this.style.color=this.dataset.on?'#fff':'#697089'">${esc(n)} (${q})</button>`).join('')}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px"><button class="btn g" style="border:1px solid #E9ECF3;background:#fff;color:#697089;border-radius:9px;padding:8px 14px;font-weight:700;cursor:pointer;font-family:inherit" onclick="document.getElementById('lp-imp').remove()">Cancelar</button><button id="lp-imp-ok" style="border:0;background:#2E5BFF;color:#fff;border-radius:9px;padding:8px 14px;font-weight:700;cursor:pointer;font-family:inherit">Importar</button></div></div>`;
    document.body.appendChild(box);
    document.getElementById('lp-imp-ok').onclick = async () => {
      const nomes = [...box.querySelectorAll('[data-on="1"]')].map(c => c.dataset.n); if (!nomes.length) return say('Marque quem é a escola.', { tipo:'erro' });
      try { const r = await api('importar_historico', { texto, nomes_escola: nomes, lead_id: S.lead.id, telefone: S.lead.contato }); box.remove(); say(`${r.importadas} mensagens importadas`, { tipo:'ok' }); S.info = await api('lead', { lead_id: S.lead.id }); desenhar(); }
      catch (e) { say(e.message, { tipo:'erro' }); }
    };
  }

  // ---------- Dados ----------
  const sel = (id, ops, v) => `<select id="${id}"><option value="">—</option>${ops.map(o => `<option ${o===v?'selected':''}>${o}</option>`).join('')}</select>`;
  function vDados(l, et) {
    return `<div class="corpo">${chipsEtapa(l, et)}
      <div class="sec">De onde veio o lead</div>
      <div class="l2"><div class="campo"><label>Por onde veio</label>${sel('lp-fonte', FONTES, l.fonte)}</div><div class="campo"><label>Como chegou</label>${sel('lp-porta', PORTAS, l.porta)}</div></div>
      <div class="campo" style="margin-top:8px"><label>Quem atendeu</label>${sel('lp-at', [...new Set([...ATEND, EU()].filter(Boolean))], l.atendente || EU())}</div>
      <div class="sec">Criança</div>
      <div class="l2"><div class="campo"><label>Nome</label><input id="lp-cri" value="${esc(l.crianca||'')}"></div><div class="campo"><label>Idade</label><input id="lp-id" type="number" min="3" max="17" value="${l.idade||''}"></div></div>
      <div class="sec">Anotações</div>
      <div class="campo"><textarea id="lp-notas" placeholder="Ex.: mãe prefere sábado de manhã">${esc(l.notas||'')}</textarea></div>
      <div style="margin-top:10px;display:flex;align-items:center"><button class="btn" onclick="LeadPainel.salvarDados()">Salvar</button><span class="salvo" id="lp-ok"></span></div>
      ${l.tags && l.tags.length ? `<div class="sec">Tags</div><div class="chips">${l.tags.map(t=>`<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${cfg.onExcluir ? `<button class="del" onclick="LeadPainel.excluir()">🗑️ Excluir este lead</button>` : ''}
    </div>`;
  }
  async function salvarDados() {
    const l = S.lead; const g = x => document.getElementById(x).value;
    const d = { lead_id: l.id, fonte: g('lp-fonte'), porta: g('lp-porta'), atendente: g('lp-at'), crianca: g('lp-cri'), idade: g('lp-id'), notas: g('lp-notas') };
    try { await api('campos', d); Object.assign(l, { fonte: d.fonte||null, porta: d.porta||null, atendente: d.atendente||null, crianca: d.crianca||null, idade: d.idade?Number(d.idade):null, notas: d.notas||null });
      const s = document.getElementById('lp-ok'); if (s) { s.textContent = 'salvo ✓'; setTimeout(() => { if (s) s.textContent = ''; }, 2000); } say('Dados salvos · Kommo atualizado', { tipo:'ok', ms:1800 }); cfg.onAtualizou && cfg.onAtualizou(l); }
    catch (e) { say(e.message, { tipo:'erro' }); }
  }
  async function excluir() { if (!S.lead || !cfg.onExcluir) return; if (!confirm(`Excluir ${S.lead.nome || 'este lead'}? Isso não apaga no Kommo.`)) return; try { await cfg.onExcluir(S.lead); fechar(); } catch (e) { say(e.message, { tipo:'erro' }); } }

  // ---------- Agendar ----------
  async function carregarAgenda(silencioso) {
    try { S.agenda = await api('agenda', { dias: 30 }); } catch (e) { if (!silencioso) S.agenda = { erro: e.message }; }
    if (!silencioso) S.idx = { manha:0, tarde:0, sab:0 }; desenhar();
    clearTimeout(S.timer); S.timer = setTimeout(() => { if (S.lead && S.aba === 'agendar') carregarAgenda(true); }, 60000);
  }
  function vagasPor(tipo) {
    const hs = (S.agenda && S.agenda.horarios || []).filter(h => (h.vagas ?? 1) > 0 && h.data > new Date().toISOString().slice(0,10));
    return hs.filter(h => { const dow = new Date(h.data+'T12:00:00').getDay(), hi = parseInt(h.hora_inicio); return tipo==='sab' ? dow===6 : tipo==='manha' ? (dow!==6&&hi<12) : (dow!==6&&hi>=12); }).sort((a,b) => (a.data+a.hora_inicio).localeCompare(b.data+b.hora_inicio));
  }
  function cardVaga(tipo, rotulo) {
    const lista = vagasPor(tipo); const idx = S.idx[tipo] || 0; const v = lista[idx];
    if (!v) return `<div class="vaga"><div class="sec" style="margin:0 0 4px">${rotulo}</div><div class="liv">Sem vaga livre nos próximos 30 dias.</div></div>`;
    return `<div class="vaga"><div class="sec" style="margin:0 0 4px">${rotulo}</div><b>${nomeDia(v.data)} ${dataBR(v.data)} · ${hhmm(v.hora_inicio)}–${hhmm(v.hora_fim)}</b>
      <div class="liv">${v.vagas} de ${v.capacidade} kits First livres${v.sala_livre!=null?' · sala '+v.sala_livre:''} · opção ${idx+1} de ${lista.length}</div>
      <div class="acs"><button class="btn" onclick="LeadPainel.confirmarAgenda('${v.turma_id}','${v.data}')">Agendar nessa</button><button class="btn g" onclick="LeadPainel.idx('${tipo}',${idx+1},${lista.length})" ${idx>=lista.length-1?'disabled':''}>Outra →</button>${idx>0?`<button class="btn g" onclick="LeadPainel.idx('${tipo}',${idx-1},${lista.length})">←</button>`:''}</div></div>`;
  }
  function idx(t, i, n) { S.idx[t] = Math.max(0, Math.min(i, n-1)); desenhar(); }
  function vAgendar(l) {
    const ag = (S.info && S.info.agendamentos || []).filter(a => !['cancelado','remarcado'].includes(a.status) && !a.remarcado_para);
    return `<div class="corpo">
      ${ag.length ? `<div class="sec">Aulas deste lead</div>${ag.map(a => `<div class="ag-item"><span>${nomeDia(a.data)} ${dataBR(a.data)} · ${hhmm(a.hora_inicio)}${a.crianca_nome?' · '+esc(a.crianca_nome):''}</span><span class="st">${esc(a.status)}${['agendado','confirmado'].includes(a.status)?` <a class="lnk" style="color:var(--quente,#E03127);margin-left:6px" onclick="LeadPainel.cancelarAula('${a.id}')">cancelar</a>`:''}</span></div>`).join('')}` : ''}
      <div class="sec">1 · Criança</div>
      <div class="l2"><div class="campo"><label>Nome</label><input id="lp-a-cri" value="${esc(l.crianca||'')}" placeholder="Nome da criança"></div><div class="campo"><label>Idade</label><input id="lp-a-id" type="number" min="3" max="17" value="${l.idade||''}"></div></div>
      <div class="sec">2 · Kit</div><div class="chips"><span class="chip on">First</span><span class="chip" style="border:0;color:var(--faint)">a experimental é sempre no First; o nivelamento é no dia</span></div>
      <div class="sec">3 · Ofereça duas opções</div>
      ${!S.agenda ? `<div class="aviso-p">Buscando vagas…</div>` : S.agenda.erro ? `<div class="aviso-p">${esc(S.agenda.erro)}</div>` : cardVaga('manha','Manhã') + cardVaga('tarde','Tarde') + cardVaga('sab','Sábado')}
      <div class="aviso-p" style="margin-top:10px;border:0;padding:6px 0;text-align:left">Estoque atualiza sozinho a cada minuto e a cada aula marcada.</div></div>`;
  }
  async function confirmarAgenda(turmaId, data) {
    const l = S.lead; const crianca = document.getElementById('lp-a-cri').value.trim(), idade = document.getElementById('lp-a-id').value;
    if (!crianca) { say('Informe o nome da criança.', { tipo:'erro' }); document.getElementById('lp-a-cri').focus(); return; }
    try { await api('agendar', { turma_id: turmaId, data, crianca_nome: crianca, crianca_idade: idade || null, lead_id: l.id });
      if (!l.atendente && EU()) { api('campos', { lead_id: l.id, atendente: EU() }).catch(()=>{}); l.atendente = EU(); }
      l.crianca = crianca; l.idade = idade ? Number(idade) : l.idade; const et = await etapas(); const e = et.find(x => /aula agendada/i.test(x.nome)); if (e) { l.etapa_id = e.id; l.etapa_em = new Date().toISOString(); }
      say(`<b>${esc(crianca)}</b> · aula marcada ${nomeDia(data)} ${dataBR(data)} · lead em Aula agendada · Kommo atualizado`, { tipo:'ok' });
      S.info = await api('lead', { lead_id: l.id }); carregarAgenda(true); cfg.onAgendou && cfg.onAgendou(l); }
    catch (e) { say(e.message, { tipo:'erro' }); }
  }
  async function cancelarAula(id) {
    if (!confirm('Cancelar esta aula experimental?')) return;
    try { await api('presenca', { agendamento_id: id, status: 'cancelado', motivo: 'cancelado pelo atendente' }); S.info = await api('lead', { lead_id: S.lead.id });
      const l = S.lead; const et = await etapas(); const ec = et.find(x => /em contato/i.test(x.nome)); if (ec && !(S.info.agendamentos||[]).some(a => ['agendado','confirmado'].includes(a.status))) { l.etapa_id = l.etapa_anterior_id || ec.id; }
      say('Aula cancelada · kit devolvido · lead voltou de etapa'); carregarAgenda(true); cfg.onAgendou && cfg.onAgendou(l); }
    catch (e) { say(e.message, { tipo:'erro' }); }
  }

  window.LeadPainel = { init: c => { cfg = c || {}; monta(); }, abrir, fechar, aba, mudarEtapa, enviar, atribuir, resolver, rapidas, usarRapida, novaRapida, anexo, importarTxt, salvarDados, excluir, confirmarAgenda, cancelarAula, idx, atual: () => S.lead };
})();
