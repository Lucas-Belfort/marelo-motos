// =====================================================================
//  Build da Vercel (chamado pelo vercel.json)
//
//  - Com DATABASE_URL configurada na Vercel: publica as telas de verdade
//    (pasta publico/) e a funcao api/index.js grava no Supabase.
//  - Sem ela: publica a demonstracao que roda inteira no navegador,
//    igual ao GitHub Pages (assim o site nunca fica fora do ar).
// =====================================================================

import { cpSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const SITE = join(RAIZ, 'site');

if (!process.env.DATABASE_URL) {
  console.log('  DATABASE_URL nao configurada: publicando a demonstracao (banco no navegador).');
  await import('./gerar-site.js');
} else {
  console.log('  DATABASE_URL configurada: publicando o sistema ligado ao Supabase.');
  if (existsSync(SITE)) rmSync(SITE, { recursive: true, force: true });
  cpSync(join(RAIZ, 'publico'), SITE, { recursive: true });
  const app = join(SITE, 'app.html');
  writeFileSync(app, readFileSync(app, 'utf8').replace(
    '<span id="rodape-banco">Dados fictícios, a confirmar na visita à loja</span>',
    '<span id="rodape-banco">Banco de dados: Supabase (PostgreSQL)</span>'));
  console.log('  Pronto: site/ com as telas do sistema');
}
