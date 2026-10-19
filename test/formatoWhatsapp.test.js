'use strict';

// Formatacao do WhatsApp em HTML para a previa (lib/formatoWhatsapp). Funcao pura: sem banco,
// sem rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatarWhatsappHtml: f, MARCA_INICIO, MARCA_FIM } = require('../src/lib/formatoWhatsapp');

test('negrito, italico, riscado e monoespacado', () => {
  assert.equal(f('*a b*'), '<b>a b</b>');
  assert.equal(f('_a b_'), '<i>a b</i>');
  assert.equal(f('~a b~'), '<s>a b</s>');
  assert.equal(f('```a *b* _c_```'), '<code class="wa-mono">a *b* _c_</code>', 'nada formatado dentro do mono');
  assert.equal(f('oi *a* e *b*!'), 'oi <b>a</b> e <b>b</b>!');
  assert.equal(f('*x*'), '<b>x</b>', 'um caractere so');
});

test('aninhados', () => {
  assert.equal(f('*_a_*'), '<b><i>a</i></b>');
  assert.equal(f('_*a*_'), '<i><b>a</b></i>');
  assert.equal(f('*negrito ~riscado~ e _italico_*'), '<b>negrito <s>riscado</s> e <i>italico</i></b>');
});

test('marcadores sem par, soltos ou com espaco ficam literais', () => {
  assert.equal(f('*sem fim'), '*sem fim');
  assert.equal(f('sem inicio*'), 'sem inicio*');
  assert.equal(f('* espaco depois*'), '* espaco depois*');
  assert.equal(f('*espaco antes *'), '*espaco antes *');
  assert.equal(f('2*3*4'), '2*3*4', 'colado em numero');
  assert.equal(f('nome_do_arquivo'), 'nome_do_arquivo', 'colado em letra');
  assert.equal(f('**'), '**');
  assert.equal(f('*a\nb*'), '*a\nb*', 'nao atravessa linha');
});

test('escapa HTML ANTES de formatar: <script>, &, aspas', () => {
  assert.equal(f('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(f('*<img src=x onerror=alert(1)>*'), '<b>&lt;img src=x onerror=alert(1)&gt;</b>');
  assert.equal(f('A & B "c" \'d\''), 'A &amp; B &quot;c&quot; &#39;d&#39;');
  assert.equal(f('&lt;'), '&amp;lt;', 'entidade digitada nao vira caractere');
});

test('quebras de linha preservadas, inclusive linhas em branco; \\r\\n vira \\n', () => {
  assert.equal(f('a\n\n\nb'), 'a\n\n\nb');
  assert.equal(f('a\r\n\r\nb'), 'a\n\nb');
});

test('links clicaveis so na exibicao; pontuacao, aspas e marcador colados ficam fora', () => {
  const a = (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
  assert.equal(f('sala: https://meet.google.com/eir-wjvi-jwv.'), `sala: ${a('https://meet.google.com/eir-wjvi-jwv')}.`);
  assert.equal(f('(https://x.com/a)'), `(${a('https://x.com/a')})`);
  assert.equal(f('*https://x.com/a*'), `<b>${a('https://x.com/a')}</b>`);
  assert.equal(f('https://x.com/a_b_c'), a('https://x.com/a_b_c'), 'underscore da URL nao vira italico');
  assert.equal(f('https://x.com/?a=1&b=2'), a('https://x.com/?a=1&amp;b=2'));
  assert.equal(f('"https://x.com"'), `&quot;${a('https://x.com')}&quot;`);
  assert.ok(!f('javascript:alert(1)').includes('<a'), 'so http/https');
});

test('emojis preservados', () => {
  assert.equal(f('😊 *📅 hoje* ⏰'), '😊 <b>📅 hoje</b> ⏰');
});

test('valores substituidos (marcas) viram destaque discreto', () => {
  assert.equal(f(`Oi ${MARCA_INICIO}Maria${MARCA_FIM}, *${MARCA_INICIO}Closer${MARCA_FIM}*`),
    'Oi <span class="wa-sub">Maria</span>, <b><span class="wa-sub">Closer</span></b>');
  const link = f(`${MARCA_INICIO}https://cal.com/x${MARCA_FIM}.`);
  assert.equal(link, '<span class="wa-sub"><a href="https://cal.com/x" target="_blank" rel="noopener noreferrer">https://cal.com/x</a></span>.');
});

test('os caracteres reservados digitados no texto nao injetam nada', () => {
  assert.equal(f('a\uE0020\uE003b'), 'a0b', 'os reservados somem; o resto fica como texto');
});

test('caso real: Variacao 2 da campanha 11, com paragrafos', () => {
  const texto = [
    '{saudacao} Aqui é o {recrutador}, da *Vendedor Mestre*, empresa de recrutamento. 😊',
    '',
    'Você se candidatou ao cargo de *{vaga}* na *{empresa}* e queremos te conhecer melhor!',
    '',
    'Vamos fazer uma *entrevista em grupo online*:',
    '📅 *{data}*',
    '⏰ *{horario}* (horário de Brasília).',
    '🔗 Link para confirmar presença: {link_meet}.',
    '',
    'Se já confirmou, use este link para entrar na sala: https://meet.google.com/eir-wjvi-jwv',
  ].join('\n');
  const h = f(texto);
  assert.equal(h.split('\n').length, texto.split('\n').length, 'mesmas linhas');
  for (const b of ['Vendedor Mestre', '{vaga}', '{empresa}', 'entrevista em grupo online', '{data}', '{horario}']) {
    assert.ok(h.includes(`<b>${b}</b>`), b);
  }
  assert.ok(!/\*/.test(h), 'nenhum asterisco visivel');
  assert.ok(h.includes('<a href="https://meet.google.com/eir-wjvi-jwv"'));
  assert.ok(h.includes('😊') && h.includes('📅') && h.includes('🔗'));
});
