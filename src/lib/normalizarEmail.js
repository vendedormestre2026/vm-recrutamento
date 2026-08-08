'use strict';

// Forma canonica de um e-mail: LOWER(TRIM()). E o que define, em todo o projeto, quando
// dois enderecos escritos diferente sao "a mesma pessoa".
//
// ── POR QUE ESTE ARQUIVO EXISTE SOZINHO, COM UMA FUNCAO SO ──
//
// Ele e importado pela CAMADA DE DADOS (src/db/sqlite.js) e por libs de negocio
// (src/lib/descadastro.js). Camada de dados e libs de negocio se importam em sentidos
// opostos: lib -> db e a direcao normal do projeto. Se a normalizacao morasse numa lib
// que um dia passe a chamar `require('../db')`, fecharia um CICLO db -> lib -> db.
//
// Em CommonJS um ciclo NAO estoura no require: um dos lados recebe o `module.exports` do
// outro pela METADE (as funcoes ainda nao atribuidas viram `undefined`), e a falha
// aparece so quando aquela funcao especifica for chamada — em runtime, provavelmente em
// producao, num ponto sem relacao aparente com a causa.
//
// REGRA DESTE ARQUIVO, e a unica coisa que o mantem seguro:
//   NAO IMPORTE NADA DO PROJETO AQUI. Nem config, nem db, nem outra lib.
//   Se precisar de algo, use so a stdlib do Node.
// Ele e uma FOLHA no grafo de dependencias, e e por isso que pode ser importado de
// qualquer camada sem risco. Um unico `require` de dentro do projeto anula essa garantia.
//
// ── POR QUE EM JS, E NAO LOWER(TRIM()) NO SQL ──
// O LOWER do SQLite dobra apenas ASCII; o toLowerCase() do JavaScript e Unicode-aware.
// Normalizar dos dois jeitos criaria duas definicoes de "mesma pessoa" que divergem em
// enderecos com caractere acentuado. Num opt-out, essa divergencia significa alguem que
// pediu para sair e continua recebendo e-mail. Entao existe UMA implementacao, esta, e o
// SQL sempre recebe o valor ja normalizado por ela.

function normalizarEmail(email) {
  if (email == null) return '';
  return String(email).trim().toLowerCase();
}

module.exports = { normalizarEmail };
