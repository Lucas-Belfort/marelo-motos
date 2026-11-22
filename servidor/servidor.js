// =====================================================================
//  MARELO MOTOS - Servidor
//
//  Sobe o sistema em http://localhost:7820
//  Sem nenhuma biblioteca externa: so o que ja vem no Node.
// =====================================================================

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { abrirBanco, ARQUIVO_BANCO } from './banco.js';
import { tratarApi } from './http.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PASTA_PUBLICA = join(AQUI, '..', 'publico');
const PORTA = Number(process.env.PORT) || 7820;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function servirArquivo(res, caminhoUrl) {
  let relativo = decodeURIComponent(caminhoUrl.split('?')[0]);
  if (relativo === '/') relativo = '/index.html';

  // impede sair da pasta publica
  const destino = join(PASTA_PUBLICA, normalize(relativo).replace(/^(\.\.[/\\])+/, ''));
  if (!destino.startsWith(PASTA_PUBLICA)) {
    res.writeHead(403).end('Acesso negado');
    return;
  }

  try {
    const informacao = await stat(destino);
    if (!informacao.isFile()) throw new Error('nao e arquivo');
    const conteudo = await readFile(destino);
    res.writeHead(200, {
      'Content-Type': TIPOS[extname(destino).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(conteudo);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>Pagina nao encontrada. <a href="/">Voltar ao inicio</a></p>');
  }
}

// ---------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------
const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const caminho = url.pathname;

  if (!caminho.startsWith('/api/')) {
    return servirArquivo(res, req.url);
  }

  return tratarApi(req, res, caminho, url);
});

abrirBanco();

servidor.listen(PORTA, () => {
  console.log('');
  console.log('  ===================================================');
  console.log('   MARELO MOTOS - Sistema de Gestao (prototipo)');
  console.log('  ===================================================');
  console.log('');
  console.log(`   Abra no navegador:  http://localhost:${PORTA}`);
  console.log(`   Banco de dados:     ${ARQUIVO_BANCO}`);
  console.log('');
  console.log('   Usuarios de teste (senha: marelo123)');
  console.log('     marcelo@marelomotos.com.br   - Dono');
  console.log('     rodrigo@marelomotos.com.br   - Vendedor');
  console.log('     claudia@marelomotos.com.br   - Financeiro');
  console.log('');
  console.log('   Para encerrar: feche esta janela ou tecle Ctrl + C');
  console.log('');
});
