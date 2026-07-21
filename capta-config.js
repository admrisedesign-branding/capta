// /api/capta-config.js — Vercel Serverless Function (Node 18+, CommonJS)
// Habilitador: diz ao painel quais recursos estão ligados no ambiente.
// NÃO chama IA, NÃO gasta crédito — só reporta se as chaves existem.
//
// GET -> { maya: true|false, notify: true|false }
//   maya   = a IA (Maya) está disponível? (existe ANTHROPIC_API_KEY)
//   notify = aviso de lead por e-mail está ligado? (existe RESEND_API_KEY)

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    maya:   !!process.env.ANTHROPIC_API_KEY,
    notify: !!process.env.RESEND_API_KEY,
  });
};
