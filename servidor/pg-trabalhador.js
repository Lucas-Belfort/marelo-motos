// =====================================================================
//  Trabalhador do PostgreSQL (roda em uma thread separada)
//
//  O driver "pg" so funciona de forma assincrona, mas o resto do sistema
//  (api.js, auth.js, regras.js) foi escrito com consultas sincronas.
//  A ponte e esta: a thread principal manda o SQL para ca e espera com
//  Atomics.wait; esta thread executa no Supabase, devolve o resultado e
//  acorda a principal. Uma unica conexao atende tudo, em ordem, o que
//  tambem garante que BEGIN ... COMMIT aconteca na mesma conexao.
// =====================================================================

import { workerData } from 'node:worker_threads';
import pg from 'pg';

// Numeros grandes (COUNT, SUM) e NUMERIC chegam como texto no pg.
// O sistema espera numeros, como no SQLite.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

const { porta, sinal, url } = workerData;
const estado = new Int32Array(sinal);
let cliente = null;

async function conectar() {
  cliente = new pg.Client({
    connectionString: url,
    // O Supabase exige conexao criptografada (TLS). "sslmode=disable" na
    // URL so serve para testar com um PostgreSQL local, sem TLS.
    ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
    application_name: 'marelo-motos',
  });
  cliente.on('error', () => { cliente = null; });
  await cliente.connect();
}

function responder(mensagem) {
  porta.postMessage(mensagem);
  Atomics.store(estado, 0, 1);
  Atomics.notify(estado, 0);
}

porta.on('message', async ({ sql, emTransacao }) => {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      if (!cliente) await conectar();
      const r = await cliente.query(sql);
      const ultimo = Array.isArray(r) ? r[r.length - 1] : r;
      return responder({ ok: true, rows: ultimo.rows || [], rowCount: ultimo.rowCount ?? 0 });
    } catch (erro) {
      const caiu = !cliente || /terminated|ECONNRESET|Connection|closed/i.test(String(erro.message));
      // Reconecta uma vez se a conexao caiu, mas nunca no meio de uma
      // transacao (o que ja foi feito nela se perdeu junto).
      if (caiu && tentativa === 1 && !emTransacao) {
        try { await cliente?.end(); } catch { /* ja fechada */ }
        cliente = null;
        continue;
      }
      return responder({ ok: false, erro: { message: erro.message, code: erro.code, detail: erro.detail } });
    }
  }
});
