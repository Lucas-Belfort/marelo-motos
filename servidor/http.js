// =====================================================================
//  Tratamento das chamadas /api/...
//
//  Usado por dois "servidores": servidor.js (no computador, porta 7820)
//  e api/index.js (funcao da Vercel). Assim a regra de permissao, o
//  cookie de sessao e as mensagens de erro sao os mesmos nos dois.
// =====================================================================

import { encontrarRota, pode, usuarioDaSessao } from './api.js';
import { lerTokenDoCookie } from './auth.js';
import { ErroDeRegra } from './regras.js';

// Na Vercel o site e HTTPS: o cookie so trafega criptografado
const SEGURO = process.env.VERCEL ? '; Secure' : '';

export function responder(res, status, dados, cabecalhos = {}) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...cabecalhos,
  });
  res.end(corpo);
}

async function lerCorpo(req) {
  // Na Vercel o corpo ja chega lido em req.body
  if (process.env.VERCEL) {
    if (req.method === 'GET' || req.method === 'DELETE') return {};
    let corpo;
    try { corpo = req.body; } catch {
      throw new ErroDeRegra('Os dados enviados não estao em um formato válido.');
    }
    if (corpo === undefined || corpo === null) return {};
    if (typeof corpo === 'string' || Buffer.isBuffer(corpo)) {
      try { return String(corpo) ? JSON.parse(String(corpo)) : {}; } catch {
        throw new ErroDeRegra('Os dados enviados não estao em um formato válido.');
      }
    }
    return corpo;
  }
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const partes = [];
  for await (const parte of req) partes.push(parte);
  if (partes.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8'));
  } catch {
    throw new ErroDeRegra('Os dados enviados não estao em um formato válido.');
  }
}

export async function tratarApi(req, res, caminho, url) {
  try {
    const alvo = encontrarRota(req.method, caminho);
    if (!alvo) return responder(res, 404, { erro: 'Recurso nao encontrado.' });

    const token = lerTokenDoCookie(req.headers.cookie);
    const usuario = usuarioDaSessao(token);

    // rotas com permissao null sao publicas (apenas o login)
    if (alvo.permissao !== null) {
      if (!usuario) {
        return responder(res, 401, { erro: 'Sessao encerrada. Entre novamente.' });
      }
      if (alvo.permissao !== 'livre' && !pode(usuario, alvo.permissao)) {
        return responder(res, 403, {
          erro: 'Seu perfil de acesso nao permite esta operacao.',
          permissaoExigida: alvo.permissao,
        });
      }
    }

    const corpo = await lerCorpo(req);
    const query = Object.fromEntries(url.searchParams);
    const resultado = alvo.manipulador({
      params: alvo.params, corpo, query, usuario, token, req,
    });

    // o login devolve o token: vira cookie de sessao
    if (caminho === '/api/login' && resultado?.token) {
      return responder(res, 200, resultado, {
        'Set-Cookie': `marelo_sessao=${resultado.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${SEGURO}`,
      });
    }
    if (caminho === '/api/sair') {
      return responder(res, 200, resultado, {
        'Set-Cookie': `marelo_sessao=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SEGURO}`,
      });
    }

    return responder(res, 200, resultado ?? { ok: true });
  } catch (erro) {
    if (erro instanceof ErroDeRegra) {
      return responder(res, erro.status || 400, { erro: erro.message });
    }
    // erro de restricao do banco vira mensagem legivel
    const texto = String(erro?.message || erro);
    if (texto.includes('UNIQUE constraint')) {
      return responder(res, 400, { erro: 'Ja existe um registro com este dado unico.' });
    }
    if (texto.includes('invalid input syntax')) {
      return responder(res, 400, { erro: 'Algum dado foi enviado em formato inválido.' });
    }
    if (texto.includes('FOREIGN KEY')) {
      return responder(res, 400, { erro: 'Registro vinculado a outro cadastro.' });
    }
    console.error('[erro]', erro);
    return responder(res, 500, { erro: 'Erro interno do sistema. Verifique o terminal.' });
  }
}
