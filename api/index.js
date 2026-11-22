// =====================================================================
//  Funcao da Vercel: atende todas as chamadas /api/...
//
//  O vercel.json redireciona /api/<rota> para /api?rota=<rota>; aqui o
//  caminho original e remontado e entregue ao mesmo tratador usado pelo
//  servidor local (servidor/http.js). O banco e o PostgreSQL do Supabase,
//  escolhido por banco.js porque a variavel DATABASE_URL existe.
// =====================================================================

import { tratarApi, responder } from '../servidor/http.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const rota = url.searchParams.get('rota') || '';
  url.searchParams.delete('rota');
  const caminho = '/api/' + rota.replace(/^\/+/, '');

  if (!process.env.DATABASE_URL) {
    return responder(res, 500, {
      erro: 'Banco nao configurado: falta a variavel DATABASE_URL na Vercel.',
    });
  }
  return tratarApi(req, res, caminho, url);
}
