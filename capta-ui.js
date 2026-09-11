/* capta-ui.js — peças de interface compartilhadas.
   Hoje: o balão de ajuda (ⓘ), que precisa flutuar por cima de colunas com rolagem. */
(function () {
  const CSS = `
  .ajuda{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;
    border:1.5px solid var(--faint,#9AA1B4);color:var(--faint,#9AA1B4);font-size:10.5px;font-weight:800;cursor:help;
    margin-left:6px;flex:0 0 16px;font-style:normal;vertical-align:middle;background:transparent;line-height:1;
    text-transform:none;letter-spacing:0;padding:0}
  .ajuda:hover,.ajuda:focus{border-color:var(--brand,#2E5BFF);color:var(--brand,#2E5BFF);outline:none}
  #dica-flutua{position:fixed;z-index:9999;background:#141A2E;color:#fff;border-radius:10px;padding:10px 13px;
    font-size:12.5px;font-weight:500;line-height:1.55;max-width:300px;box-shadow:0 10px 30px rgba(20,26,46,.28);
    opacity:0;visibility:hidden;transition:opacity .12s;pointer-events:none;font-family:inherit;text-align:left;
    text-transform:none;letter-spacing:0}
  #dica-flutua.on{opacity:1;visibility:visible}
  #dica-flutua b{color:#fff}
  #dica-flutua:after{content:'';position:absolute;border:6px solid transparent}
  #dica-flutua.abaixo:after{bottom:100%;border-bottom-color:#141A2E;left:var(--seta,16px)}
  #dica-flutua.acima:after{top:100%;border-top-color:#141A2E;left:var(--seta,16px)}
  @media(max-width:760px){#dica-flutua{max-width:78vw}}
  `;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  let cx = null;
  function caixa() {
    if (cx) return cx;
    cx = document.createElement('div'); cx.id = 'dica-flutua'; document.body.appendChild(cx); return cx;
  }
  function mostrar(el) {
    const txt = el.getAttribute('data-dica'); if (!txt) return;
    const c = caixa(); c.innerHTML = txt; c.className = 'on';
    const r = el.getBoundingClientRect();
    c.style.left = '0px'; c.style.top = '0px';              // mede antes de posicionar
    const w = c.offsetWidth, h = c.offsetHeight, margem = 10;
    let left = Math.min(Math.max(margem, r.left + r.width / 2 - w / 2), innerWidth - w - margem);
    const cabeEmbaixo = r.bottom + h + 14 < innerHeight;
    const top = cabeEmbaixo ? r.bottom + 9 : r.top - h - 9;
    c.classList.add(cabeEmbaixo ? 'abaixo' : 'acima');
    c.style.setProperty('--seta', Math.max(8, Math.min(r.left + r.width / 2 - left - 6, w - 20)) + 'px');
    c.style.left = left + 'px'; c.style.top = top + 'px';
  }
  function esconder() { if (cx) cx.className = ''; }
  document.addEventListener('mouseover', e => { const a = e.target.closest && e.target.closest('.ajuda'); if (a) mostrar(a); });
  document.addEventListener('mouseout', e => { if (e.target.closest && e.target.closest('.ajuda')) esconder(); });
  document.addEventListener('focusin', e => { const a = e.target.closest && e.target.closest('.ajuda'); if (a) mostrar(a); });
  document.addEventListener('focusout', esconder);
  document.addEventListener('click', e => {                 // toque no celular
    const a = e.target.closest && e.target.closest('.ajuda');
    if (a) { e.preventDefault(); e.stopPropagation(); if (cx && cx.classList.contains('on')) esconder(); else mostrar(a); }
    else esconder();
  }, true);
  addEventListener('scroll', esconder, true);
  // helper para as telas montarem o ícone
  window.ajudaHTML = txt => `<span class="ajuda" tabindex="0" role="button" aria-label="Ajuda" data-dica="${String(txt).replace(/"/g, '&quot;')}">i</span>`;
})();
