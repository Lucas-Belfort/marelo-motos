// =====================================================================
//  Camada de banco - versao POSTGRESQL (Supabase)
//
//  Usada quando a variavel de ambiente DATABASE_URL existe (na Vercel).
//  Oferece as mesmas funcoes de banco.js (todos, um, executar,
//  emTransacao...), entao api.js, auth.js e regras.js nao mudam.
//  O SQL escrito para o SQLite e traduzido em traduzir-sql.js.
// =====================================================================

import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import 'pg'; // garante que a Vercel empacote o driver usado pelo trabalhador
import { traduzir } from './traduzir-sql.js';

const ESPERA_MAXIMA = 25000; // ms

let ponte = null;
let emTransacaoAgora = false;

function abrirPonte() {
  if (ponte) return ponte;
  const sinal = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  const trabalhador = new Worker(new URL('./pg-trabalhador.js', import.meta.url), {
    workerData: { porta: port2, sinal, url: process.env.DATABASE_URL },
    transferList: [port2],
  });
  trabalhador.unref();
  port1.unref();
  ponte = { trabalhador, porta: port1, estado: new Int32Array(sinal) };
  return ponte;
}

// Executa um SQL ja traduzido e espera a resposta (de forma sincrona)
function rodar(sqlPronto) {
  const { porta, estado } = abrirPonte();
  Atomics.store(estado, 0, 0);
  porta.postMessage({ sql: sqlPronto, emTransacao: emTransacaoAgora });
  const r = Atomics.wait(estado, 0, 0, ESPERA_MAXIMA);
  if (r === 'timed-out') throw new Error('O banco de dados demorou demais para responder.');
  const msg = receiveMessageOnPort(porta)?.message;
  if (!msg) throw new Error('Sem resposta do banco de dados.');
  if (!msg.ok) throw erroAmigavel(msg.erro);
  return msg;
}

// Mensagens no mesmo formato do SQLite, que servidor.js ja sabe tratar
function erroAmigavel(e) {
  const erro = new Error(
    e.code === '23505' ? `UNIQUE constraint failed (${e.detail || ''})`
      : e.code === '23503' ? `FOREIGN KEY constraint failed (${e.detail || ''})`
        : e.code === '23514' ? `CHECK constraint failed (${e.message})`
          : e.message);
  erro.code = e.code;
  return erro;
}

function consultar(sql, params) {
  return rodar(traduzir(sql, params));
}

let preparado = false;
export function abrirBanco(ao_preparar) {
  if (!preparado) {
    preparado = true;
    ao_preparar?.();
  }
  return objetoBanco;
}

export function todos(sql, ...params) { return consultar(sql, params).rows; }
export function um(sql, ...params) { return consultar(sql, params).rows[0]; }
export function executar(sql, ...params) {
  const r = consultar(sql, params);
  return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id ?? 0 };
}

// Mesmo formato do node:sqlite: banco.prepare(sql).get/all/run
const objetoBanco = {
  prepare: (sql) => ({
    get: (...p) => um(sql, ...p),
    all: (...p) => todos(sql, ...p),
    run: (...p) => executar(sql, ...p),
  }),
  exec: (sql) => rodar(sql),
};

export function emTransacao(fn) {
  rodar('BEGIN');
  emTransacaoAgora = true;
  try {
    const resultado = fn(objetoBanco);
    rodar('COMMIT');
    return resultado;
  } catch (erro) {
    try { rodar('ROLLBACK'); } catch { /* conexao perdida: o PG desfaz sozinho */ }
    throw erro;
  } finally {
    emTransacaoAgora = false;
  }
}

export function fecharBanco() {
  if (!ponte) return;
  ponte.trabalhador.terminate();
  ponte = null;
}

// Sessoes de login guardadas no banco: na Vercel cada acesso pode cair
// em uma instancia diferente, entao a memoria do processo nao serve.
export function guardarSessao(token, usuario, expiraEm) {
  executar('INSERT INTO sessao (token, usuario, expira_em) VALUES (?, ?, ?)',
    token, JSON.stringify(usuario), expiraEm);
  executar('DELETE FROM sessao WHERE expira_em < ?', Date.now());
}
export function lerSessao(token) {
  const s = um('SELECT usuario, expira_em FROM sessao WHERE token = ?', token);
  if (!s) return null;
  if (Number(s.expira_em) < Date.now()) { apagarSessao(token); return null; }
  return { usuario: JSON.parse(s.usuario), expiraEm: Number(s.expira_em) };
}
export function apagarSessao(token) {
  executar('DELETE FROM sessao WHERE token = ?', token);
}
