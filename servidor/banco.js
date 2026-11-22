// =====================================================================
//  Camada de banco de dados
//  Abre o arquivo SQLite, aplica o schema e, na primeira execucao,
//  carrega os dados de teste. Nenhuma dependencia externa: usa o
//  modulo node:sqlite que ja vem no Node 22+.
// =====================================================================

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PASTA_BANCO = join(AQUI, '..', 'banco');
const ARQUIVO_BANCO = process.env.MARELO_DB || join(PASTA_BANCO, 'marelo.db');

export const SENHA_PADRAO = 'marelo123';

// ---------------------------------------------------------------------
// Qual banco usar
//   - com a variavel DATABASE_URL (Vercel): PostgreSQL do Supabase
//   - sem ela (no computador, nos testes): arquivo SQLite, como sempre
// ---------------------------------------------------------------------
export const MODO = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
const pg = MODO === 'postgres' ? await import('./banco-postgres.js') : null;
const { DatabaseSync } = MODO === 'sqlite' ? await import('node:sqlite') : {};

let db;

// ---------------------------------------------------------------------
// Senhas: guardadas como scrypt, no formato "salto:hash".
// O sistema nunca armazena nem devolve a senha em texto puro (RNFS-01).
// ---------------------------------------------------------------------
export function gerarHash(senha) {
  const salto = randomBytes(16).toString('hex');
  const hash = scryptSync(senha, salto, 64).toString('hex');
  return `${salto}:${hash}`;
}

// Sorteia o identificador da sessao (RNFS-01)
export function gerarToken() {
  return randomBytes(24).toString('hex');
}

export function conferirSenha(senha, armazenado) {
  if (!armazenado || !armazenado.includes(':')) return false;
  const [salto, hash] = armazenado.split(':');
  const tentativa = scryptSync(senha, salto, 64);
  const guardado = Buffer.from(hash, 'hex');
  if (tentativa.length !== guardado.length) return false;
  return timingSafeEqual(tentativa, guardado);
}

// ---------------------------------------------------------------------
// Abertura e preparo do banco
// ---------------------------------------------------------------------
export function abrirBanco() {
  if (pg) return pg.abrirBanco(definirSenhasPendentes);
  if (db) return db;

  mkdirSync(PASTA_BANCO, { recursive: true });
  const primeiraVez = !existsSync(ARQUIVO_BANCO);

  db = new DatabaseSync(ARQUIVO_BANCO);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  // O schema usa "IF NOT EXISTS", entao pode ser aplicado sempre.
  db.exec(readFileSync(join(PASTA_BANCO, 'schema.sql'), 'utf8'));

  if (primeiraVez) {
    console.log('  Banco novo detectado — carregando os dados de teste...');
    db.exec(readFileSync(join(PASTA_BANCO, 'seed.sql'), 'utf8'));
    definirSenhasPendentes();
    console.log('  Dados de teste carregados.');
  } else {
    definirSenhasPendentes();
  }

  return db;
}

// O seed.sql grava 'DEFINIR' na coluna senha_hash; aqui a senha padrao
// vira hash de verdade. Assim o arquivo .sql nunca contem senha.
function definirSenhasPendentes() {
  const pendentes = todos("SELECT id FROM usuario WHERE senha_hash = 'DEFINIR'");
  if (pendentes.length === 0) return;
  for (const u of pendentes) executar('UPDATE usuario SET senha_hash = ? WHERE id = ?', gerarHash(SENHA_PADRAO), u.id);
}

// ---------------------------------------------------------------------
// Atalhos de consulta
// ---------------------------------------------------------------------
export function todos(sql, ...params) {
  if (pg) { abrirBanco(); return pg.todos(sql, ...params); }
  return abrirBanco().prepare(sql).all(...params);
}

export function um(sql, ...params) {
  if (pg) { abrirBanco(); return pg.um(sql, ...params); }
  return abrirBanco().prepare(sql).get(...params);
}

export function executar(sql, ...params) {
  if (pg) { abrirBanco(); return pg.executar(sql, ...params); }
  return abrirBanco().prepare(sql).run(...params);
}

// Executa varias operacoes como uma unica transacao. Se qualquer passo
// falhar, nada e gravado — usado no fechamento da venda (RF-04).
export function emTransacao(fn) {
  if (pg) { abrirBanco(); return pg.emTransacao(fn); }
  const banco = abrirBanco();
  banco.exec('BEGIN');
  try {
    const resultado = fn(banco);
    banco.exec('COMMIT');
    return resultado;
  } catch (erro) {
    banco.exec('ROLLBACK');
    throw erro;
  }
}

// Fecha o banco e libera o arquivo. No Windows, o arquivo so pode ser
// apagado depois disso — usado ao final dos testes automatizados.
export function fecharBanco() {
  if (pg) return pg.fecharBanco();
  if (!db) return;
  try { db.close(); } catch { /* ja estava fechado */ }
  db = undefined;
}

export function parametro(chave, padrao = null) {
  const linha = um('SELECT valor FROM parametro WHERE chave = ?', chave);
  return linha ? linha.valor : padrao;
}

// ---------------------------------------------------------------------
// Copia de seguranca da base (RNFS-06)
// ---------------------------------------------------------------------
export function gerarBackup() {
  // No Supabase a copia de seguranca diaria e feita pela propria plataforma
  if (pg) return 'Backup diário automático do Supabase';
  const pasta = join(PASTA_BANCO, 'backups');
  mkdirSync(pasta, { recursive: true });
  const carimbo = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const destino = join(pasta, `marelo-${carimbo}.db`);
  abrirBanco().exec(`VACUUM INTO '${destino.replaceAll('\\', '/').replaceAll("'", "''")}'`);
  return destino;
}

// ---------------------------------------------------------------------
// Sessoes de login: em memoria no SQLite (um processo so) e no banco
// no Supabase (a Vercel roda varias instancias, sem memoria comum).
// ---------------------------------------------------------------------
const SESSOES = new Map();
export function guardarSessao(token, usuario, expiraEm) {
  if (pg) { abrirBanco(); return pg.guardarSessao(token, usuario, expiraEm); }
  SESSOES.set(token, { usuario, expiraEm });
}
export function lerSessao(token) {
  if (pg) { abrirBanco(); return pg.lerSessao(token); }
  return SESSOES.get(token) || null;
}
export function apagarSessao(token) {
  if (pg) { abrirBanco(); return pg.apagarSessao(token); }
  SESSOES.delete(token);
}

export { ARQUIVO_BANCO };
