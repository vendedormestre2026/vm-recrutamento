'use strict';

// Extracao de texto de curriculo (PDF, e futuramente outros formatos).
// O texto extraido e guardado em applications.curriculo_texto para o agente Vera
// referenciar a experiencia do candidato durante a entrevista (Fase 3).
//
// Requeremos o arquivo interno do pdf-parse (lib/pdf-parse.js) em vez do index.js
// para evitar o bloco de "debug" do pacote, que tenta ler um PDF de teste no disco.

const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const MAX_CARACTERES = 20000;

// ── TIPOS DE CURRICULO ACEITOS NO UPLOAD ──
// Fonte UNICA da lista de mimetypes aceitos e da extensao correta de cada um. Usada em tres
// pontas que precisam concordar entre si: o fileFilter do multer (o que aceita), a escrita
// do arquivo no disco (com que extensao salvar) e o download no admin (que Content-Type
// servir). Uma segunda copia desta lista em qualquer uma delas seria a garantia de que as
// tres divergiriam no dia em que um tipo novo fosse adicionado.
const TIPOS_CURRICULO_ACEITOS = [
  { mimetype: 'application/pdf', extensao: 'pdf' },
  { mimetype: 'image/jpeg', extensao: 'jpg' },
  { mimetype: 'image/png', extensao: 'png' },
  {
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensao: 'docx',
  },
];

// Extensao (sem ponto) pro arquivo deste upload, a partir do mimetype declarado. Sem
// entrada no mapa (upload que passou por uma validacao mais permissiva em algum outro
// ponto, ou dado legado) cai pra extensao do NOME original enviado; sem nenhum dos dois,
// 'bin' — nunca deixa o arquivo sem extensao nenhuma.
function extensaoDoArquivo(file) {
  const porMimetype = TIPOS_CURRICULO_ACEITOS.find((t) => t.mimetype === (file && file.mimetype));
  if (porMimetype) return porMimetype.extensao;
  const nome = String((file && file.originalname) || '');
  const m = nome.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : 'bin';
}

// Recebe um Buffer do PDF e devolve o texto extraido (truncado).
// Em caso de PDF ilegivel/protegido, devolve string vazia (nao quebra a candidatura).
async function extrairTextoPdf(buffer) {
  try {
    const dados = await pdfParse(buffer);
    const texto = (dados.text || '').replace(/\s+\n/g, '\n').trim();
    return texto.slice(0, MAX_CARACTERES);
  } catch (err) {
    console.error('[curriculo] falha ao extrair texto do PDF:', err.message);
    return '';
  }
}

module.exports = { extrairTextoPdf, MAX_CARACTERES, TIPOS_CURRICULO_ACEITOS, extensaoDoArquivo };
