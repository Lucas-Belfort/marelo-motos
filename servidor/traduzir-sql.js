// =====================================================================
//  Tradutor de SQL: dialeto SQLite -> PostgreSQL
//
//  O sistema foi escrito para o SQLite. Para gravar no Supabase
//  (PostgreSQL) sem reescrever as consultas de api.js, auth.js e
//  regras.js, cada comando passa por aqui antes de ir ao banco.
//
//  Converte:
//    date(...), datetime(...)    -> to_char(... , 'YYYY-MM-DD[ HH24:MI:SS]')
//    strftime('%Y-%m', x)        -> to_char(x::timestamp, 'YYYY-MM')
//    julianday(x)                -> (x)::date   (diferenca = dias)
//    LIKE / COLLATE NOCASE       -> ILIKE       (o LIKE do SQLite ignora
//                                                maiusculas; o do PG nao)
//    IFNULL                      -> COALESCE
//    ?                           -> valor ja escapado (ver literal())
//    INSERT sem RETURNING        -> INSERT ... RETURNING id
//
//  As datas continuam gravadas como texto 'AAAA-MM-DD', exatamente como
//  no SQLite, para que as comparacoes das consultas funcionem igual.
// =====================================================================

const FUSO = "'America/Sao_Paulo'";
const AGORA = `(now() AT TIME ZONE ${FUSO})`;

// Tabelas cuja chave primaria nao se chama "id"
const SEM_ID = new Set(['parametro', 'sessao']);

// ---------------------------------------------------------------------
// Valor JavaScript -> literal SQL seguro
//   O texto e colocado entre aspas simples com as aspas internas
//   dobradas. O Supabase usa standard_conforming_strings = on, entao a
//   barra invertida nao tem significado especial dentro de '...'.
// ---------------------------------------------------------------------
export function literal(valor) {
  if (valor === null || valor === undefined) return 'NULL';
  if (typeof valor === 'boolean') return valor ? '1' : '0';
  if (typeof valor === 'bigint') return valor.toString();
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return 'NULL';
    return valor < 0 ? `(${valor})` : String(valor);
  }
  const texto = String(valor).replace(/\u0000/g, '\u0001'); // o PG nao aceita o byte zero
  return "'" + texto.replace(/'/g, "''") + "'";
}

// Percorre o SQL pulando o que esta entre aspas
function* trechos(sql) {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      yield { tipo: 'aspas', texto: sql.slice(i, j + 1) };
      i = j + 1;
    } else {
      let j = i;
      while (j < sql.length && sql[j] !== "'" && sql[j] !== '"') j++;
      yield { tipo: 'codigo', texto: sql.slice(i, j) };
      i = j;
    }
  }
}

// Separa os argumentos de uma chamada, respeitando parenteses e aspas.
// Devolve { args, fim } com fim = indice logo apos o ")" de fechamento.
function lerArgumentos(sql, inicio) {
  const args = [];
  let nivel = 0, atual = '', i = inicio;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      atual += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '(') nivel++;
    if (c === ')') {
      if (nivel === 0) { args.push(atual.trim()); return { args, fim: i + 1 }; }
      nivel--;
    }
    if (c === ',' && nivel === 0) { args.push(atual.trim()); atual = ''; i++; continue; }
    atual += c; i++;
  }
  throw new Error('SQL com parenteses desbalanceados: ' + sql.slice(0, 80));
}

function dataComModificadores(args) {
  const [base, ...mods] = args;
  let expr = /^'now'$/i.test(base) ? AGORA : `(NULLIF(${base}, ''))::timestamp`;
  for (const m of mods) {
    if (/^'localtime'$/i.test(m) || /^'utc'$/i.test(m)) continue;
    if (/^'start of month'$/i.test(m)) { expr = `date_trunc('month', ${expr})`; continue; }
    if (/^'start of year'$/i.test(m)) { expr = `date_trunc('year', ${expr})`; continue; }
    expr = `(${expr} + (${m})::interval)`;
  }
  return expr;
}

const FUNCOES = {
  date: (a) => `to_char(${dataComModificadores(a)}, 'YYYY-MM-DD')`,
  datetime: (a) => `to_char(${dataComModificadores(a)}, 'YYYY-MM-DD HH24:MI:SS')`,
  strftime: (a) => {
    const formato = a[0].replace(/^'|'$/g, '')
      .replace('%Y', 'YYYY').replace('%m', 'MM').replace('%d', 'DD')
      .replace('%H', 'HH24').replace('%M', 'MI').replace('%S', 'SS');
    return `to_char(${dataComModificadores(a.slice(1))}, '${formato}')`;
  },
  julianday: (a) => `(${dataComModificadores(a)})::date`,
  ifnull: (a) => `COALESCE(${a.join(', ')})`,
};

// Troca as funcoes do SQLite, de dentro para fora
function trocarFuncoes(sql) {
  let saida = '';
  let i = 0;
  const nome = /\b(date|datetime|strftime|julianday|ifnull)\s*\(/iy;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      saida += sql.slice(i, j + 1); i = j + 1; continue;
    }
    nome.lastIndex = i;
    const achou = nome.exec(sql);
    const antes = sql[i - 1] || ' ';
    if (achou && !/[\w.]/.test(antes)) {
      const { args, fim } = lerArgumentos(sql, nome.lastIndex);
      const traduzidos = args.map(trocarFuncoes);
      saida += FUNCOES[achou[1].toLowerCase()](traduzidos);
      i = fim; continue;
    }
    saida += c; i++;
  }
  return saida;
}

// Coloca os valores no lugar dos "?"
function preencher(sql, parametros) {
  let n = 0, saida = '';
  for (const t of trechos(sql)) {
    if (t.tipo === 'aspas') { saida += t.texto; continue; }
    saida += t.texto.replace(/\?/g, () => {
      if (n >= parametros.length) throw new Error('Faltam parametros para o SQL');
      return literal(parametros[n++]);
    });
  }
  if (n !== parametros.length) throw new Error('Sobram parametros para o SQL');
  return saida;
}

function trocarNoCodigo(sql, fn) {
  let saida = '';
  for (const t of trechos(sql)) saida += t.tipo === 'aspas' ? t.texto : fn(t.texto);
  return saida;
}

export function traduzir(sql, parametros = []) {
  let s = trocarFuncoes(sql);
  s = trocarNoCodigo(s, (c) => c
    .replace(/\s+COLLATE\s+NOCASE/gi, '')
    .replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE')
    .replace(/(?<!I)\bLIKE\b/gi, 'ILIKE'));

  const insercao = /^\s*INSERT\s+INTO\s+([a-z_]+)/i.exec(s);
  if (insercao && !SEM_ID.has(insercao[1].toLowerCase()) && !/\bRETURNING\b/i.test(s)) {
    s = s.replace(/;\s*$/, '') + ' RETURNING id';
  }
  return preencher(s, parametros);
}
