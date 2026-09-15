/* capta-alerta.js — quem espera resposta há quanto tempo, e o que fazer com isso.
   Usado pela lista de conversas, pela tela do dia e pelo painel (som e aviso). */
(function () {
  // Limites por temperatura, em minutos: [atrasada, urgente]
  // Quente espera menos; frio e morno também têm teto, para ninguém ficar esquecido.
  const LIMITES = { quente: [10, 60], morno: [30, 120], frio: [60, 240], padrao: [10, 90] };

  function minutosEsperando(conv) {
    if (!conv || !conv.aguardando_desde || conv.resolvida_em) return 0;
    return Math.max(0, Math.round((Date.now() - new Date(conv.aguardando_desde)) / 60000));
  }
  // nível: '' | 'atrasada' | 'urgente'
  function nivel(conv) {
    const m = minutosEsperando(conv); if (!m) return '';
    const t = String(conv.lead && conv.lead.temperatura || '').toLowerCase();
    const [a, u] = LIMITES[t] || LIMITES.padrao;
    return m >= u ? 'urgente' : m >= a ? 'atrasada' : '';
  }
  function rotulo(conv) {
    const m = minutosEsperando(conv); if (!m) return '';
    if (m < 60) return `${m} min sem resposta`;
    const h = Math.floor(m / 60), r = m % 60;
    return `${h}h${r ? String(r).padStart(2, '0') : ''} sem resposta`;
  }
  // peso para ordenar: urgente > atrasada > resto; dentro, quente antes; depois mais antigo
  function peso(conv) {
    const n = nivel(conv), t = String(conv.lead && conv.lead.temperatura || '').toLowerCase();
    const base = n === 'urgente' ? 3000 : n === 'atrasada' ? 2000 : (conv.nao_lidas > 0 ? 1000 : 0);
    const temp = t === 'quente' ? 300 : t === 'morno' ? 200 : t === 'frio' ? 100 : 150;
    return base + temp + Math.min(minutosEsperando(conv), 99) / 100;
  }
  function etiqueta(conv) {
    const n = nivel(conv); if (!n) return '';
    return `<span class="al-tag ${n}" title="${rotulo(conv)}">${n === 'urgente' ? '⏰ ' : '⏱ '}${rotulo(conv)}</span>`;
  }

  // ---- som e aviso do navegador ----
  let ctx = null;
  function tocar(tipo) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      const agora = ctx.currentTime;
      const notas = tipo === 'urgente' ? [880, 660, 880] : tipo === 'atrasada' ? [660, 880] : [523, 784];
      notas.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, agora + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.25, agora + i * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, agora + i * 0.16 + 0.15);
        o.connect(g); g.connect(ctx.destination); o.start(agora + i * 0.16); o.stop(agora + i * 0.16 + 0.16);
      });
    } catch (e) {}
  }
  function pedirPermissao() { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }
  function avisar(titulo, corpo, chave) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const n = new Notification(titulo, { body: corpo, tag: chave, icon: '/icon-192.png', renotify: false });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) {}
  }

  // já avisou este nível desta conversa? (não repete a cada 30 s)
  const K = 'capta_avisos';
  function jaAvisou(id, n) { try { const m = JSON.parse(localStorage.getItem(K) || '{}'); return m[id] === n; } catch (e) { return false; } }
  function marcaAviso(id, n) { try { const m = JSON.parse(localStorage.getItem(K) || '{}'); m[id] = n; const ks = Object.keys(m); if (ks.length > 500) ks.slice(0, 200).forEach(k => delete m[k]); localStorage.setItem(K, JSON.stringify(m)); } catch (e) {} }

  // Chamado a cada atualização da lista. Compara com a anterior: mensagem nova
  // toca o som; limite cruzado gera aviso e som mais forte.
  let anterior = null;
  function processar(convs, opts) {
    opts = opts || {};
    const atuais = {}; (convs || []).forEach(c => atuais[c.id] = c);
    let novas = 0, cruzaram = [];
    for (const c of convs || []) {
      const a = anterior && anterior[c.id];
      if (a && (c.nao_lidas || 0) > (a.nao_lidas || 0)) novas++;
      if (!anterior && (c.nao_lidas || 0) > 0 && opts.primeiraVez) {/* não toca no carregamento */}
      const n = nivel(c);
      if (n && !jaAvisou(c.id, n)) { cruzaram.push({ c, n }); marcaAviso(c.id, n); }
    }
    if (anterior && novas) { tocar('nova'); if (opts.avisarNovas !== false) avisar('Nova mensagem', `${novas} conversa${novas > 1 ? 's' : ''} com mensagem nova`, 'novas'); }
    if (cruzaram.length) {
      const urg = cruzaram.filter(x => x.n === 'urgente');
      if (urg.length) { tocar('urgente'); avisar('Lead esperando há muito tempo', urg.map(x => (x.c.lead && x.c.lead.nome) || x.c.nome || x.c.telefone).slice(0, 3).join(', ') + (urg.length > 3 ? ` +${urg.length - 3}` : ''), 'urgente'); }
      else { tocar('atrasada'); }
    }
    anterior = atuais;
    return { novas, cruzaram };
  }

  window.CaptaAlerta = { LIMITES, minutosEsperando, nivel, rotulo, peso, etiqueta, tocar, avisar, pedirPermissao, processar };
  const CSS = `
  .al-tag{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;font-weight:800;border-radius:99px;padding:2px 8px;white-space:nowrap}
  .al-tag.atrasada{background:#FFF3C4;color:#8a5a06}
  .al-tag.urgente{background:#FDE2E0;color:#B3261E;animation:al-pisca 1.6s ease-in-out infinite}
  .conv.urgente{background:rgba(224,49,39,.05)}
  .conv.atrasada{background:rgba(224,147,15,.05)}
  @keyframes al-pisca{0%,100%{opacity:1}50%{opacity:.55}}`;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
})();
