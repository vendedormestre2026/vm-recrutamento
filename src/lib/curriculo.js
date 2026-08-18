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
//
// `extensao`: a UNICA usada pra salvar no disco (canonica — um .jpeg enviado ainda vira
// "<token>.jpg", pra nao ter dois nomes de arquivo pro mesmo tipo). `extensoesValidas`: TODAS
// as extensoes de nome de arquivo aceitas pra esse mimetype no upload — .jpg E .jpeg sao o
// mesmo mimetype (image/jpeg) e os dois aparecem em uploads reais, dependendo do
// celular/app que gerou a foto.
const TIPOS_CURRICULO_ACEITOS = [
  { mimetype: 'application/pdf', extensao: 'pdf', extensoesValidas: ['pdf'] },
  { mimetype: 'image/jpeg', extensao: 'jpg', extensoesValidas: ['jpg', 'jpeg'] },
  { mimetype: 'image/png', extensao: 'png', extensoesValidas: ['png'] },
  {
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensao: 'docx',
    extensoesValidas: ['docx'],
  },
];

// Mimetype declarado E extensao do nome batem com um tipo aceito? As duas checagens juntas
// (nao so o mimetype) porque o mimetype vem do CLIENTE, sem garantia nenhuma — um upload
// pode declarar "image/jpeg" com nome "curriculo.exe", e so a extensao pega isso.
function tipoCurriculoAceito(file) {
  if (!file) return false;
  const tipo = TIPOS_CURRICULO_ACEITOS.find((t) => t.mimetype === file.mimetype);
  if (!tipo) return false;
  const nome = String(file.originalname || '');
  return tipo.extensoesValidas.some((ext) => new RegExp(`\\.${ext}$`, 'i').test(nome));
}

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

// Mimetype pra servir no download, a partir da extensao do arquivo em disco (o inverso de
// extensaoDoArquivo — mesma lista, direcao contraria). Extensao fora do mapa (arquivo
// antigo salvo antes deste incremento, ou algo inesperado) cai em application/octet-stream:
// o navegador oferece "salvar como" em vez de tentar renderizar um tipo errado.
function mimetypePorExtensao(extensao) {
  const e = String(extensao || '').toLowerCase().replace(/^\./, '');
  const t = TIPOS_CURRICULO_ACEITOS.find((x) => x.extensoesValidas.includes(e));
  return t ? t.mimetype : 'application/octet-stream';
}

module.exports = {
  extrairTextoPdf,
  MAX_CARACTERES,
  TIPOS_CURRICULO_ACEITOS,
  tipoCurriculoAceito,
  extensaoDoArquivo,
  mimetypePorExtensao,
};
