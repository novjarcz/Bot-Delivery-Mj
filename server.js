// =====================================================
// TIQUINHO ESPETINHOS - MOTOR V3
// PARTE 1/5
// Base: Motor V2
// =====================================================

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(
  express.json({
    limit: "2mb",
  })
);

// =====================================================
// VARIÁVEIS DE AMBIENTE
// =====================================================

const {
  OPENAI_API_KEY,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  CLIENT_TOKEN,
} = process.env;

const requiredEnvVars = {
  OPENAI_API_KEY,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  CLIENT_TOKEN,
};

const missingEnvVars = Object.entries(
  requiredEnvVars
)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  console.error(
    `❌ Variáveis ausentes: ${missingEnvVars.join(", ")}`
  );

  process.exit(1);
}

const ZAPI_BASE_URL =
  `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// =====================================================
// CONFIGURAÇÕES
// =====================================================

// Junta mensagens enviadas rapidamente pelo cliente.
const DEBOUNCE_MS = 4000;

// V2 estava com 1 minuto.
// No V3 vamos deixar 5 minutos para não encher o saco
// do cliente logo depois da primeira mensagem.
const LEMBRETE_MS =
  5 * 60 * 1000;

// Sessão expira depois de 4 horas sem atividade.
const EXPIRACAO_SESSAO_MS =
  4 * 60 * 60 * 1000;

// Máximo de mensagens mantidas no histórico da IA.
const MAX_MESSAGES = 20;

// Regra provisória aprovada para a demonstração.
const TAXA_ENTREGA = 6.90;

// Acima de R$ 60,00:
// entrega grátis.
//
// IMPORTANTE:
// "acima" significa > 60.
// Exatamente R$ 60 ainda paga taxa.
const LIMITE_ENTREGA_GRATIS = 60;

// Margem para comparação de valores monetários.
const TOLERANCIA_VALOR = 0.02;

const TIMEZONE =
  "America/Sao_Paulo";

// Modelo utilizado pelo interpretador.
const OPENAI_MODEL =
  "gpt-4o-mini";

// =====================================================
// CARDÁPIO / PROMPT
// =====================================================

const caminhoCardapio =
  path.join(
    __dirname,
    "cardapio.json"
  );

const caminhoPrompt =
  path.join(
    __dirname,
    "prompt-tiquinho.txt"
  );

function carregarCardapio() {
  try {
    const conteudo =
      fs.readFileSync(
        caminhoCardapio,
        "utf8"
      );

    const parsed =
      JSON.parse(conteudo);

    if (
      !parsed ||
      !Array.isArray(
        parsed.categorias
      )
    ) {
      throw new Error(
        "cardapio.json não possui categorias válidas."
      );
    }

    return parsed;
  } catch (error) {
    console.error(
      "❌ ERRO AO CARREGAR CARDÁPIO:",
      error.message
    );

    process.exit(1);
  }
}

function carregarPrompt() {
  try {
    const conteudo =
      fs.readFileSync(
        caminhoPrompt,
        "utf8"
      );

    if (!conteudo.trim()) {
      throw new Error(
        "prompt-tiquinho.txt está vazio."
      );
    }

    return conteudo;
  } catch (error) {
    console.error(
      "❌ ERRO AO CARREGAR PROMPT:",
      error.message
    );

    process.exit(1);
  }
}

const cardapio =
  carregarCardapio();

const systemPrompt =
  carregarPrompt();

console.log(
  `✅ CARDÁPIO CARREGADO: ${
    cardapio.estabelecimento?.nome ||
    "sem nome"
  }`
);

console.log(
  "✅ PROMPT CARREGADO: Tiquinho Espetinhos"
);

// =====================================================
// TEXTO / NORMALIZAÇÃO
// =====================================================

function normalizarTexto(
  texto = ""
) {
  return String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /[’‘´`]/g,
      "'"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

const normalizarBusca =
  normalizarTexto;

function textoContemPalavra(
  texto,
  palavra
) {
  const msg =
    ` ${normalizarTexto(texto)} `;

  const alvo =
    ` ${normalizarTexto(palavra)} `;

  return msg.includes(alvo);
}

function ehSaudacaoPura(
  texto
) {
  const mensagem =
    normalizarTexto(texto);

  return [
    "oi",
    "oii",
    "oiii",
    "ola",
    "opa",
    "eai",
    "e ai",
    "fala",
    "bom dia",
    "boa tarde",
    "boa noite",
  ].includes(mensagem);
}

function ehConfirmacao(
  texto
) {
  const msg =
    normalizarTexto(texto);

  return [
    "sim",
    "s",
    "pode",
    "pode sim",
    "confirmo",
    "confirmar",
    "pode confirmar",
    "fechado",
    "isso",
    "isso mesmo",
    "correto",
    "certinho",
    "blz",
    "beleza",
  ].includes(msg);
}

function ehNegacao(
  texto
) {
  const msg =
    normalizarTexto(texto);

  return (
    msg === "nao" ||
    msg === "n" ||
    msg.includes(
      "nao quero"
    ) ||
    msg.includes(
      "sem isso"
    ) ||
    msg.includes(
      "so isso"
    ) ||
    msg.includes(
      "nao precisa"
    )
  );
}

function possuiNegacaoTroco(
  texto
) {
  const mensagem =
    normalizarTexto(texto);

  return (
    mensagem === "nao" ||
    mensagem.includes(
      "nao precisa"
    ) ||
    mensagem.includes(
      "nao preciso"
    ) ||
    mensagem.includes(
      "sem troco"
    ) ||
    mensagem.includes(
      "nao quero troco"
    )
  );
}

function formatarReal(
  valor
) {
  if (
    valor === null ||
    valor === undefined ||
    !Number.isFinite(
      Number(valor)
    )
  ) {
    return "a confirmar";
  }

  return Number(valor)
    .toLocaleString(
      "pt-BR",
      {
        style: "currency",
        currency: "BRL",
      }
    );
}

function numeroSeguro(
  valor,
  fallback = null
) {
  if (
    valor === null ||
    valor === undefined ||
    valor === ""
  ) {
    return fallback;
  }

  const numero =
    Number(valor);

  if (
    !Number.isFinite(numero)
  ) {
    return fallback;
  }

  return numero;
}

// =====================================================
// ÍNDICE DO CARDÁPIO
// =====================================================
//
// REGRA DO V3:
//
// cardapio.json = fonte da verdade.
//
// A IA pode INTERPRETAR o que o cliente quis dizer.
// A IA NÃO pode criar produto, preço ou opção.
//
// =====================================================

function produtoDisponivelDelivery(
  produto
) {
  if (!produto) {
    return false;
  }

  if (
    produto.disponivel ===
    false
  ) {
    return false;
  }

  if (
    normalizarTexto(
      produto.contexto || ""
    ) === "mesa"
  ) {
    return false;
  }

  return true;
}

function listarTodosProdutos() {
  const produtos = [];

  for (
    const categoria of
    cardapio.categorias || []
  ) {
    for (
      const produto of
      categoria.produtos || []
    ) {
      produtos.push({
        ...produto,

        categoria:
          categoria.nome,

        categoriaId:
          categoria.id,
      });
    }
  }

  return produtos;
}

const todosProdutos =
  listarTodosProdutos();

const produtosDelivery =
  todosProdutos.filter(
    produtoDisponivelDelivery
  );

const produtosPorId =
  new Map();

for (
  const produto of
  produtosDelivery
) {
  // Se existirem IDs duplicados entre mesa e delivery,
  // somente produtos válidos para o WhatsApp entram aqui.
  //
  // Se houver duplicação dentro do próprio delivery,
  // preservamos o primeiro e avisamos no log.
  if (
    produtosPorId.has(
      produto.id
    )
  ) {
    console.warn(
      `⚠️ ID duplicado no cardápio delivery: ${produto.id}`
    );

    continue;
  }

  produtosPorId.set(
    produto.id,
    produto
  );
}

// =====================================================
// ÍNDICE DAS CATEGORIAS
// =====================================================

const categoriasPorId =
  new Map();

for (
  const categoria of
  cardapio.categorias || []
) {
  categoriasPorId.set(
    categoria.id,
    categoria
  );
}

function obterProdutoPorId(
  id
) {
  if (!id) {
    return null;
  }

  return (
    produtosPorId.get(
      String(id)
    ) ||
    null
  );
}

function obterCategoriaPorId(
  id
) {
  if (!id) {
    return null;
  }

  return (
    categoriasPorId.get(
      String(id)
    ) ||
    null
  );
}

function produtosDaCategoria(
  categoriaId
) {
  return produtosDelivery.filter(
    (produto) =>
      produto.categoriaId ===
      categoriaId
  );
}

// =====================================================
// ALIASES DE CATEGORIA
// =====================================================
//
// Aqui resolvemos coisas como:
//
// "espetinho"
// "espetinhos"
// "bebida"
// "refrigerante"
// "porção"
//
// SEM escolher um produto aleatório.
//
// =====================================================

function criarAliasesCategoria() {
  const mapa =
    new Map();

  function adicionar(
    alias,
    categoriaId
  ) {
    const chave =
      normalizarTexto(alias);

    if (
      !chave ||
      !categoriaId
    ) {
      return;
    }

    if (
      !mapa.has(chave)
    ) {
      mapa.set(
        chave,
        []
      );
    }

    const ids =
      mapa.get(chave);

    if (
      !ids.includes(
        categoriaId
      )
    ) {
      ids.push(
        categoriaId
      );
    }
  }

  for (
    const categoria of
    cardapio.categorias || []
  ) {
    const nome =
      normalizarTexto(
        categoria.nome
      );

    adicionar(
      nome,
      categoria.id
    );

    // Singular básico.
    if (
      nome.endsWith("s") &&
      nome.length > 3
    ) {
      adicionar(
        nome.slice(0, -1),
        categoria.id
      );
    }

    // Aliases que eventualmente existam no JSON.
    for (
      const alias of
      categoria.aliases || []
    ) {
      adicionar(
        alias,
        categoria.id
      );
    }

    // Mapeamentos semânticos seguros.
    if (
      nome.includes(
        "espet"
      )
    ) {
      adicionar(
        "espetinho",
        categoria.id
      );

      adicionar(
        "espetinhos",
        categoria.id
      );
    }

    if (
      nome.includes(
        "bebida"
      ) ||
      nome.includes(
        "refrigerante"
      )
    ) {
      adicionar(
        "bebida",
        categoria.id
      );

      adicionar(
        "bebidas",
        categoria.id
      );

      adicionar(
        "refrigerante",
        categoria.id
      );

      adicionar(
        "refrigerantes",
        categoria.id
      );

      adicionar(
        "refri",
        categoria.id
      );
    }

    if (
      nome.includes(
        "porcao"
      )
    ) {
      adicionar(
        "porcao",
        categoria.id
      );

      adicionar(
        "porcoes",
        categoria.id
      );
    }

    if (
      nome.includes(
        "jantinha"
      )
    ) {
      adicionar(
        "jantinha",
        categoria.id
      );

      adicionar(
        "jantinhas",
        categoria.id
      );
    }

    if (
      nome.includes(
        "combo"
      )
    ) {
      adicionar(
        "combo",
        categoria.id
      );

      adicionar(
        "combos",
        categoria.id
      );
    }
  }

  return mapa;
}

const aliasesCategoria =
  criarAliasesCategoria();

function encontrarCategoriasPorTermo(
  termo
) {
  const busca =
    normalizarTexto(termo);

  if (!busca) {
    return [];
  }

  const ids =
    new Set();

  // Primeiro: alias exato.
  for (
    const id of
    aliasesCategoria.get(
      busca
    ) || []
  ) {
    ids.add(id);
  }

  // Depois: nome exato da categoria.
  for (
    const categoria of
    cardapio.categorias || []
  ) {
    if (
      normalizarTexto(
        categoria.nome
      ) === busca
    ) {
      ids.add(
        categoria.id
      );
    }
  }

  return [
    ...ids,
  ]
    .map(
      obterCategoriaPorId
    )
    .filter(Boolean);
}

// =====================================================
// BUSCA SEGURA DE PRODUTOS
// =====================================================

function aliasesProduto(
  produto
) {
  const aliases =
    new Set();

  aliases.add(
    normalizarTexto(
      produto.nome
    )
  );

  for (
    const alias of
    produto.aliases || []
  ) {
    const normalizado =
      normalizarTexto(alias);

    if (normalizado) {
      aliases.add(
        normalizado
      );
    }
  }

  return [
    ...aliases,
  ].filter(Boolean);
}

function buscarProdutoExato(
  termo
) {
  const busca =
    normalizarTexto(termo);

  if (!busca) {
    return [];
  }

  return produtosDelivery.filter(
    (produto) =>
      aliasesProduto(
        produto
      ).includes(busca)
  );
}

function buscarProdutosCardapio(
  termo
) {
  const busca =
    normalizarTexto(termo);

  if (!busca) {
    return [];
  }

  // ---------------------------------------------------
  // 1. Correspondência exata sempre vence.
  // ---------------------------------------------------

  const exatos =
    buscarProdutoExato(
      busca
    );

  if (
    exatos.length > 0
  ) {
    return exatos;
  }

  // ---------------------------------------------------
  // 2. Categoria genérica NÃO vira produto.
  //
  // "espetinho" não pode escolher
  // "Combo Tiquinho Espetinho".
  // ---------------------------------------------------

  if (
    encontrarCategoriasPorTermo(
      busca
    ).length > 0
  ) {
    return [];
  }

  // ---------------------------------------------------
  // 3. Busca por aliases.
  //
  // Evitamos usar descrição como fonte principal,
  // porque isso aumenta muito os falsos positivos.
  // ---------------------------------------------------

  const encontrados = [];

  for (
    const produto of
    produtosDelivery
  ) {
    const aliases =
      aliasesProduto(
        produto
      );

    const bate =
      aliases.some(
        (alias) => {
          if (
            alias === busca
          ) {
            return true;
          }

          // Só aceita contains quando o termo é
          // razoavelmente específico.
          if (
            busca.length < 4
          ) {
            return false;
          }

          return (
            alias.includes(
              busca
            ) ||
            busca.includes(
              alias
            )
          );
        }
      );

    if (bate) {
      encontrados.push(
        produto
      );
    }
  }

  return encontrados;
}

// =====================================================
// DETECÇÃO DE PRODUTOS NA MENSAGEM
// =====================================================
//
// Essa função NÃO adiciona nada ao carrinho.
//
// Ela somente cria uma lista de candidatos para a IA.
// A validação real será feita depois.
//
// =====================================================

function encontrarProdutosNaMensagem(
  texto
) {
  const mensagem =
    normalizarTexto(texto);

  if (!mensagem) {
    return [];
  }

  const candidatos =
    [];

  for (
    const produto of
    produtosDelivery
  ) {
    const aliases =
      aliasesProduto(
        produto
      );

    let melhorPontuacao =
      0;

    for (
      const alias of
      aliases
    ) {
      if (
        !alias ||
        alias.length < 3
      ) {
        continue;
      }

      // Nome/alias aparece inteiro na mensagem.
      if (
        mensagem.includes(
          alias
        )
      ) {
        const pontuacao =
          1000 +
          alias.length;

        melhorPontuacao =
          Math.max(
            melhorPontuacao,
            pontuacao
          );
      }
    }

    if (
      melhorPontuacao > 0
    ) {
      candidatos.push({
        produto,
        pontuacao:
          melhorPontuacao,
      });
    }
  }

  // Mais específico primeiro.
  candidatos.sort(
    (a, b) =>
      b.pontuacao -
      a.pontuacao
  );

  // Remove duplicados por ID.
  const ids =
    new Set();

  const resultado =
    [];

  for (
    const candidato of
    candidatos
  ) {
    if (
      ids.has(
        candidato.produto.id
      )
    ) {
      continue;
    }

    ids.add(
      candidato.produto.id
    );

    resultado.push(
      candidato.produto
    );
  }

  return resultado;
}

// =====================================================
// CONSULTAS DETERMINÍSTICAS BÁSICAS
// =====================================================

function ehPerguntaCardapio(
  texto
) {
  const msg =
    normalizarTexto(texto)
      .replace(/[?!.,;:]+/g, "")
      .replace(/\s+/g, " ")
      .trim();

  if (!msg) {
    return false;
  }

  // Pedidos explícitos de cardápio geral.
  const frasesCardapio = [
    "cardapio",
    "menu",
    "me mostra o cardapio",
    "mostra o cardapio",
    "me mostre o cardapio",
    "me manda o cardapio",
    "manda o cardapio",
    "ver cardapio",
    "quero ver o cardapio",
    "quero o cardapio",
  ];

  if (
    frasesCardapio.includes(msg)
  ) {
    return true;
  }

  // Perguntas realmente genéricas.
  // Aqui NÃO usamos includes de propósito.
  //
  // "o que voces tem"     -> cardápio geral
  // "o que tem no trio 3" -> NÃO
  // "o que tem de bebidas"-> NÃO
  const perguntasGerais = [
    "o que tem",
    "o que voce tem",
    "o que voces tem",
    "o que tem ai",
    "o que tem hoje",
    "quais opcoes",
    "quais as opcoes",
    "quais sao as opcoes",
    "o que vende",
    "o que voces vendem",
  ];

  return perguntasGerais.includes(
    msg
  );
}

function ehPerguntaTotal(
  texto
) {
  const msg =
    normalizarTexto(texto);

  const frases = [
    "quanto deu",
    "quanto ficou",
    "qual o total",
    "qual valor total",
    "qual o valor total",
    "valor total",
    "valor do pedido",
    "quanto ficou o pedido",
    "quanto deu o pedido",
    "quanto esta",
    "quanto ta",
  ];

  return frases.some(
    (frase) =>
      msg === frase ||
      msg.includes(frase)
  );
}

function pareceConsulta(
  texto
) {
  const msg =
    normalizarTexto(texto);

  if (
    ehPerguntaCardapio(msg) ||
    ehPerguntaTotal(msg)
  ) {
    return true;
  }

  const marcadores = [
    "tem ",
    "tem?",
    "quais ",
    "qual ",
    "quanto ",
    "como ",
    "o que ",
    "vende ",
    "vocês tem ",
    "voces tem ",
  ];

  return marcadores.some(
    (marcador) =>
      msg.includes(
        marcador
      )
  );
}

// =====================================================
// LOG DE INICIALIZAÇÃO DO ÍNDICE
// =====================================================

console.log(
  `✅ PRODUTOS DELIVERY INDEXADOS: ${produtosDelivery.length}`
);

console.log(
  `✅ CATEGORIAS INDEXADAS: ${categoriasPorId.size}`
);

// =====================================================
// FIM DA PARTE 1/5
// NÃO COLE MAIS NADA ABAIXO AINDA.
// =====================================================

// =====================================================
// TIQUINHO ESPETINHOS - MOTOR V3
// PARTE 2/5
//
// ESTADO + SESSÃO + CARRINHO + VARIAÇÕES +
// OPÇÕES + ESCOLHAS OBRIGATÓRIAS
//
// COLE IMEDIATAMENTE ABAIXO DA PARTE 1.
// =====================================================


// =====================================================
// MEMÓRIA POR TELEFONE
// =====================================================

const historicoPorTelefone =
  new Map();

const bufferPorTelefone =
  new Map();

const timerPorTelefone =
  new Map();

const filaPorTelefone =
  new Map();

const estadoPorTelefone =
  new Map();

const lembretePorTelefone =
  new Map();

const expiracaoPorTelefone =
  new Map();


// =====================================================
// CONTROLE DE WEBHOOK DUPLICADO
// =====================================================
//
// Z-API pode eventualmente entregar o mesmo evento
// mais de uma vez.
//
// Guardamos IDs recentes para não processar duas vezes.
// =====================================================

const mensagensProcessadas =
  new Map();

const TEMPO_ID_PROCESSADO_MS =
  30 * 60 * 1000;


function limparIdsProcessados() {
  const agora =
    Date.now();

  for (
    const [
      id,
      timestamp,
    ] of mensagensProcessadas
  ) {
    if (
      agora - timestamp >
      TEMPO_ID_PROCESSADO_MS
    ) {
      mensagensProcessadas.delete(
        id
      );
    }
  }
}


function mensagemJaProcessada(
  id
) {
  if (!id) {
    return false;
  }

  limparIdsProcessados();

  if (
    mensagensProcessadas.has(
      id
    )
  ) {
    return true;
  }

  mensagensProcessadas.set(
    id,
    Date.now()
  );

  return false;
}


// =====================================================
// CRIAÇÃO DO ESTADO
// =====================================================

function criarEstadoInicial() {
  return {
    etapa: "itens",

    carrinho: [],

    entrega: {
      tipo: null,
      nome: null,
      endereco: null,
      numero: null,
      complemento: null,
      bairro: null,
      referencia: null,
      cidade: null,
    },

    pagamento: {
      metodo: null,

      // Para pagamento misto:
      //
      // [
      //   {
      //     metodo: "dinheiro",
      //     valor: 100
      //   },
      //   {
      //     metodo: "pix",
      //     valor: 24.90
      //   }
      // ]
      divisoes: [],

      precisaTroco: null,
      trocoPara: null,
    },

    aguardando: null,

    aguardandoEscolha: null,

    ultimaConsulta: null,

    resumoConfirmado: false,

    finalizado: false,

    demonstracaoConfirmada: false,

    lembreteEnviado: false,

    criadoEm:
      Date.now(),

    atualizadoEm:
      Date.now(),
  };
}


function obterEstado(
  telefone
) {
  if (
    !estadoPorTelefone.has(
      telefone
    )
  ) {
    estadoPorTelefone.set(
      telefone,
      criarEstadoInicial()
    );
  }

  return estadoPorTelefone.get(
    telefone
  );
}


function atualizarEstado(
  telefone
) {
  const estado =
    obterEstado(
      telefone
    );

  estado.atualizadoEm =
    Date.now();

  return estado;
}


// =====================================================
// HISTÓRICO POR TELEFONE
// =====================================================

function obterHistorico(
  telefone
) {
  if (
    !historicoPorTelefone.has(
      telefone
    )
  ) {
    historicoPorTelefone.set(
      telefone,
      []
    );
  }

  return historicoPorTelefone.get(
    telefone
  );
}


function adicionarHistorico(
  telefone,
  role,
  content
) {
  if (!content) {
    return;
  }

  const historico =
    obterHistorico(
      telefone
    );

  historico.push({
    role,
    content:
      String(content),
  });

  if (
    historico.length >
    MAX_MESSAGES
  ) {
    historico.splice(
      0,
      historico.length -
        MAX_MESSAGES
    );
  }
}


// =====================================================
// TIMERS DA SESSÃO
// =====================================================

function cancelarTimer(
  mapa,
  telefone
) {
  const timer =
    mapa.get(
      telefone
    );

  if (timer) {
    clearTimeout(
      timer
    );

    mapa.delete(
      telefone
    );
  }
}


function cancelarTimersTelefone(
  telefone
) {
  cancelarTimer(
    timerPorTelefone,
    telefone
  );

  cancelarTimer(
    lembretePorTelefone,
    telefone
  );

  cancelarTimer(
    expiracaoPorTelefone,
    telefone
  );
}


// =====================================================
// RESET DA CONVERSA
// =====================================================

function resetarConversa(
  telefone
) {
  cancelarTimersTelefone(
    telefone
  );

  historicoPorTelefone.delete(
    telefone
  );

  bufferPorTelefone.delete(
    telefone
  );

  filaPorTelefone.delete(
    telefone
  );

  estadoPorTelefone.delete(
    telefone
  );
}


// =====================================================
// EXPIRAÇÃO DA SESSÃO
// =====================================================

function agendarExpiracao(
  telefone
) {
  cancelarTimer(
    expiracaoPorTelefone,
    telefone
  );

  const timer =
    setTimeout(
      () => {
        console.log(
          `🧹 Sessão expirada: ${telefone}`
        );

        resetarConversa(
          telefone
        );
      },
      EXPIRACAO_SESSAO_MS
    );

  expiracaoPorTelefone.set(
    telefone,
    timer
  );
}


// =====================================================
// FUNÇÕES DO CARRINHO
// =====================================================

function pedidoTemItens(
  estado
) {
  return (
    Array.isArray(
      estado?.carrinho
    ) &&
    estado.carrinho.length > 0
  );
}


function quantidadeTotalItens(
  estado
) {
  return (
    estado?.carrinho || []
  ).reduce(
    (
      total,
      item
    ) =>
      total +
      Number(
        item.quantidade || 0
      ),
    0
  );
}


function gerarIdItemCarrinho() {
  return (
    Date.now()
      .toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}


// =====================================================
// VARIAÇÕES
// =====================================================

function listarVariacoesProduto(
  produto
) {
  if (
    !Array.isArray(
      produto?.variacoes
    )
  ) {
    return [];
  }

  return produto.variacoes;
}


function encontrarVariacao(
  produto,
  termo
) {
  const busca =
    normalizarTexto(
      termo
    );

  if (!busca) {
    return null;
  }

  const variacoes =
    listarVariacoesProduto(
      produto
    );

  // Exata primeiro.
  const exata =
    variacoes.find(
      (variacao) =>
        normalizarTexto(
          variacao.nome
        ) === busca
    );

  if (exata) {
    return exata;
  }

  // Depois correspondência segura.
  const candidatas =
    variacoes.filter(
      (variacao) => {
        const nome =
          normalizarTexto(
            variacao.nome
          );

        if (
          busca.length < 2
        ) {
          return false;
        }

        return (
          nome.includes(
            busca
          ) ||
          busca.includes(
            nome
          )
        );
      }
    );

  if (
    candidatas.length === 1
  ) {
    return candidatas[0];
  }

  return null;
}


// =====================================================
// OPÇÕES SIMPLES
// =====================================================

function listarOpcoesProduto(
  produto
) {
  if (
    !Array.isArray(
      produto?.opcoes
    )
  ) {
    return [];
  }

  return produto.opcoes;
}


function nomeOpcao(
  opcao
) {
  if (
    typeof opcao ===
    "string"
  ) {
    return opcao;
  }

  return (
    opcao?.nome ||
    opcao?.label ||
    ""
  );
}


function precoOpcao(
  opcao
) {
  if (
    typeof opcao ===
    "string"
  ) {
    return 0;
  }

  return (
    numeroSeguro(
      opcao?.preco,
      0
    ) || 0
  );
}


function encontrarOpcao(
  produto,
  termo
) {
  const busca =
    normalizarTexto(
      termo
    );

  if (!busca) {
    return null;
  }

  const opcoes =
    listarOpcoesProduto(
      produto
    );

  const exata =
    opcoes.find(
      (opcao) =>
        normalizarTexto(
          nomeOpcao(opcao)
        ) === busca
    );

  if (exata) {
    return exata;
  }

  const candidatas =
    opcoes.filter(
      (opcao) => {
        const nome =
          normalizarTexto(
            nomeOpcao(opcao)
          );

        if (
          busca.length < 2
        ) {
          return false;
        }

        return (
          nome.includes(
            busca
          ) ||
          busca.includes(
            nome
          )
        );
      }
    );

  if (
    candidatas.length === 1
  ) {
    return candidatas[0];
  }

  return null;
}


// =====================================================
// GRUPOS DE ESCOLHAS
// =====================================================
//
// Exemplo:
//
// Jantinha 1
//   acompanhamento obrigatório:
//   - mandioca
//   - batata frita
//
// O formato do cardápio continua sendo respeitado.
// =====================================================

function listarGruposEscolha(
  produto
) {
  if (
    !Array.isArray(
      produto?.escolhas
    )
  ) {
    return [];
  }

  return produto.escolhas;
}


function nomeGrupoEscolha(
  grupo
) {
  return (
    grupo?.nome ||
    grupo?.titulo ||
    grupo?.id ||
    "opção"
  );
}


function grupoObrigatorio(
  grupo
) {
  if (
    grupo?.obrigatorio ===
    true
  ) {
    return true;
  }

  const minimo =
    numeroSeguro(
      grupo?.minimo ??
      grupo?.min ??
      grupo?.quantidadeMinima,
      0
    );

  return minimo > 0;
}


function opcoesGrupo(
  grupo
) {
  const candidatos = [
    grupo?.opcoes,
    grupo?.itens,
    grupo?.valores,
    grupo?.alternativas,
  ];

  for (
    const candidato of
    candidatos
  ) {
    if (
      Array.isArray(
        candidato
      )
    ) {
      return candidato;
    }
  }

  return [];
}


function nomeEscolha(
  escolha
) {
  if (
    typeof escolha ===
    "string"
  ) {
    return escolha;
  }

  return (
    escolha?.nome ||
    escolha?.label ||
    escolha?.valor ||
    ""
  );
}


function precoEscolha(
  escolha
) {
  if (
    typeof escolha ===
    "string"
  ) {
    return 0;
  }

  return (
    numeroSeguro(
      escolha?.preco,
      0
    ) || 0
  );
}


function encontrarEscolhaNoGrupo(
  grupo,
  termo
) {
  const busca =
    normalizarTexto(
      termo
    );

  if (!busca) {
    return null;
  }

  const opcoes =
    opcoesGrupo(
      grupo
    );

  const exata =
    opcoes.find(
      (opcao) =>
        normalizarTexto(
          nomeEscolha(opcao)
        ) === busca
    );

  if (exata) {
    return exata;
  }

  const candidatas =
    opcoes.filter(
      (opcao) => {
        const nome =
          normalizarTexto(
            nomeEscolha(opcao)
          );

        if (
          !nome ||
          busca.length < 2
        ) {
          return false;
        }

        return (
          nome.includes(
            busca
          ) ||
          busca.includes(
            nome
          )
        );
      }
    );

  if (
    candidatas.length === 1
  ) {
    return candidatas[0];
  }

  return null;
}


// =====================================================
// PREÇO DO PRODUTO
// =====================================================

function precoBaseProduto(
  produto,
  variacao = null
) {
  if (
    variacao &&
    numeroSeguro(
      variacao.preco
    ) !== null
  ) {
    return numeroSeguro(
      variacao.preco,
      0
    );
  }

  return numeroSeguro(
    produto?.preco,
    0
  );
}


// =====================================================
// PREÇO UNITÁRIO DO ITEM
// =====================================================

function calcularPrecoUnitarioItem(
  item
) {
  const produto =
    obterProdutoPorId(
      item.produtoId
    );

  if (!produto) {
    return 0;
  }

  let total =
    precoBaseProduto(
      produto,
      item.variacao
    );

  if (
    item.opcao
  ) {
    total +=
      precoOpcao(
        item.opcao
      );
  }

  for (
    const escolha of
    Object.values(
      item.escolhas || {}
    )
  ) {
    if (
      Array.isArray(
        escolha
      )
    ) {
      for (
        const subEscolha of
        escolha
      ) {
        total +=
          precoEscolha(
            subEscolha
          );
      }
    } else {
      total +=
        precoEscolha(
          escolha
        );
    }
  }

  return Number(
    total.toFixed(2)
  );
}


// =====================================================
// TOTAL DO ITEM
// =====================================================

function calcularTotalItem(
  item
) {
  const quantidade =
    Math.max(
      1,
      Number(
        item.quantidade || 1
      )
    );

  return Number(
    (
      calcularPrecoUnitarioItem(
        item
      ) * quantidade
    ).toFixed(2)
  );
}


// =====================================================
// SUBTOTAL
// =====================================================

function calcularSubtotal(
  estado
) {
  const total =
    (
      estado?.carrinho ||
      []
    ).reduce(
      (
        soma,
        item
      ) =>
        soma +
        calcularTotalItem(
          item
        ),
      0
    );

  return Number(
    total.toFixed(2)
  );
}


// =====================================================
// TAXA DE ENTREGA
// =====================================================

function calcularTaxaEntrega(
  estado
) {
  const subtotal =
    calcularSubtotal(
      estado
    );

  if (
    subtotal >
    LIMITE_ENTREGA_GRATIS
  ) {
    return 0;
  }

  return TAXA_ENTREGA;
}


// =====================================================
// TOTAL DO PEDIDO
// =====================================================

function calcularTotalPedido(
  estado
) {
  const subtotal =
    calcularSubtotal(
      estado
    );

  const taxa =
    calcularTaxaEntrega(
      estado
    );

  return Number(
    (
      subtotal +
      taxa
    ).toFixed(2)
  );
}


// =====================================================
// CRIAÇÃO DO ITEM DO CARRINHO
// =====================================================

function criarItemCarrinho(
  produto,
  quantidade = 1
) {
  return {
    itemId:
      gerarIdItemCarrinho(),

    produtoId:
      produto.id,

    nome:
      produto.nome,

    quantidade:
      Math.max(
        1,
        Number(
          quantidade || 1
        )
      ),

    variacao: null,

    opcao: null,

    escolhas: {},
  };
}


// =====================================================
// BUSCA DE ITEM NO CARRINHO
// =====================================================

function encontrarItensCarrinhoPorProduto(
  estado,
  produtoId
) {
  return (
    estado?.carrinho ||
    []
  ).filter(
    (item) =>
      item.produtoId ===
      produtoId
  );
}


function encontrarItemCarrinhoPorId(
  estado,
  itemId
) {
  return (
    estado?.carrinho ||
    []
  ).find(
    (item) =>
      item.itemId ===
      itemId
  ) || null;
}


// =====================================================
// VERIFICAÇÃO DE CONFIGURAÇÃO
// =====================================================

function variacaoObrigatoria(
  produto
) {
  const variacoes =
    listarVariacoesProduto(
      produto
    );

  if (
    variacoes.length <= 1
  ) {
    return false;
  }

  // Caso o JSON traga explicitamente a regra,
  // ela vence.
  if (
    produto?.variacaoObrigatoria ===
    false
  ) {
    return false;
  }

  return true;
}


function opcaoObrigatoria(
  produto
) {
  const opcoes =
    listarOpcoesProduto(
      produto
    );

  if (
    opcoes.length === 0
  ) {
    return false;
  }

  if (
    produto?.opcaoObrigatoria ===
    true
  ) {
    return true;
  }

  return false;
}


// =====================================================
// PENDÊNCIAS DO ITEM
// =====================================================

function pendenciasItem(
  item
) {
  const produto =
    obterProdutoPorId(
      item.produtoId
    );

  if (!produto) {
    return [];
  }

  const pendencias =
    [];

  if (
    variacaoObrigatoria(
      produto
    ) &&
    !item.variacao
  ) {
    pendencias.push({
      tipo: "variacao",
      produto,
      item,
      opcoes:
        listarVariacoesProduto(
          produto
        ),
    });
  }

  if (
    opcaoObrigatoria(
      produto
    ) &&
    !item.opcao
  ) {
    pendencias.push({
      tipo: "opcao",
      produto,
      item,
      opcoes:
        listarOpcoesProduto(
          produto
        ),
    });
  }

  for (
    const grupo of
    listarGruposEscolha(
      produto
    )
  ) {
    if (
      !grupoObrigatorio(
        grupo
      )
    ) {
      continue;
    }

    const chave =
      grupo.id ||
      nomeGrupoEscolha(
        grupo
      );

    const valor =
      item.escolhas?.[
        chave
      ];

    const preenchido =
      Array.isArray(valor)
        ? valor.length > 0
        : Boolean(valor);

    if (
      !preenchido
    ) {
      pendencias.push({
        tipo:
          "escolha",

        produto,

        item,

        grupo,

        opcoes:
          opcoesGrupo(
            grupo
          ),
      });
    }
  }

  return pendencias;
}


// =====================================================
// PRIMEIRA PENDÊNCIA DO PEDIDO
// =====================================================

function primeiraPendencia(
  estado
) {
  for (
    const item of
    estado?.carrinho || []
  ) {
    const pendencias =
      pendenciasItem(
        item
      );

    if (
      pendencias.length > 0
    ) {
      return pendencias[0];
    }
  }

  return null;
}


// =====================================================
// FORMATAÇÃO DE OPÇÕES
// =====================================================

function formatarListaOpcoes(
  opcoes,
  obterNome,
  obterPreco
) {
  return opcoes
    .map(
      (opcao) => {
        const nome =
          obterNome(
            opcao
          );

        const preco =
          obterPreco(
            opcao
          );

        if (
          preco > 0
        ) {
          return (
            `• ${nome} (+${formatarReal(preco)})`
          );
        }

        return `• ${nome}`;
      }
    )
    .join("\n");
}


// =====================================================
// PERGUNTA DA PENDÊNCIA
// =====================================================

function perguntaPendencia(
  pendencia
) {
  if (!pendencia) {
    return null;
  }

  const produto =
    pendencia.produto;

  if (
    pendencia.tipo ===
    "variacao"
  ) {
    return (
      `Para *${produto.nome}*, qual opção você prefere?\n\n` +
      formatarListaOpcoes(
        pendencia.opcoes,
        (variacao) =>
          variacao.nome,
        (variacao) =>
          numeroSeguro(
            variacao.preco,
            0
          )
      )
    );
  }

  if (
    pendencia.tipo ===
    "opcao"
  ) {
    return (
      `Para *${produto.nome}*, escolha uma opção:\n\n` +
      formatarListaOpcoes(
        pendencia.opcoes,
        nomeOpcao,
        precoOpcao
      )
    );
  }

  if (
    pendencia.tipo ===
    "escolha"
  ) {
    const grupo =
      pendencia.grupo;

    return (
      `Para *${produto.nome}*, escolha ${nomeGrupoEscolha(grupo)}:\n\n` +
      formatarListaOpcoes(
        pendencia.opcoes,
        nomeEscolha,
        precoEscolha
      )
    );
  }

  return null;
}


// =====================================================
// CONFIGURAÇÃO DE PENDÊNCIA PELA RESPOSTA
// =====================================================
//
// Exemplo:
//
// Bot:
// "Jantinha 1: mandioca ou batata frita?"
//
// Cliente:
// "mandioca"
//
// Aqui configuramos a Jantinha.
// NÃO procuramos "mandioca" no cardápio.
// =====================================================

function tentarResolverPendencia(
  estado,
  texto
) {
  const pendencia =
    primeiraPendencia(
      estado
    );

  if (!pendencia) {
    return {
      resolvida: false,
      motivo:
        "sem_pendencia",
    };
  }

  const item =
    pendencia.item;

  if (
    pendencia.tipo ===
    "variacao"
  ) {
    const variacao =
      encontrarVariacao(
        pendencia.produto,
        texto
      );

    if (!variacao) {
      return {
        resolvida: false,
        motivo:
          "variacao_nao_encontrada",
        pendencia,
      };
    }

    item.variacao =
      variacao;

    return {
      resolvida: true,
      tipo: "variacao",
      valor:
        variacao.nome,
      item,
    };
  }

  if (
    pendencia.tipo ===
    "opcao"
  ) {
    const opcao =
      encontrarOpcao(
        pendencia.produto,
        texto
      );

    if (!opcao) {
      return {
        resolvida: false,
        motivo:
          "opcao_nao_encontrada",
        pendencia,
      };
    }

    item.opcao =
      opcao;

    return {
      resolvida: true,
      tipo: "opcao",
      valor:
        nomeOpcao(
          opcao
        ),
      item,
    };
  }

  if (
    pendencia.tipo ===
    "escolha"
  ) {
    const escolha =
      encontrarEscolhaNoGrupo(
        pendencia.grupo,
        texto
      );

    if (!escolha) {
      return {
        resolvida: false,
        motivo:
          "escolha_nao_encontrada",
        pendencia,
      };
    }

    const chave =
      pendencia.grupo.id ||
      nomeGrupoEscolha(
        pendencia.grupo
      );

    item.escolhas[
      chave
    ] = escolha;

    return {
      resolvida: true,
      tipo: "escolha",
      valor:
        nomeEscolha(
          escolha
        ),
      item,
    };
  }

  return {
    resolvida: false,
    motivo:
      "tipo_desconhecido",
  };
}


// =====================================================
// ADICIONAR PRODUTO
// =====================================================

function adicionarProdutoAoCarrinho(
  estado,
  produtoId,
  quantidade = 1
) {
  const produto =
    obterProdutoPorId(
      produtoId
    );

  if (!produto) {
    return {
      ok: false,
      erro:
        "produto_invalido",
    };
  }

  if (
    !produtoDisponivelDelivery(
      produto
    )
  ) {
    return {
      ok: false,
      erro:
        "produto_indisponivel",
    };
  }

  const qtd =
    Math.max(
      1,
      Math.floor(
        Number(
          quantidade || 1
        )
      )
    );

  const item =
    criarItemCarrinho(
      produto,
      qtd
    );

  // Se existir somente UMA variação,
  // podemos configurar automaticamente.
  const variacoes =
    listarVariacoesProduto(
      produto
    );

  if (
    variacoes.length === 1
  ) {
    item.variacao =
      variacoes[0];
  }

  estado.carrinho.push(
    item
  );

  estado.resumoConfirmado =
    false;

  estado.finalizado =
    false;

  return {
    ok: true,
    item,
    produto,
  };
}


// =====================================================
// REMOVER PRODUTO
// =====================================================

function removerProdutoDoCarrinho(
  estado,
  produtoId,
  quantidade = null
) {
  const itens =
    encontrarItensCarrinhoPorProduto(
      estado,
      produtoId
    );

  if (
    itens.length === 0
  ) {
    return {
      ok: false,
      erro:
        "produto_nao_esta_no_carrinho",
    };
  }

  // Sem quantidade:
  // remove todas as ocorrências desse produto.
  if (
    quantidade === null ||
    quantidade === undefined
  ) {
    estado.carrinho =
      estado.carrinho.filter(
        (item) =>
          item.produtoId !==
          produtoId
      );

    estado.resumoConfirmado =
      false;

    return {
      ok: true,
    };
  }

  let restante =
    Math.max(
      0,
      Math.floor(
        Number(
          quantidade
        )
      )
    );

  for (
    let i =
      estado.carrinho.length - 1;
    i >= 0 &&
    restante > 0;
    i--
  ) {
    const item =
      estado.carrinho[i];

    if (
      item.produtoId !==
      produtoId
    ) {
      continue;
    }

    if (
      item.quantidade <=
      restante
    ) {
      restante -=
        item.quantidade;

      estado.carrinho.splice(
        i,
        1
      );
    } else {
      item.quantidade -=
        restante;

      restante = 0;
    }
  }

  estado.resumoConfirmado =
    false;

  return {
    ok: true,
  };
}


// =====================================================
// DEFINIR QUANTIDADE
// =====================================================

function definirQuantidadeProduto(
  estado,
  produtoId,
  quantidade
) {
  const qtd =
    Math.floor(
      Number(
        quantidade
      )
    );

  if (
    !Number.isFinite(qtd)
  ) {
    return {
      ok: false,
      erro:
        "quantidade_invalida",
    };
  }

  if (
    qtd <= 0
  ) {
    return removerProdutoDoCarrinho(
      estado,
      produtoId
    );
  }

  const itens =
    encontrarItensCarrinhoPorProduto(
      estado,
      produtoId
    );

  if (
    itens.length === 0
  ) {
    return adicionarProdutoAoCarrinho(
      estado,
      produtoId,
      qtd
    );
  }

  // Para evitar bagunçar configurações diferentes
  // do mesmo produto, ajustamos o primeiro item
  // e removemos duplicações somente quando existem
  // itens equivalentes sem personalização diferente.

  const primeiro =
    itens[0];

  primeiro.quantidade =
    qtd;

  estado.carrinho =
    estado.carrinho.filter(
      (item) =>
        item.produtoId !==
          produtoId ||
        item.itemId ===
          primeiro.itemId
    );

  estado.resumoConfirmado =
    false;

  return {
    ok: true,
    item:
      primeiro,
  };
}


// =====================================================
// CONFIGURAR ITEM VIA AÇÃO DA IA
// =====================================================

function configurarItemCarrinho(
  estado,
  produtoId,
  configuracao = {}
) {
  const itens =
    encontrarItensCarrinhoPorProduto(
      estado,
      produtoId
    );

  if (
    itens.length === 0
  ) {
    return {
      ok: false,
      erro:
        "produto_nao_esta_no_carrinho",
    };
  }

  // Preferimos o item mais recente,
  // porque normalmente é o que acabou de ser adicionado.
  const item =
    itens[
      itens.length - 1
    ];

  const produto =
    obterProdutoPorId(
      produtoId
    );

  if (!produto) {
    return {
      ok: false,
      erro:
        "produto_invalido",
    };
  }

  if (
    configuracao.variacao
  ) {
    const variacao =
      encontrarVariacao(
        produto,
        configuracao.variacao
      );

    if (variacao) {
      item.variacao =
        variacao;
    }
  }

  if (
    configuracao.opcao
  ) {
    const opcao =
      encontrarOpcao(
        produto,
        configuracao.opcao
      );

    if (opcao) {
      item.opcao =
        opcao;
    }
  }

  if (
    configuracao.escolhas &&
    typeof configuracao.escolhas ===
      "object"
  ) {
    for (
      const grupo of
      listarGruposEscolha(
        produto
      )
    ) {
      const chave =
        grupo.id ||
        nomeGrupoEscolha(
          grupo
        );

      const valorInformado =
        configuracao.escolhas[
          chave
        ] ??
        configuracao.escolhas[
          nomeGrupoEscolha(
            grupo
          )
        ];

      if (
        !valorInformado
      ) {
        continue;
      }

      const escolha =
        encontrarEscolhaNoGrupo(
          grupo,
          valorInformado
        );

      if (escolha) {
        item.escolhas[
          chave
        ] = escolha;
      }
    }
  }

  estado.resumoConfirmado =
    false;

  return {
    ok: true,
    item,
  };
}


// =====================================================
// APLICAR UMA AÇÃO DE CARRINHO
// =====================================================
//
// A IA vai retornar:
//
// adicionar
// remover
// definir_quantidade
// configurar
//
// Mas o servidor valida TUDO.
// =====================================================

function aplicarAcaoCarrinho(
  estado,
  acao
) {
  if (
    !acao ||
    typeof acao !==
      "object"
  ) {
    return {
      ok: false,
      erro:
        "acao_invalida",
    };
  }

  const tipo =
    normalizarTexto(
      acao.tipo || ""
    );

  const produtoId =
    acao.produtoId;

  if (
    !produtoId ||
    !obterProdutoPorId(
      produtoId
    )
  ) {
    return {
      ok: false,
      erro:
        "produto_invalido",
      acao,
    };
  }

  if (
    tipo ===
    "adicionar"
  ) {
    const resultado =
      adicionarProdutoAoCarrinho(
        estado,
        produtoId,
        acao.quantidade || 1
      );

    if (
      resultado.ok
    ) {
      configurarItemCarrinho(
        estado,
        produtoId,
        {
          variacao:
            acao.variacao,
          opcao:
            acao.opcao,
          escolhas:
            acao.escolhas,
        }
      );
    }

    return resultado;
  }

  if (
    tipo ===
    "remover"
  ) {
    return removerProdutoDoCarrinho(
      estado,
      produtoId,
      acao.quantidade
    );
  }

  if (
    tipo ===
      "definir_quantidade" ||
    tipo ===
      "definir quantidade"
  ) {
    return definirQuantidadeProduto(
      estado,
      produtoId,
      acao.quantidade
    );
  }

  if (
    tipo ===
    "configurar"
  ) {
    return configurarItemCarrinho(
      estado,
      produtoId,
      {
        variacao:
          acao.variacao,
        opcao:
          acao.opcao,
        escolhas:
          acao.escolhas,
      }
    );
  }

  return {
    ok: false,
    erro:
      "tipo_acao_desconhecido",
    acao,
  };
}


// =====================================================
// APLICAR VÁRIAS AÇÕES
// =====================================================

function aplicarAcoesCarrinho(
  estado,
  acoes = []
) {
  if (
    !Array.isArray(
      acoes
    )
  ) {
    return [];
  }

  const resultados =
    [];

  for (
    const acao of
    acoes
  ) {
    const resultado =
      aplicarAcaoCarrinho(
        estado,
        acao
      );

    resultados.push({
      acao,
      resultado,
    });
  }

  return resultados;
}


// =====================================================
// VERIFICAÇÃO DE BEBIDA
// =====================================================

function pedidoTemBebida(
  estado
) {
  for (
    const item of
    estado?.carrinho || []
  ) {
    const produto =
      obterProdutoPorId(
        item.produtoId
      );

    if (!produto) {
      continue;
    }

    const categoria =
      normalizarTexto(
        produto.categoria ||
        ""
      );

    if (
      categoria.includes(
        "bebida"
      ) ||
      categoria.includes(
        "refrigerante"
      )
    ) {
      return true;
    }
  }

  return false;
}


// =====================================================
// DESCRIÇÃO DAS CONFIGURAÇÕES DO ITEM
// =====================================================

function descricaoConfiguracoesItem(
  item
) {
  const partes =
    [];

  if (
    item.variacao
  ) {
    partes.push(
      item.variacao.nome
    );
  }

  if (
    item.opcao
  ) {
    partes.push(
      nomeOpcao(
        item.opcao
      )
    );
  }

  for (
    const escolha of
    Object.values(
      item.escolhas || {}
    )
  ) {
    if (
      Array.isArray(
        escolha
      )
    ) {
      for (
        const valor of
        escolha
      ) {
        partes.push(
          nomeEscolha(
            valor
          )
        );
      }
    } else if (
      escolha
    ) {
      partes.push(
        nomeEscolha(
          escolha
        )
      );
    }
  }

  return partes
    .filter(Boolean)
    .join(", ");
}


// =====================================================
// RESUMO DOS ITENS
// =====================================================

function gerarResumoItens(
  estado
) {
  if (
    !pedidoTemItens(
      estado
    )
  ) {
    return "Seu pedido ainda está vazio.";
  }

  const linhas =
    [];

  for (
    const item of
    estado.carrinho
  ) {
    const produto =
      obterProdutoPorId(
        item.produtoId
      );

    if (!produto) {
      continue;
    }

    const configuracoes =
      descricaoConfiguracoesItem(
        item
      );

    const totalItem =
      calcularTotalItem(
        item
      );

    let linha =
      `• ${item.quantidade}x ${produto.nome}`;

    if (
      configuracoes
    ) {
      linha +=
        ` (${configuracoes})`;
    }

    linha +=
      ` — ${formatarReal(totalItem)}`;

    linhas.push(
      linha
    );
  }

  return linhas.join(
    "\n"
  );
}


// =====================================================
// RESUMO DE VALORES
// =====================================================

function gerarResumoValores(
  estado
) {
  const subtotal =
    calcularSubtotal(
      estado
    );

  const taxa =
    calcularTaxaEntrega(
      estado
    );

  const total =
    calcularTotalPedido(
      estado
    );

  const linhas = [
    `Subtotal: ${formatarReal(subtotal)}`,
  ];

  if (
    taxa === 0
  ) {
    linhas.push(
      "Entrega: GRÁTIS"
    );
  } else {
    linhas.push(
      `Entrega: ${formatarReal(taxa)}`
    );
  }

  linhas.push(
    `*Total: ${formatarReal(total)}*`
  );

  return linhas.join(
    "\n"
  );
}


// =====================================================
// RESPOSTA DETERMINÍSTICA DO TOTAL
// =====================================================

function respostaTotalPedido(
  estado
) {
  if (
    !pedidoTemItens(
      estado
    )
  ) {
    return (
      "Seu pedido ainda está vazio 😅\n" +
      "Pode me dizer o que você quer pedir."
    );
  }

  return (
    `Até agora seu pedido está assim:\n\n` +
    `${gerarResumoItens(estado)}\n\n` +
    `${gerarResumoValores(estado)}`
  );
}


// =====================================================
// FIM DA PARTE 2/5
//
// NÃO RODE node --check AINDA.
// FALTAM AS PARTES 3, 4 E 5.
// =====================================================

// =====================================================
// TIQUINHO ESPETINHOS - MOTOR V3
// PARTE 3/5
//
// CARDÁPIO CONVERSACIONAL + CONSULTAS +
// INTERPRETADOR IA MULTIAÇÃO + VALIDAÇÃO
//
// COLE IMEDIATAMENTE ABAIXO DA PARTE 2.
// =====================================================


// =====================================================
// CATEGORIAS QUE POSSUEM PRODUTOS DELIVERY
// =====================================================

function categoriasDelivery() {
  return (
    cardapio.categorias || []
  )
    .map((categoria) => {
      const produtos =
        produtosDaCategoria(
          categoria.id
        );

      return {
        ...categoria,
        produtosDelivery:
          produtos,
      };
    })
    .filter(
      (categoria) =>
        categoria
          .produtosDelivery
          .length > 0
    );
}


// =====================================================
// NOME BONITO DA CATEGORIA
// =====================================================

function nomeCategoria(
  categoria
) {
  return (
    categoria?.nome ||
    categoria?.id ||
    "Categoria"
  );
}


// =====================================================
// PREÇO PARA EXIBIÇÃO
// =====================================================
//
// Não usamos IA para falar preço.
// Sai direto do cardapio.json.
// =====================================================

function descricaoPrecoProduto(
  produto
) {
  if (!produto) {
    return "";
  }

  const variacoes =
    listarVariacoesProduto(
      produto
    );

  if (
    variacoes.length > 0
  ) {
    const precos =
      variacoes
        .map(
          (variacao) =>
            numeroSeguro(
              variacao.preco
            )
        )
        .filter(
          (valor) =>
            valor !== null
        );

    if (
      precos.length > 0
    ) {
      const menor =
        Math.min(
          ...precos
        );

      const maior =
        Math.max(
          ...precos
        );

      if (
        Math.abs(
          maior - menor
        ) <
        TOLERANCIA_VALOR
      ) {
        return formatarReal(
          menor
        );
      }

      return (
        `${formatarReal(menor)} a ` +
        `${formatarReal(maior)}`
      );
    }
  }

  const preco =
    numeroSeguro(
      produto.preco
    );

  if (
    preco !== null
  ) {
    return formatarReal(
      preco
    );
  }

  return "";
}


// =====================================================
// DESCRIÇÃO CURTA DE PRODUTO
// =====================================================

function descreverProdutoCardapio(
  produto
) {
  if (!produto) {
    return "";
  }

  const preco =
    descricaoPrecoProduto(
      produto
    );

  let linha =
    `• *${produto.nome}*`;

  if (preco) {
    linha +=
      ` — ${preco}`;
  }

  return linha;
}


// =====================================================
// LISTAR CARDÁPIO POR CATEGORIAS
// =====================================================
//
// "O que vocês têm?"
//
// Não despejamos 80 produtos na cabeça do cliente.
// Primeiro mostramos categorias.
// =====================================================

function listarCategoriasCardapio() {
  const categorias =
    categoriasDelivery();

  if (
    categorias.length === 0
  ) {
    return (
      "Não encontrei categorias disponíveis no cardápio agora."
    );
  }

  const linhas =
    categorias.map(
      (categoria) =>
        `• ${nomeCategoria(categoria)}`
    );

  return (
    "Temos essas opções no cardápio 👇\n\n" +
    linhas.join("\n") +
    "\n\n" +
    "Me fala qual categoria você quer ver 😋"
  );
}


// =====================================================
// LISTAR UMA CATEGORIA
// =====================================================

function listarCategoriaPorId(
  categoriaId
) {
  const categoria =
    obterCategoriaPorId(
      categoriaId
    );

  if (!categoria) {
    return null;
  }

  const produtos =
    produtosDaCategoria(
      categoriaId
    );

  if (
    produtos.length === 0
  ) {
    return (
      `No momento não encontrei itens disponíveis em ` +
      `*${nomeCategoria(categoria)}*.`
    );
  }

  const linhas =
    produtos.map(
      descreverProdutoCardapio
    );

  return (
    `*${nomeCategoria(categoria)}* 👇\n\n` +
    linhas.join("\n") +
    "\n\n" +
    "Se quiser algum, é só me falar o nome e a quantidade."
  );
}


// =====================================================
// LISTAR VARIAÇÕES / OPÇÕES DE PRODUTO
// =====================================================

function detalhesProdutoCardapio(
  produto
) {
  if (!produto) {
    return null;
  }

  const linhas = [
    `*${produto.nome}*`,
  ];

  if (
    produto.descricao
  ) {
    linhas.push(
      produto.descricao
    );
  }

  const variacoes =
    listarVariacoesProduto(
      produto
    );

  if (
    variacoes.length > 0
  ) {
    linhas.push("");
    linhas.push(
      "*Opções:*"
    );

    for (
      const variacao of
      variacoes
    ) {
      const preco =
        numeroSeguro(
          variacao.preco
        );

      linhas.push(
        `• ${variacao.nome}` +
        (
          preco !== null
            ? ` — ${formatarReal(preco)}`
            : ""
        )
      );
    }
  } else {
    const preco =
      numeroSeguro(
        produto.preco
      );

    if (
      preco !== null
    ) {
      linhas.push(
        `Preço: ${formatarReal(preco)}`
      );
    }
  }

  const opcoes =
    listarOpcoesProduto(
      produto
    );

  if (
    opcoes.length > 0
  ) {
    linhas.push("");
    linhas.push(
      "*Opções disponíveis:*"
    );

    for (
      const opcao of
      opcoes
    ) {
      const extra =
        precoOpcao(
          opcao
        );

      linhas.push(
        `• ${nomeOpcao(opcao)}` +
        (
          extra > 0
            ? ` (+${formatarReal(extra)})`
            : ""
        )
      );
    }
  }

  for (
    const grupo of
    listarGruposEscolha(
      produto
    )
  ) {
    const opcoes =
      opcoesGrupo(
        grupo
      );

    if (
      opcoes.length === 0
    ) {
      continue;
    }

    linhas.push("");

    linhas.push(
      `*${nomeGrupoEscolha(grupo)}:*`
    );

    for (
      const escolha of
      opcoes
    ) {
      const extra =
        precoEscolha(
          escolha
        );

      linhas.push(
        `• ${nomeEscolha(escolha)}` +
        (
          extra > 0
            ? ` (+${formatarReal(extra)})`
            : ""
        )
      );
    }
  }

  return linhas.join(
    "\n"
  );
}


// =====================================================
// RESOLVER CATEGORIA DE CONSULTA
// =====================================================

function resolverCategoriaConsulta(
  consulta
) {
  if (!consulta) {
    return [];
  }

  // ID informado pela IA.
  if (
    consulta.categoriaId
  ) {
    const categoria =
      obterCategoriaPorId(
        consulta.categoriaId
      );

    if (categoria) {
      return [
        categoria,
      ];
    }
  }

  // Termo textual como fallback.
  const termo =
    consulta.termo ||
    consulta.categoria ||
    consulta.nome;

  if (!termo) {
    return [];
  }

  return encontrarCategoriasPorTermo(
    termo
  );
}


// =====================================================
// RESOLVER PRODUTO DE CONSULTA
// =====================================================

function resolverProdutoConsulta(
  consulta
) {
  if (!consulta) {
    return [];
  }

  if (
    consulta.produtoId
  ) {
    const produto =
      obterProdutoPorId(
        consulta.produtoId
      );

    if (produto) {
      return [
        produto,
      ];
    }
  }

  const termo =
    consulta.termo ||
    consulta.produto ||
    consulta.nome;

  if (!termo) {
    return [];
  }

  return buscarProdutosCardapio(
    termo
  );
}


// =====================================================
// CONSULTA DETERMINÍSTICA
// =====================================================

function responderUmaConsulta(
  consulta,
  estado
) {
  if (
    !consulta ||
    typeof consulta !==
      "object"
  ) {
    return null;
  }

  const tipo =
    normalizarTexto(
      consulta.tipo || ""
    );

  // ---------------------------------------------------
  // CARDÁPIO GERAL
  // ---------------------------------------------------

  if (
    tipo === "cardapio" ||
    tipo === "menu"
  ) {
    return listarCategoriasCardapio();
  }

  // ---------------------------------------------------
  // TOTAL
  // ---------------------------------------------------

  if (
    tipo === "total" ||
    tipo === "valor_total" ||
    tipo === "valor total"
  ) {
    return respostaTotalPedido(
      estado
    );
  }

  // ---------------------------------------------------
  // CATEGORIA
  // ---------------------------------------------------

  if (
    tipo === "categoria"
  ) {
    const categorias =
      resolverCategoriaConsulta(
        consulta
      );

    if (
      categorias.length === 0
    ) {
      return null;
    }

    const respostas =
      [];

    for (
      const categoria of
      categorias
    ) {
      const resposta =
        listarCategoriaPorId(
          categoria.id
        );

      if (resposta) {
        respostas.push(
          resposta
        );
      }
    }

    return respostas.join(
      "\n\n"
    );
  }

  // ---------------------------------------------------
  // PRODUTO
  // ---------------------------------------------------

  if (
    tipo === "produto"
  ) {
    const produtos =
      resolverProdutoConsulta(
        consulta
      );

    if (
      produtos.length === 0
    ) {
      return null;
    }

    // Se a busca ficou ambígua,
    // não inventamos qual deles era.
    if (
      produtos.length > 1
    ) {
      return (
        "Encontrei algumas opções 👇\n\n" +
        produtos
          .slice(0, 10)
          .map(
            descreverProdutoCardapio
          )
          .join("\n") +
        "\n\nQual deles você quis dizer?"
      );
    }

    return detalhesProdutoCardapio(
      produtos[0]
    );
  }

  return null;
}


// =====================================================
// RESPONDER VÁRIAS CONSULTAS
// =====================================================

function responderConsultas(
  consultas,
  estado
) {
  if (
    !Array.isArray(
      consultas
    ) ||
    consultas.length === 0
  ) {
    return null;
  }

  const respostas =
    [];

  for (
    const consulta of
    consultas
  ) {
    const resposta =
      responderUmaConsulta(
        consulta,
        estado
      );

    if (
      resposta &&
      !respostas.includes(
        resposta
      )
    ) {
      respostas.push(
        resposta
      );
    }
  }

  if (
    respostas.length === 0
  ) {
    return null;
  }

  return respostas.join(
    "\n\n"
  );
}


// =====================================================
// CONSULTA LOCAL ANTES DA IA
// =====================================================
//
// Algumas mensagens são tão óbvias que nem precisamos
// gastar IA.
//
// "cardápio"
// "quanto deu"
//
// Categoria pura também pode ser respondida aqui.
// =====================================================

function detectarConsultaLocal(
  texto
) {
  const msg =
    normalizarTexto(
      texto
    );

  if (!msg) {
    return [];
  }

  if (
    ehPerguntaTotal(
      msg
    )
  ) {
    return [
      {
        tipo: "total",
      },
    ];
  }

  if (
    ehPerguntaCardapio(
      msg
    )
  ) {
    return [
      {
        tipo: "cardapio",
      },
    ];
  }

  // ---------------------------------------------------
  // Mensagem formada apenas por uma categoria.
  //
  // "espetinho"
  // "refrigerante"
  // "porção"
  //
  // Isso é navegação, não compra.
  // ---------------------------------------------------

  const categorias =
    encontrarCategoriasPorTermo(
      msg
    );

  if (
    categorias.length > 0
  ) {
    return categorias.map(
      (categoria) => ({
        tipo: "categoria",
        categoriaId:
          categoria.id,
      })
    );
  }

  return [];
}


// =====================================================
// RESUMO DE PRODUTO PARA IA
// =====================================================
//
// A IA recebe ID + nome + aliases + categoria.
// Não precisa receber descrição gigantesca.
// =====================================================

function resumirProdutoParaIA(
  produto
) {
  return {
    id:
      produto.id,

    nome:
      produto.nome,

    categoriaId:
      produto.categoriaId,

    categoria:
      produto.categoria,

    aliases:
      produto.aliases || [],

    preco:
      numeroSeguro(
        produto.preco
      ),

    variacoes:
      listarVariacoesProduto(
        produto
      ).map(
        (variacao) => ({
          nome:
            variacao.nome,
          preco:
            numeroSeguro(
              variacao.preco
            ),
        })
      ),

    opcoes:
      listarOpcoesProduto(
        produto
      ).map(
        (opcao) => ({
          nome:
            nomeOpcao(
              opcao
            ),
          preco:
            precoOpcao(
              opcao
            ),
        })
      ),

    escolhas:
      listarGruposEscolha(
        produto
      ).map(
        (grupo) => ({
          id:
            grupo.id || null,

          nome:
            nomeGrupoEscolha(
              grupo
            ),

          obrigatorio:
            grupoObrigatorio(
              grupo
            ),

          opcoes:
            opcoesGrupo(
              grupo
            ).map(
              (opcao) => ({
                nome:
                  nomeEscolha(
                    opcao
                  ),
                preco:
                  precoEscolha(
                    opcao
                  ),
              })
            ),
        })
      ),
  };
}


// =====================================================
// CATEGORIAS PARA IA
// =====================================================

function resumirCategoriasParaIA() {
  return categoriasDelivery()
    .map(
      (categoria) => ({
        id:
          categoria.id,

        nome:
          categoria.nome,
      })
    );
}


// =====================================================
// PRODUTOS PERMITIDOS PARA IA
// =====================================================
//
// Priorizamos candidatos encontrados na mensagem,
// mas damos também o catálogo delivery completo.
//
// O ID retornado pela IA será validado novamente
// pelo backend.
//
// =====================================================

function produtosPermitidosParaIA(
  texto
) {
  const candidatos =
    encontrarProdutosNaMensagem(
      texto
    );

  const ids =
    new Set();

  const ordenados =
    [];

  function adicionar(
    produto
  ) {
    if (
      !produto ||
      ids.has(
        produto.id
      )
    ) {
      return;
    }

    ids.add(
      produto.id
    );

    ordenados.push(
      produto
    );
  }

  for (
    const produto of
    candidatos
  ) {
    adicionar(
      produto
    );
  }

  for (
    const produto of
    produtosDelivery
  ) {
    adicionar(
      produto
    );
  }

  return ordenados;
}


// =====================================================
// EXTRAIR JSON DA RESPOSTA DA IA
// =====================================================

function extrairJSON(
  texto
) {
  if (!texto) {
    return null;
  }

  let limpo =
    String(texto)
      .trim();

  limpo =
    limpo.replace(
      /^```json\s*/i,
      ""
    );

  limpo =
    limpo.replace(
      /^```\s*/i,
      ""
    );

  limpo =
    limpo.replace(
      /```$/i,
      ""
    );

  limpo =
    limpo.trim();

  try {
    return JSON.parse(
      limpo
    );
  } catch (_) {
    // tenta localizar o primeiro objeto
  }

  const inicio =
    limpo.indexOf(
      "{"
    );

  const fim =
    limpo.lastIndexOf(
      "}"
    );

  if (
    inicio === -1 ||
    fim === -1 ||
    fim <= inicio
  ) {
    return null;
  }

  try {
    return JSON.parse(
      limpo.slice(
        inicio,
        fim + 1
      )
    );
  } catch (_) {
    return null;
  }
}


// =====================================================
// FORMATO VAZIO DO INTERPRETADOR
// =====================================================

function interpretacaoVazia() {
  return {
    acoes: [],

    consultas: [],

    entrega: {},

    pagamento: {},

    respostaSimNao:
      null,

    encerrarItens:
      false,

    observacao:
      null,
  };
}


// =====================================================
// NORMALIZAR INTERPRETAÇÃO
// =====================================================

function normalizarInterpretacao(
  dados
) {
  const base =
    interpretacaoVazia();

  if (
    !dados ||
    typeof dados !==
      "object" ||
    Array.isArray(
      dados
    )
  ) {
    return base;
  }

  if (
    Array.isArray(
      dados.acoes
    )
  ) {
    base.acoes =
      dados.acoes;
  }

  if (
    Array.isArray(
      dados.consultas
    )
  ) {
    base.consultas =
      dados.consultas;
  }

  if (
    dados.entrega &&
    typeof dados.entrega ===
      "object" &&
    !Array.isArray(
      dados.entrega
    )
  ) {
    base.entrega =
      dados.entrega;
  }

  if (
    dados.pagamento &&
    typeof dados.pagamento ===
      "object" &&
    !Array.isArray(
      dados.pagamento
    )
  ) {
    base.pagamento =
      dados.pagamento;
  }

  if (
    typeof dados.encerrarItens ===
    "boolean"
  ) {
    base.encerrarItens =
      dados.encerrarItens;
  }

  if (
    typeof dados.respostaSimNao ===
    "boolean"
  ) {
    base.respostaSimNao =
      dados.respostaSimNao;
  } else if (
    dados.respostaSimNao ===
    null
  ) {
    base.respostaSimNao =
      null;
  }

  if (
    typeof dados.observacao ===
    "string"
  ) {
    base.observacao =
      dados.observacao;
  }

  return base;
}


// =====================================================
// VALIDAÇÃO DAS AÇÕES DA IA
// =====================================================
//
// O modelo pode interpretar.
// Quem manda no carrinho é o servidor.
// =====================================================

function validarAcoesIA(
  acoes,
  texto = ""
) {
  if (
    !Array.isArray(
      acoes
    )
  ) {
    return [];
  }

  const permitidos =
    new Set([
      "adicionar",
      "remover",
      "configurar",
      "definir_quantidade",
      "definir quantidade",
    ]);

  const mensagem =
    normalizarTexto(
      texto
    );

  const validas =
    [];

  // ---------------------------------------------------
  // Descobre quais aliases aparecem na mensagem
  // e quantos produtos delivery compartilham cada alias.
  //
  // Exemplo:
  // "coca" aparece em vários tamanhos.
  // Portanto "coca" sozinho NÃO autoriza um SKU.
  // ---------------------------------------------------

  const mapaAliases =
    new Map();

  for (
    const produto of
    produtosDelivery
  ) {
    for (
      const alias of
      aliasesProduto(
        produto
      )
    ) {
      if (!alias) {
        continue;
      }

      if (
        !mapaAliases.has(
          alias
        )
      ) {
        mapaAliases.set(
          alias,
          new Set()
        );
      }

      mapaAliases
        .get(alias)
        .add(
          produto.id
        );
    }
  }

  // ---------------------------------------------------
  // Verifica se um produto está semanticamente
  // autorizado pela mensagem original.
  //
  // A IA pode INTERPRETAR.
  // Quem AUTORIZA o SKU é o backend.
  // ---------------------------------------------------

  function produtoAutorizado(
    produto
  ) {
    if (
      !produto ||
      !mensagem
    ) {
      return false;
    }

    const aliases =
      aliasesProduto(
        produto
      )
        .filter(Boolean)
        .sort(
          (a, b) =>
            b.length -
            a.length
        );

    // -----------------------------------------------
    // 1. Nome completo do produto na mensagem.
    //
    // "carne de porco"
    // autoriza Carne de Porco.
    //
    // Mas "carne" NÃO autoriza Carne de Porco,
    // porque o nome completo não apareceu.
    // -----------------------------------------------

    const nomeProduto =
      normalizarTexto(
        produto.nome
      );

    if (
      nomeProduto &&
      mensagem.includes(
        nomeProduto
      )
    ) {
      return true;
    }

    // -----------------------------------------------
    // 2. Alias compartilhado não escolhe SKU sozinho.
    //
    // "coca" aparece em lata, 600ml, 1L e 2L.
    // Precisamos de informação complementar.
    // -----------------------------------------------

    for (
      const alias of
      aliases
    ) {
      if (
        !mensagem.includes(
          alias
        )
      ) {
        continue;
      }

      const produtosDoAlias =
        mapaAliases.get(
          alias
        );

      if (
        produtosDoAlias &&
        produtosDoAlias.size ===
          1
      ) {
        return true;
      }
    }

    // -----------------------------------------------
    // 3. Caso especial de aliases compartilhados:
    // usa informação específica do nome do produto.
    //
    // Exemplo:
    // produto = Refrigerante 2L
    // mensagem = "quero coca 2l"
    //
    // "coca" é compartilhado,
    // mas "2l" diferencia o SKU.
    // -----------------------------------------------

    const palavrasNome =
      nomeProduto
        .split(" ")
        .filter(
          (parte) =>
            parte.length >= 2
        );

    const temAliasCompartilhado =
      aliases.some(
        (alias) => {
          if (
            !mensagem.includes(
              alias
            )
          ) {
            return false;
          }

          const produtosDoAlias =
            mapaAliases.get(
              alias
            );

          return (
            produtosDoAlias &&
            produtosDoAlias.size >
              1
          );
        }
      );

    if (
      temAliasCompartilhado
    ) {
      const partesEspecificas =
        palavrasNome.filter(
          (parte) =>
            ![
              "refrigerante",
              "refri",
            ].includes(
              parte
            )
        );

      const temEspecificidade =
        partesEspecificas.some(
          (parte) =>
            mensagem.includes(
              parte
            )
        );

      if (
        temEspecificidade
      ) {
        return true;
      }
    }

    return false;
  }

  for (
    const acao of
    acoes
  ) {
    if (
      !acao ||
      typeof acao !==
        "object"
    ) {
      continue;
    }

    const tipo =
      normalizarTexto(
        acao.tipo || ""
      );

    if (
      !permitidos.has(
        tipo
      )
    ) {
      continue;
    }

    const produto =
      obterProdutoPorId(
        acao.produtoId
      );

    if (!produto) {
      console.warn(
        "⚠️ IA tentou usar produto inválido:",
        acao.produtoId
      );

      continue;
    }

    // -------------------------------------------------
    // CONFIGURAR fica fora da trava semântica rígida.
    //
    // Respostas de configuração podem ser apenas:
    // "mandioca", "coca-cola", "sem gás" etc.
    //
    // Pendências obrigatórias já são tratadas antes
    // da IA no fluxo principal.
    // -------------------------------------------------

    const exigeAutorizacao =
      tipo ===
        "adicionar" ||
      tipo ===
        "remover" ||
      tipo ===
        "definir_quantidade" ||
      tipo ===
        "definir quantidade";

    if (
      exigeAutorizacao &&
      !produtoAutorizado(
        produto
      )
    ) {
      console.warn(
        "🛡️ Ação da IA bloqueada por falta de autorização semântica:",
        {
          tipo,
          produtoId:
            produto.id,
          produto:
            produto.nome,
          texto,
        }
      );

      continue;
    }

    let quantidade =
      numeroSeguro(
        acao.quantidade,
        1
      );

    quantidade =
      Math.floor(
        quantidade
      );

    if (
      quantidade < 1
    ) {
      quantidade = 1;
    }

    if (
      quantidade > 99
    ) {
      quantidade = 99;
    }

    validas.push({
      tipo:
        tipo ===
        "definir quantidade"
          ? "definir_quantidade"
          : tipo,

      produtoId:
        produto.id,

      quantidade,

      variacao:
        acao.variacao ||
        null,

      opcao:
        acao.opcao ||
        null,

      escolhas:
        (
          acao.escolhas &&
          typeof acao.escolhas ===
            "object"
        )
          ? acao.escolhas
          : {},
    });
  }

  return validas;
}


// =====================================================
// VALIDAÇÃO DAS CONSULTAS DA IA
// =====================================================

function validarConsultasIA(
  consultas
) {
  if (
    !Array.isArray(
      consultas
    )
  ) {
    return [];
  }

  const permitidos =
    new Set([
      "cardapio",
      "menu",
      "categoria",
      "produto",
      "total",
      "valor_total",
      "valor total",
    ]);

  const validas =
    [];

  for (
    const consulta of
    consultas
  ) {
    if (
      !consulta ||
      typeof consulta !==
        "object"
    ) {
      continue;
    }

    const tipo =
      normalizarTexto(
        consulta.tipo || ""
      );

    if (
      !permitidos.has(
        tipo
      )
    ) {
      continue;
    }

    if (
      tipo === "categoria"
    ) {
      if (
        consulta.categoriaId &&
        !obterCategoriaPorId(
          consulta.categoriaId
        )
      ) {
        continue;
      }
    }

    if (
      tipo === "produto"
    ) {
      if (
        consulta.produtoId &&
        !obterProdutoPorId(
          consulta.produtoId
        )
      ) {
        continue;
      }
    }

    validas.push({
      tipo,

      categoriaId:
        consulta.categoriaId ||
        null,

      produtoId:
        consulta.produtoId ||
        null,

      termo:
        consulta.termo ||
        consulta.nome ||
        null,
    });
  }

  return validas;
}


// =====================================================
// EVITAR CONSULTA VIRAR COMPRA
// =====================================================
//
// Segurança extra:
//
// Se a mensagem é uma consulta explícita de produto,
// uma ação "adicionar" daquele mesmo produto precisa
// estar sustentada por linguagem de compra.
//
// Ex:
//
// "tem coca 2l?"
//
// NÃO compra.
//
// "quero coca 2l"
//
// compra.
// =====================================================

function mensagemTemLinguagemCompra(
  texto
) {
  const msg =
    normalizarTexto(
      texto
    );

  const marcadores = [
    "quero ",
    "queria ",
    "vou querer ",
    "me ve ",
    "me vê ",
    "manda ",
    "coloca ",
    "adiciona ",
    "acrescenta ",
    "pode colocar ",
    "pode mandar ",
    "pra mim ",
  ].map(
    normalizarTexto
  );

  return marcadores.some(
    (marcador) =>
      msg.includes(
        marcador
      )
  );
}


// =====================================================
// PROMPT DO INTERPRETADOR
// =====================================================

function criarPromptInterpretador({
  texto,
  estado,
  produtos,
}) {
  const carrinho =
    (
      estado.carrinho ||
      []
    ).map(
      (item) => ({
        produtoId:
          item.produtoId,

        nome:
          item.nome,

        quantidade:
          item.quantidade,

        variacao:
          item.variacao?.nome ||
          null,

        opcao:
          item.opcao
            ? nomeOpcao(
                item.opcao
              )
            : null,

        escolhas:
          Object.fromEntries(
            Object.entries(
              item.escolhas ||
              {}
            ).map(
              ([
                chave,
                valor,
              ]) => [
                chave,

                Array.isArray(
                  valor
                )
                  ? valor.map(
                      nomeEscolha
                    )
                  : nomeEscolha(
                      valor
                    ),
              ]
            )
          ),
      })
    );

  const pendencia =
    primeiraPendencia(
      estado
    );

  const contextoPendencia =
    pendencia
      ? {
          tipo:
            pendencia.tipo,

          produtoId:
            pendencia.produto
              ?.id,

          produto:
            pendencia.produto
              ?.nome,

          grupo:
            pendencia.grupo
              ? nomeGrupoEscolha(
                  pendencia.grupo
                )
              : null,

          opcoes:
            (
              pendencia.opcoes ||
              []
            ).map(
              (opcao) => {
                if (
                  pendencia.tipo ===
                  "variacao"
                ) {
                  return opcao.nome;
                }

                if (
                  pendencia.tipo ===
                  "opcao"
                ) {
                  return nomeOpcao(
                    opcao
                  );
                }

                return nomeEscolha(
                  opcao
                );
              }
            ),
        }
      : null;

  const esquema = {
    acoes: [
      {
        tipo:
          "adicionar|remover|configurar|definir_quantidade",

        produtoId:
          "ID_EXATO_DO_CARDAPIO",

        quantidade:
          1,

        variacao:
          null,

        opcao:
          null,

        escolhas: {},
      },
    ],

    consultas: [
      {
        tipo:
          "cardapio|categoria|produto|total",

        categoriaId:
          null,

        produtoId:
          null,

        termo:
          null,
      },
    ],

    entrega: {
      tipo:
        null,

      nome:
        null,

      endereco:
        null,

      numero:
        null,

      complemento:
        null,

      bairro:
        null,

      referencia:
        null,

      cidade:
        null,
    },

    pagamento: {
      metodo:
        null,

      divisoes: [],

      precisaTroco:
        null,

      trocoPara:
        null,
    },

    respostaSimNao:
      null,

    encerrarItens:
      false,

    observacao:
      null,
  };

  return `
Você é SOMENTE um interpretador estruturado para um bot de pedidos.

NÃO converse com o cliente.
NÃO escreva explicações.
NÃO invente produtos.
NÃO invente IDs.
NÃO invente preços.
NÃO calcule valores.
NÃO complete informação que o cliente não informou.

Retorne SOMENTE JSON válido.

REGRA MAIS IMPORTANTE:

CONSULTAR NÃO É COMPRAR.

Exemplos:

"tem coca 2l?"
= consulta de produto.
NÃO adicionar.

"quanto custa coca?"
= consulta.
NÃO adicionar.

"quais refrigerantes tem?"
= consulta de categoria.
NÃO adicionar.

"quero coca 2l"
= adicionar produto.

"quero 2 carnes e quais refrigerantes tem?"
= adicionar 2 carnes
E
consultar categoria de bebidas/refrigerantes.

Uma mensagem pode gerar VÁRIAS ações
E
VÁRIAS consultas simultaneamente.

NÃO escolha produto específico quando o cliente mencionar apenas uma categoria.

Exemplo:
"quero espetinho"
NÃO escolha Carne, Frango, Porco ou Combo.
Isso deve ser consulta/navegação da categoria de espetinhos,
pois falta o cliente dizer qual espetinho deseja.

"porção"
= consulta de categoria.

"refrigerante"
= consulta de categoria.

"o que vocês têm?"
= consulta cardapio.

"quanto deu?"
= consulta total.

Se o cliente estiver respondendo uma escolha obrigatória pendente,
não adicione um novo produto.
A resposta deve servir para configurar o item pendente.

Se o cliente disser que terminou de escolher os itens,
use:
"encerrarItens": true

Se a mensagem for confirmação ou negação clara,
preencha respostaSimNao com true ou false quando fizer sentido no contexto.

ESTADO ATUAL:
${JSON.stringify(
  {
    etapa:
      estado.etapa,

    carrinho,

    entrega:
      estado.entrega,

    pagamento:
      estado.pagamento,

    aguardando:
      estado.aguardando,

    pendencia:
      contextoPendencia,
  },
  null,
  2
)}

CATEGORIAS VÁLIDAS:
${JSON.stringify(
  resumirCategoriasParaIA(),
  null,
  2
)}

PRODUTOS VÁLIDOS:
${JSON.stringify(
  produtos.map(
    resumirProdutoParaIA
  ),
  null,
  2
)}

FORMATO OBRIGATÓRIO:
${JSON.stringify(
  esquema,
  null,
  2
)}

MENSAGEM DO CLIENTE:
${JSON.stringify(texto)}

Retorne SOMENTE o objeto JSON.
`.trim();
}


// =====================================================
// INTERPRETADOR PRINCIPAL
// =====================================================

async function interpretarMensagem(
  telefone,
  texto,
  estado
) {
  const resultadoVazio =
    interpretacaoVazia();

  // ---------------------------------------------------
  // TOTAL é 100% determinístico.
  // ---------------------------------------------------

  if (
    ehPerguntaTotal(
      texto
    )
  ) {
    resultadoVazio.consultas.push({
      tipo: "total",
    });

    return resultadoVazio;
  }

  // ---------------------------------------------------
  // Cardápio geral puro também.
  // ---------------------------------------------------

  if (
    ehPerguntaCardapio(
      texto
    )
  ) {
    resultadoVazio.consultas.push({
      tipo: "cardapio",
    });

    return resultadoVazio;
  }

  // ---------------------------------------------------
  // Categoria pura.
  // ---------------------------------------------------

  const consultaLocal =
    detectarConsultaLocal(
      texto
    );

  if (
    consultaLocal.length > 0
  ) {
    resultadoVazio.consultas =
      consultaLocal;

    return resultadoVazio;
  }

  // ---------------------------------------------------
  // Escolha obrigatória pendente.
  //
  // Tentamos resolver ANTES da IA.
  // ---------------------------------------------------

  const pendenciaAntes =
    primeiraPendencia(
      estado
    );

  if (
    pendenciaAntes
  ) {
    const tentativa =
      tentarResolverPendencia(
        estado,
        texto
      );

    if (
      tentativa.resolvida
    ) {
      return {
        ...resultadoVazio,

        observacao:
          `pendencia_resolvida:${tentativa.tipo}`,
      };
    }
  }

  // ---------------------------------------------------
  // IA estruturada
  // ---------------------------------------------------

  const produtos =
    produtosPermitidosParaIA(
      texto
    );

  const prompt =
    criarPromptInterpretador({
      texto,
      estado,
      produtos,
    });

  try {
    const completion =
      await openai.chat.completions.create({
        model:
          OPENAI_MODEL,

        temperature:
          0,

        response_format: {
          type:
            "json_object",
        },

        messages: [
          {
            role:
              "system",

            content:
              "Você extrai dados estruturados de pedidos. Retorne somente JSON válido e nunca invente IDs.",
          },

          {
            role:
              "user",

            content:
              prompt,
          },
        ],
      });

    const conteudo =
      completion
        .choices?.[0]
        ?.message
        ?.content;

    const dados =
      extrairJSON(
        conteudo
      );

    if (!dados) {
      console.error(
        "❌ IA retornou JSON inválido:",
        conteudo
      );

      return resultadoVazio;
    }

    const normalizado =
      normalizarInterpretacao(
        dados
      );

    normalizado.acoes =
  validarAcoesIA(
    normalizado.acoes,
    texto
  );

    normalizado.consultas =
      validarConsultasIA(
        normalizado.consultas
      );

    // -------------------------------------------------
    // PROTEÇÃO EXTRA CONTRA COMPRA FANTASMA
    // -------------------------------------------------

    const temLinguagemCompra =
      mensagemTemLinguagemCompra(
        texto
      );

    const temConsulta =
      normalizado
        .consultas
        .length > 0;

    if (
      temConsulta &&
      !temLinguagemCompra
    ) {
      normalizado.acoes =
        normalizado.acoes.filter(
          (acao) =>
            acao.tipo !==
            "adicionar"
        );
    }

    return normalizado;
  } catch (error) {
    console.error(
      "❌ ERRO NO INTERPRETADOR:",
      error.response?.data ||
      error.message
    );

    return resultadoVazio;
  }
}


// =====================================================
// APLICAR DADOS DE ENTREGA INTERPRETADOS
// =====================================================
//
// A Parte 4 vai controlar o fluxo de entrega.
// Aqui apenas guardamos os campos válidos encontrados.
// =====================================================

function aplicarDadosEntregaInterpretados(
  estado,
  entrega
) {
  if (
    !entrega ||
    typeof entrega !==
      "object"
  ) {
    return false;
  }

  const campos = [
    "tipo",
    "nome",
    "endereco",
    "numero",
    "complemento",
    "bairro",
    "referencia",
    "cidade",
  ];

  let alterou =
    false;

  for (
    const campo of
    campos
  ) {
    const valor =
      entrega[
        campo
      ];

    if (
      valor === null ||
      valor === undefined ||
      valor === ""
    ) {
      continue;
    }

    estado.entrega[
      campo
    ] = valor;

    alterou =
      true;
  }

  return alterou;
}


// =====================================================
// APLICAR DADOS DE PAGAMENTO INTERPRETADOS
// =====================================================
//
// A validação pesada fica na Parte 4.
// =====================================================

function aplicarPagamentoInterpretado(
  estado,
  pagamento
) {
  if (
    !pagamento ||
    typeof pagamento !==
      "object"
  ) {
    return false;
  }

  let alterou =
    false;

  if (
    pagamento.metodo
  ) {
    estado.pagamento.metodo =
      pagamento.metodo;

    alterou =
      true;
  }

  if (
    Array.isArray(
      pagamento.divisoes
    ) &&
    pagamento.divisoes.length >
      0
  ) {
    estado.pagamento.divisoes =
      pagamento.divisoes;

    alterou =
      true;
  }

  if (
    typeof pagamento.precisaTroco ===
    "boolean"
  ) {
    estado.pagamento.precisaTroco =
      pagamento.precisaTroco;

    alterou =
      true;
  }

  if (
    pagamento.trocoPara !==
      null &&
    pagamento.trocoPara !==
      undefined
  ) {
    const valor =
      numeroSeguro(
        pagamento.trocoPara
      );

    if (
      valor !== null
    ) {
      estado.pagamento.trocoPara =
        valor;

      alterou =
        true;
    }
  }

  return alterou;
}


// =====================================================
// RESUMO DAS AÇÕES EXECUTADAS
// =====================================================
//
// Isso será usado para montar respostas naturais
// sem deixar a IA mentir sobre o que entrou no carrinho.
// =====================================================

function resumirResultadosAcoes(
  resultados
) {
  if (
    !Array.isArray(
      resultados
    )
  ) {
    return [];
  }

  const mensagens =
    [];

  for (
    const entrada of
    resultados
  ) {
    const acao =
      entrada.acao;

    const resultado =
      entrada.resultado;

    if (
      !resultado?.ok
    ) {
      continue;
    }

    const produto =
      obterProdutoPorId(
        acao.produtoId
      );

    if (!produto) {
      continue;
    }

    if (
      acao.tipo ===
      "adicionar"
    ) {
      mensagens.push(
        `Adicionado: ${acao.quantidade || 1}x ${produto.nome}.`
      );
    }

    if (
      acao.tipo ===
      "remover"
    ) {
      mensagens.push(
        `Removido: ${produto.nome}.`
      );
    }

    if (
      acao.tipo ===
      "definir_quantidade"
    ) {
      mensagens.push(
        `Quantidade de ${produto.nome}: ${acao.quantidade}.`
      );
    }

    if (
      acao.tipo ===
      "configurar"
    ) {
      mensagens.push(
        `Configuração atualizada: ${produto.nome}.`
      );
    }
  }

  return mensagens;
}


// =====================================================
// PROCESSAR INTERPRETAÇÃO ESTRUTURADA
// =====================================================
//
// Importante:
//
// EXECUTA ações
// E
// RESPONDE consultas.
//
// Uma coisa NÃO elimina a outra.
// =====================================================

function executarInterpretacao(
  estado,
  interpretacao
) {
  const resultadosAcoes =
    aplicarAcoesCarrinho(
      estado,
      interpretacao.acoes ||
      []
    );

  aplicarDadosEntregaInterpretados(
    estado,
    interpretacao.entrega
  );

  aplicarPagamentoInterpretado(
    estado,
    interpretacao.pagamento
  );

  const respostaConsultas =
    responderConsultas(
      interpretacao.consultas,
      estado
    );

  const resumoAcoes =
    resumirResultadosAcoes(
      resultadosAcoes
    );

  return {
    resultadosAcoes,
    resumoAcoes,
    respostaConsultas,

    encerrarItens:
      Boolean(
        interpretacao.encerrarItens
      ),

    respostaSimNao:
      interpretacao.respostaSimNao,

    observacao:
      interpretacao.observacao ||
      null,
  };
}


// =====================================================
// RESPOSTA APÓS ALTERAÇÃO DO CARRINHO
// =====================================================

function respostaAlteracaoCarrinho(
  estado,
  execucao
) {
  const partes =
    [];

  if (
    execucao.resumoAcoes
      ?.length > 0
  ) {
    partes.push(
      execucao.resumoAcoes
        .join("\n")
    );
  }

  // ---------------------------------------------------
  // Consulta coexistindo com pedido.
  //
  // É justamente o bug que queremos matar.
  // ---------------------------------------------------

  if (
    execucao.respostaConsultas
  ) {
    partes.push(
      execucao.respostaConsultas
    );
  }

  const pendencia =
    primeiraPendencia(
      estado
    );

  if (pendencia) {
    partes.push(
      perguntaPendencia(
        pendencia
      )
    );

    return partes
      .filter(Boolean)
      .join("\n\n");
  }

  // Se houve consulta, não enterramos a resposta
  // imediatamente com outra pergunta gigante.
  if (
    execucao.respostaConsultas
  ) {
    if (
      pedidoTemItens(
        estado
      )
    ) {
      partes.push(
        "Pode continuar escolhendo. Quando terminar, é só me avisar."
      );
    }

    return partes
      .filter(Boolean)
      .join("\n\n");
  }

  if (
    execucao.resumoAcoes
      ?.length > 0
  ) {
    partes.push(
      "Quer acrescentar mais alguma coisa?"
    );

    return partes.join(
      "\n\n"
    );
  }

  return null;
}


// =====================================================
// FIM DA PARTE 3/5
//
// NÃO RODE node --check AINDA.
//
// FALTAM:
// PARTE 4 = ENTREGA + PAGAMENTO + TROCO + FINALIZAÇÃO
// PARTE 5 = WHATSAPP + FILA + DEBOUNCE + WEBHOOK
// =====================================================

// =====================================================
// TIQUINHO ESPETINHOS - MOTOR V3
// PARTE 4/5
//
// ENTREGA + RETIRADA + PAGAMENTO + TROCO +
// RESUMO FINAL + FLUXO DETERMINÍSTICO
//
// COLE IMEDIATAMENTE ABAIXO DA PARTE 3.
// =====================================================


// =====================================================
// NORMALIZAÇÃO DO TIPO DE ENTREGA
// =====================================================

function normalizarTipoEntrega(valor) {
  const texto =
    normalizarTexto(valor || "");

  if (
    texto.includes("retir") ||
    texto.includes("buscar") ||
    texto.includes("busco") ||
    texto.includes("pegar")
  ) {
    return "retirada";
  }

  if (
    texto.includes("entreg") ||
    texto.includes("delivery") ||
    texto.includes("levar")
  ) {
    return "entrega";
  }

  return null;
}


// =====================================================
// TAXA DE ENTREGA - VERSÃO DEFINITIVA
// =====================================================
//
// A função da Parte 2 é sobrescrita aqui.
//
// Retirada = R$ 0.
// Entrega:
// subtotal > R$ 60 = grátis.
// subtotal <= R$ 60 = R$ 6,90.
//
// Enquanto o tipo ainda não foi informado,
// mostramos a taxa potencial de entrega.
// =====================================================

calcularTaxaEntrega = function (estado) {
  const tipo =
    normalizarTipoEntrega(
      estado?.entrega?.tipo
    );

  if (tipo === "retirada") {
    return 0;
  }

  const subtotal =
    calcularSubtotal(estado);

  if (
    subtotal >
    LIMITE_ENTREGA_GRATIS
  ) {
    return 0;
  }

  return TAXA_ENTREGA;
};


// =====================================================
// ENDEREÇO COMPLETO?
// =====================================================

function enderecoEntregaCompleto(
  estado
) {
  if (
    normalizarTipoEntrega(
      estado?.entrega?.tipo
    ) !== "entrega"
  ) {
    return true;
  }

  const entrega =
    estado.entrega || {};

  return Boolean(
    String(
      entrega.endereco || ""
    ).trim() &&
    String(
      entrega.numero || ""
    ).trim() &&
    String(
      entrega.bairro || ""
    ).trim()
  );
}


// =====================================================
// NORMALIZAR FORMA DE PAGAMENTO
// =====================================================

function normalizarMetodoPagamento(
  valor
) {
  const texto =
    normalizarTexto(valor || "");

  if (!texto) {
    return null;
  }

  if (
    texto.includes("pix")
  ) {
    return "pix";
  }

  if (
    texto.includes("dinheiro") ||
    texto.includes("especie")
  ) {
    return "dinheiro";
  }

  if (
    texto.includes("credito")
  ) {
    return "cartao_credito";
  }

  if (
    texto.includes("debito")
  ) {
    return "cartao_debito";
  }

  if (
    texto === "cartao" ||
    texto.includes("cartao")
  ) {
    return "cartao";
  }

  if (
    texto.includes("misto") ||
    texto.includes("divid")
  ) {
    return "misto";
  }

  return null;
}


// =====================================================
// NOME BONITO DO PAGAMENTO
// =====================================================

function nomeMetodoPagamento(
  metodo
) {
  const normalizado =
    normalizarMetodoPagamento(
      metodo
    ) || metodo;

  const nomes = {
    pix: "PIX",
    dinheiro: "Dinheiro",
    cartao: "Cartão",
    cartao_credito:
      "Cartão de crédito",
    cartao_debito:
      "Cartão de débito",
    misto: "Pagamento misto",
  };

  return (
    nomes[normalizado] ||
    String(
      metodo || ""
    )
  );
}


// =====================================================
// NORMALIZAR DIVISÕES DE PAGAMENTO
// =====================================================

function normalizarDivisoesPagamento(
  divisoes
) {
  if (
    !Array.isArray(divisoes)
  ) {
    return [];
  }

  const resultado = [];

  for (
    const divisao of divisoes
  ) {
    if (
      !divisao ||
      typeof divisao !== "object"
    ) {
      continue;
    }

    const metodo =
      normalizarMetodoPagamento(
        divisao.metodo
      );

    const valor =
      numeroSeguro(
        divisao.valor
      );

    if (
      !metodo ||
      metodo === "misto" ||
      valor === null ||
      valor <= 0
    ) {
      continue;
    }

    resultado.push({
      metodo,
      valor:
        Number(
          valor.toFixed(2)
        ),
    });
  }

  return resultado;
}


// =====================================================
// TOTAL INFORMADO EM PAGAMENTO MISTO
// =====================================================

function totalDivisoesPagamento(
  estado
) {
  const divisoes =
    normalizarDivisoesPagamento(
      estado?.pagamento?.divisoes
    );

  return Number(
    divisoes
      .reduce(
        (soma, divisao) =>
          soma + divisao.valor,
        0
      )
      .toFixed(2)
  );
}


// =====================================================
// PAGAMENTO POSSUI DINHEIRO?
// =====================================================

function pagamentoPossuiDinheiro(
  estado
) {
  const metodo =
    normalizarMetodoPagamento(
      estado?.pagamento?.metodo
    );

  if (
    metodo === "dinheiro"
  ) {
    return true;
  }

  const divisoes =
    normalizarDivisoesPagamento(
      estado?.pagamento?.divisoes
    );

  return divisoes.some(
    (divisao) =>
      divisao.metodo ===
      "dinheiro"
  );
}


// =====================================================
// VALOR EM DINHEIRO NO PAGAMENTO
// =====================================================

function valorPagamentoDinheiro(
  estado
) {
  const metodo =
    normalizarMetodoPagamento(
      estado?.pagamento?.metodo
    );

  if (
    metodo === "dinheiro"
  ) {
    return calcularTotalPedido(
      estado
    );
  }

  const divisoes =
    normalizarDivisoesPagamento(
      estado?.pagamento?.divisoes
    );

  return Number(
    divisoes
      .filter(
        (divisao) =>
          divisao.metodo ===
          "dinheiro"
      )
      .reduce(
        (soma, divisao) =>
          soma + divisao.valor,
        0
      )
      .toFixed(2)
  );
}


// =====================================================
// CALCULAR TROCO
// =====================================================
//
// A IA NÃO faz essa conta.
// =====================================================

function calcularTroco(
  estado
) {
  if (
    !pagamentoPossuiDinheiro(
      estado
    )
  ) {
    return null;
  }

  if (
    estado.pagamento
      .precisaTroco === false
  ) {
    return 0;
  }

  const trocoPara =
    numeroSeguro(
      estado.pagamento
        .trocoPara
    );

  if (
    trocoPara === null
  ) {
    return null;
  }

  const metodo =
    normalizarMetodoPagamento(
      estado.pagamento.metodo
    );

  let valorDevidoEmDinheiro;

  if (
    metodo === "dinheiro"
  ) {
    valorDevidoEmDinheiro =
      calcularTotalPedido(
        estado
      );
  } else {
    valorDevidoEmDinheiro =
      valorPagamentoDinheiro(
        estado
      );
  }

  return Number(
    (
      trocoPara -
      valorDevidoEmDinheiro
    ).toFixed(2)
  );
}


// =====================================================
// PAGAMENTO VÁLIDO?
// =====================================================

function validarPagamento(
  estado
) {
  const pagamento =
    estado?.pagamento || {};

  const metodo =
    normalizarMetodoPagamento(
      pagamento.metodo
    );

  if (!metodo) {
    return {
      ok: false,
      motivo:
        "metodo_ausente",
    };
  }

  const total =
    calcularTotalPedido(
      estado
    );

  if (
    metodo === "misto" ||
    (
      Array.isArray(
        pagamento.divisoes
      ) &&
      pagamento.divisoes
        .length > 1
    )
  ) {
    const divisoes =
      normalizarDivisoesPagamento(
        pagamento.divisoes
      );

    if (
      divisoes.length < 2
    ) {
      return {
        ok: false,
        motivo:
          "divisoes_incompletas",
      };
    }

    const informado =
      Number(
        divisoes
          .reduce(
            (
              soma,
              divisao
            ) =>
              soma +
              divisao.valor,
            0
          )
          .toFixed(2)
      );

    if (
      Math.abs(
        informado - total
      ) >
      TOLERANCIA_VALOR
    ) {
      return {
        ok: false,
        motivo:
          "valor_misto_divergente",
        informado,
        total,
      };
    }
  }

  if (
    pagamentoPossuiDinheiro(
      estado
    )
  ) {
    if (
      pagamento.precisaTroco ===
      null ||
      pagamento.precisaTroco ===
      undefined
    ) {
      return {
        ok: false,
        motivo:
          "troco_nao_informado",
      };
    }

    if (
      pagamento.precisaTroco ===
      true
    ) {
      const trocoPara =
        numeroSeguro(
          pagamento.trocoPara
        );

      if (
        trocoPara === null
      ) {
        return {
          ok: false,
          motivo:
            "troco_para_ausente",
        };
      }

      const troco =
        calcularTroco(
          estado
        );

      if (
        troco === null ||
        troco < 0
      ) {
        return {
          ok: false,
          motivo:
            "troco_para_insuficiente",
        };
      }
    }
  }

  return {
    ok: true,
  };
}


// =====================================================
// APLICAR PAGAMENTO - VERSÃO VALIDADA
// =====================================================

function atualizarPagamento(
  estado,
  dados
) {
  if (
    !dados ||
    typeof dados !== "object"
  ) {
    return false;
  }

  let alterou = false;

  if (
    dados.metodo
  ) {
    const metodo =
      normalizarMetodoPagamento(
        dados.metodo
      );

    if (metodo) {
      estado.pagamento.metodo =
        metodo;

      alterou = true;
    }
  }

  if (
    Array.isArray(
      dados.divisoes
    ) &&
    dados.divisoes.length > 0
  ) {
    const divisoes =
      normalizarDivisoesPagamento(
        dados.divisoes
      );

    if (
      divisoes.length > 0
    ) {
      estado.pagamento.divisoes =
        divisoes;

      if (
        divisoes.length > 1
      ) {
        estado.pagamento.metodo =
          "misto";
      }

      alterou = true;
    }
  }

  if (
    typeof dados.precisaTroco ===
    "boolean"
  ) {
    estado.pagamento.precisaTroco =
      dados.precisaTroco;

    if (
      dados.precisaTroco ===
      false
    ) {
      estado.pagamento.trocoPara =
        null;
    }

    alterou = true;
  }

  const trocoPara =
    numeroSeguro(
      dados.trocoPara
    );

  if (
    trocoPara !== null
  ) {
    estado.pagamento.trocoPara =
      trocoPara;

    estado.pagamento.precisaTroco =
      true;

    alterou = true;
  }

  return alterou;
}


// =====================================================
// APLICAR ENTREGA - VERSÃO VALIDADA
// =====================================================

function atualizarEntrega(
  estado,
  dados
) {
  if (
    !dados ||
    typeof dados !== "object"
  ) {
    return false;
  }

  let alterou = false;

  if (
    dados.tipo
  ) {
    const tipo =
      normalizarTipoEntrega(
        dados.tipo
      );

    if (tipo) {
      estado.entrega.tipo =
        tipo;

      alterou = true;
    }
  }

  const camposTexto = [
    "nome",
    "endereco",
    "numero",
    "complemento",
    "bairro",
    "referencia",
    "cidade",
  ];

  for (
    const campo of camposTexto
  ) {
    const valor =
      dados[campo];

    if (
      valor === null ||
      valor === undefined
    ) {
      continue;
    }

    const limpo =
      String(valor).trim();

    if (!limpo) {
      continue;
    }

    estado.entrega[campo] =
      limpo;

    alterou = true;
  }

  return alterou;
}


// =====================================================
// ENTREGA COMPLETA?
// =====================================================

function dadosEntregaCompletos(
  estado
) {
  const tipo =
    normalizarTipoEntrega(
      estado?.entrega?.tipo
    );

  if (!tipo) {
    return false;
  }

  if (
    tipo === "retirada"
  ) {
    return true;
  }

  return enderecoEntregaCompleto(
    estado
  );
}


// =====================================================
// PRÓXIMA PERGUNTA DE ENTREGA
// =====================================================

function perguntaEntrega(
  estado
) {
  const entrega =
    estado.entrega || {};

  const tipo =
    normalizarTipoEntrega(
      entrega.tipo
    );

  if (!tipo) {
    estado.aguardando =
      "tipo_entrega";

    return (
      "Vai ser para *entrega* ou *retirada*?"
    );
  }

  if (
    tipo === "retirada"
  ) {
    return null;
  }

  if (
    !String(
      entrega.endereco || ""
    ).trim()
  ) {
    estado.aguardando =
      "endereco";

    return (
      "Qual é a *rua/avenida* para entrega?"
    );
  }

  if (
    !String(
      entrega.numero || ""
    ).trim()
  ) {
    estado.aguardando =
      "numero";

    return (
      "Qual o *número* do endereço?"
    );
  }

  if (
    !String(
      entrega.bairro || ""
    ).trim()
  ) {
    estado.aguardando =
      "bairro";

    return (
      "Qual é o *bairro*?"
    );
  }

  estado.aguardando =
    null;

  return null;
}


// =====================================================
// PRÓXIMA PERGUNTA DE PAGAMENTO
// =====================================================

function perguntaPagamento(
  estado
) {
  const pagamento =
    estado.pagamento || {};

  const metodo =
    normalizarMetodoPagamento(
      pagamento.metodo
    );

  if (!metodo) {
    estado.aguardando =
      "pagamento";

    return (
      "Como prefere pagar?\n\n" +
      "• PIX\n" +
      "• Dinheiro\n" +
      "• Cartão\n\n" +
      "Se quiser dividir entre formas de pagamento, também pode."
    );
  }

  if (
    metodo === "misto"
  ) {
    const divisoes =
      normalizarDivisoesPagamento(
        pagamento.divisoes
      );

    if (
      divisoes.length < 2
    ) {
      estado.aguardando =
        "pagamento_misto";

      return (
        `O total é *${formatarReal(calcularTotalPedido(estado))}*.\n\n` +
        "Me diga quanto vai em cada forma de pagamento.\n" +
        "Exemplo: *R$ 50 no dinheiro e o restante no PIX*."
      );
    }

    const totalDivisoes =
      Number(
        divisoes
          .reduce(
            (
              soma,
              divisao
            ) =>
              soma +
              divisao.valor,
            0
          )
          .toFixed(2)
      );

    const totalPedido =
      calcularTotalPedido(
        estado
      );

    if (
      Math.abs(
        totalDivisoes -
        totalPedido
      ) >
      TOLERANCIA_VALOR
    ) {
      estado.aguardando =
        "pagamento_misto";

      return (
        `Os valores informados somam *${formatarReal(totalDivisoes)}*, ` +
        `mas o pedido está em *${formatarReal(totalPedido)}*.\n\n` +
        "Me diga novamente como quer dividir o pagamento."
      );
    }
  }

  if (
    pagamentoPossuiDinheiro(
      estado
    )
  ) {
    if (
      pagamento.precisaTroco ===
      null ||
      pagamento.precisaTroco ===
      undefined
    ) {
      estado.aguardando =
        "troco";

      return (
        "Vai precisar de troco?"
      );
    }

    if (
      pagamento.precisaTroco ===
      true &&
      numeroSeguro(
        pagamento.trocoPara
      ) === null
    ) {
      estado.aguardando =
        "troco_para";

      return (
        "Troco para quanto?"
      );
    }

    if (
      pagamento.precisaTroco ===
      true
    ) {
      const troco =
        calcularTroco(
          estado
        );

      if (
        troco !== null &&
        troco < 0
      ) {
        estado.aguardando =
          "troco_para";

        return (
          "Esse valor é menor que a parte que será paga em dinheiro 😅\n" +
          "Troco para quanto?"
        );
      }
    }
  }

  estado.aguardando =
    null;

  return null;
}


// =====================================================
// FORMATAR ENDEREÇO
// =====================================================

function formatarEndereco(
  estado
) {
  const entrega =
    estado.entrega || {};

  if (
    normalizarTipoEntrega(
      entrega.tipo
    ) === "retirada"
  ) {
    return "Retirada no estabelecimento";
  }

  const partes = [];

  if (
    entrega.endereco
  ) {
    let rua =
      entrega.endereco;

    if (
      entrega.numero
    ) {
      rua +=
        `, ${entrega.numero}`;
    }

    partes.push(rua);
  }

  if (
    entrega.complemento
  ) {
    partes.push(
      entrega.complemento
    );
  }

  if (
    entrega.bairro
  ) {
    partes.push(
      entrega.bairro
    );
  }

  if (
    entrega.cidade
  ) {
    partes.push(
      entrega.cidade
    );
  }

  if (
    entrega.referencia
  ) {
    partes.push(
      `Ref.: ${entrega.referencia}`
    );
  }

  return (
    partes.join(" — ") ||
    "Endereço a confirmar"
  );
}


// =====================================================
// FORMATAR PAGAMENTO
// =====================================================

function formatarPagamento(
  estado
) {
  const pagamento =
    estado.pagamento || {};

  const metodo =
    normalizarMetodoPagamento(
      pagamento.metodo
    );

  if (!metodo) {
    return "A confirmar";
  }

  if (
    metodo === "misto"
  ) {
    const divisoes =
      normalizarDivisoesPagamento(
        pagamento.divisoes
      );

    if (
      divisoes.length === 0
    ) {
      return "Pagamento misto";
    }

    return divisoes
      .map(
        (divisao) =>
          `${nomeMetodoPagamento(divisao.metodo)}: ${formatarReal(divisao.valor)}`
      )
      .join(" + ");
  }

  let resposta =
    nomeMetodoPagamento(
      metodo
    );

  if (
    metodo === "dinheiro"
  ) {
    if (
      pagamento.precisaTroco ===
      false
    ) {
      resposta +=
        " — sem troco";
    }

    if (
      pagamento.precisaTroco ===
      true &&
      numeroSeguro(
        pagamento.trocoPara
      ) !== null
    ) {
      resposta +=
        ` — troco para ${formatarReal(pagamento.trocoPara)}`;

      const troco =
        calcularTroco(
          estado
        );

      if (
        troco !== null &&
        troco >= 0
      ) {
        resposta +=
          ` (troco: ${formatarReal(troco)})`;
      }
    }
  }

  return resposta;
}


// =====================================================
// RESUMO FINAL
// =====================================================

function gerarResumoFinal(
  estado
) {
  const subtotal =
    calcularSubtotal(
      estado
    );

  const taxa =
    calcularTaxaEntrega(
      estado
    );

  const total =
    calcularTotalPedido(
      estado
    );

  const tipo =
    normalizarTipoEntrega(
      estado.entrega.tipo
    );

  const linhas = [
    "🧾 *Resumo do pedido*",
    "",
    gerarResumoItens(
      estado
    ),
    "",
    `Subtotal: ${formatarReal(subtotal)}`,
  ];

  if (
    tipo === "retirada"
  ) {
    linhas.push(
      "Retirada: sem taxa de entrega"
    );
  } else if (
    taxa === 0
  ) {
    linhas.push(
      "Entrega: *GRÁTIS*"
    );
  } else {
    linhas.push(
      `Entrega: ${formatarReal(taxa)}`
    );
  }

  linhas.push(
    `*Total: ${formatarReal(total)}*`
  );

  linhas.push("");
  linhas.push(
    `📍 ${formatarEndereco(estado)}`
  );

  linhas.push(
    `💳 ${formatarPagamento(estado)}`
  );

  if (
    estado.entrega.nome
  ) {
    linhas.push(
      `👤 ${estado.entrega.nome}`
    );
  }

  return linhas.join(
    "\n"
  );
}


// =====================================================
// AVISO DA DEMONSTRAÇÃO
// =====================================================

function mensagemConfirmacaoDemonstracao(
  estado
) {
  return (
    `${gerarResumoFinal(estado)}\n\n` +
    "⚠️ *Esta é uma demonstração da automação do Tiquinho Espetinhos.*\n" +
    "Nenhum pedido real será produzido ou cobrado.\n\n" +
    "Posso confirmar esta demonstração?"
  );
}


// =====================================================
// CONFIRMAÇÃO FINAL DA DEMONSTRAÇÃO
// =====================================================

function mensagemDemonstracaoFinalizada() {
  return (
    "✅ *Demonstração confirmada!*\n\n" +
    "Em uma operação real, neste ponto o pedido poderia seguir para o sistema responsável pelo atendimento.\n\n" +
    "⚠️ Nenhum pedido real foi produzido ou cobrado."
  );
}


// =====================================================
// ENTRAR NO FLUXO DE ENTREGA
// =====================================================

function irParaEntrega(
  estado
) {
  if (
    !pedidoTemItens(
      estado
    )
  ) {
    estado.etapa =
      "itens";

    return (
      "Seu pedido ainda está vazio 😅\n" +
      "Me diga o que você quer pedir."
    );
  }

  const pendencia =
    primeiraPendencia(
      estado
    );

  if (pendencia) {
    estado.etapa =
      "itens";

    return perguntaPendencia(
      pendencia
    );
  }

  estado.etapa =
    "entrega";

  const pergunta =
    perguntaEntrega(
      estado
    );

  if (pergunta) {
    return pergunta;
  }

  estado.etapa =
    "pagamento";

  return perguntaPagamento(
    estado
  );
}


// =====================================================
// AVANÇAR O FLUXO
// =====================================================

function continuarFluxo(
  estado
) {
  // ---------------------------------------------------
  // ITENS
  // ---------------------------------------------------

  if (
    estado.etapa === "itens"
  ) {
    const pendencia =
      primeiraPendencia(
        estado
      );

    if (pendencia) {
      return perguntaPendencia(
        pendencia
      );
    }

    return (
      "Quer acrescentar mais alguma coisa?"
    );
  }

  // ---------------------------------------------------
  // ENTREGA
  // ---------------------------------------------------

  if (
    estado.etapa ===
    "entrega"
  ) {
    const pergunta =
      perguntaEntrega(
        estado
      );

    if (pergunta) {
      return pergunta;
    }

    estado.etapa =
      "pagamento";

    return perguntaPagamento(
      estado
    );
  }

  // ---------------------------------------------------
  // PAGAMENTO
  // ---------------------------------------------------

  if (
    estado.etapa ===
    "pagamento"
  ) {
    const pergunta =
      perguntaPagamento(
        estado
      );

    if (pergunta) {
      return pergunta;
    }

    const validacao =
      validarPagamento(
        estado
      );

    if (
      !validacao.ok
    ) {
      return perguntaPagamento(
        estado
      );
    }

    estado.etapa =
      "confirmacao";

    estado.aguardando =
      "confirmacao_demo";

    return mensagemConfirmacaoDemonstracao(
      estado
    );
  }

  // ---------------------------------------------------
  // CONFIRMAÇÃO
  // ---------------------------------------------------

  if (
    estado.etapa ===
    "confirmacao"
  ) {
    return mensagemConfirmacaoDemonstracao(
      estado
    );
  }

  // ---------------------------------------------------
  // FINALIZADO
  // ---------------------------------------------------

  if (
    estado.etapa ===
      "finalizado" ||
    estado.finalizado
  ) {
    return (
      "A demonstração já foi finalizada ✅\n" +
      "Se quiser começar de novo, envie *reiniciar*."
    );
  }

  return null;
}


// =====================================================
// APLICAR CAMPOS INTERPRETADOS COM VALIDAÇÃO
// =====================================================
//
// A Parte 3 guarda dados crus.
// Aqui normalizamos novamente antes do fluxo.
//
// =====================================================

function consolidarInterpretacaoFluxo(
  estado,
  interpretacao
) {
  if (
    interpretacao?.entrega
  ) {
    atualizarEntrega(
      estado,
      interpretacao.entrega
    );
  }

  if (
    interpretacao?.pagamento
  ) {
    atualizarPagamento(
      estado,
      interpretacao.pagamento
    );
  }
}


// =====================================================
// RESPOSTA PARA "NÃO" DURANTE ITENS
// =====================================================

function tratarNegacaoNoFluxo(
  estado
) {
  if (
    estado.etapa ===
      "itens" &&
    pedidoTemItens(
      estado
    ) &&
    !primeiraPendencia(
      estado
    )
  ) {
    return irParaEntrega(
      estado
    );
  }

  if (
    estado.etapa ===
      "confirmacao"
  ) {
    estado.etapa =
      "itens";

    estado.aguardando =
      null;

    estado.resumoConfirmado =
      false;

    return (
      "Beleza 👍 O que você quer alterar no pedido?"
    );
  }

  return null;
}


// =====================================================
// RESPOSTA PARA "SIM" DURANTE O FLUXO
// =====================================================

function tratarConfirmacaoNoFluxo(
  estado
) {
  if (
    estado.etapa ===
      "confirmacao"
  ) {
    estado.demonstracaoConfirmada =
      true;

    estado.finalizado =
      true;

    estado.etapa =
      "finalizado";

    estado.aguardando =
      null;

    return mensagemDemonstracaoFinalizada();
  }

  if (
    estado.etapa ===
      "itens"
  ) {
    return (
      "Beleza 😋 Me fala o que você quer acrescentar."
    );
  }

  return null;
}


// =====================================================
// TROCO: RESPOSTA DIRETA
// =====================================================
//
// Quando o bot perguntou "vai precisar de troco?"
// podemos tratar "não" sem depender da IA.
// =====================================================

function tratarRespostaTroco(
  estado,
  texto
) {
  if (
    estado.aguardando !==
      "troco"
  ) {
    return false;
  }

  if (
    possuiNegacaoTroco(
      texto
    )
  ) {
    estado.pagamento.precisaTroco =
      false;

    estado.pagamento.trocoPara =
      null;

    estado.aguardando =
      null;

    return true;
  }

  if (
    ehConfirmacao(
      texto
    )
  ) {
    estado.pagamento.precisaTroco =
      true;

    estado.aguardando =
      "troco_para";

    return true;
  }

  return false;
}


// =====================================================
// TROCO PARA: VALOR DIRETO
// =====================================================

function extrairValorMonetarioSimples(
  texto
) {
  const limpo =
    normalizarTexto(
      texto
    )
      .replace(
        /r\$/g,
        ""
      )
      .replace(
        /\./g,
        ""
      )
      .replace(
        /,/g,
        "."
      );

  const match =
    limpo.match(
      /(\d+(?:\.\d{1,2})?)/
    );

  if (!match) {
    return null;
  }

  const valor =
    Number(
      match[1]
    );

  if (
    !Number.isFinite(
      valor
    )
  ) {
    return null;
  }

  return valor;
}


function tratarValorTrocoDireto(
  estado,
  texto
) {
  if (
    estado.aguardando !==
      "troco_para"
  ) {
    return false;
  }

  const valor =
    extrairValorMonetarioSimples(
      texto
    );

  if (
    valor === null
  ) {
    return false;
  }

  estado.pagamento.precisaTroco =
    true;

  estado.pagamento.trocoPara =
    valor;

  estado.aguardando =
    null;

  return true;
}


// =====================================================
// TIPO DE ENTREGA DIRETO
// =====================================================

function tratarTipoEntregaDireto(
  estado,
  texto
) {
  if (
    estado.aguardando !==
      "tipo_entrega"
  ) {
    return false;
  }

  const tipo =
    normalizarTipoEntrega(
      texto
    );

  if (!tipo) {
    return false;
  }

  estado.entrega.tipo =
    tipo;

  estado.aguardando =
    null;

  return true;
}


// =====================================================
// PAGAMENTO DIRETO
// =====================================================

function tratarPagamentoDireto(
  estado,
  texto
) {
  if (
    estado.aguardando !==
      "pagamento"
  ) {
    return false;
  }

  const metodo =
    normalizarMetodoPagamento(
      texto
    );

  if (
    !metodo ||
    metodo === "misto"
  ) {
    return false;
  }

  estado.pagamento.metodo =
    metodo;

  estado.pagamento.divisoes =
    [];

  if (
    metodo !== "dinheiro"
  ) {
    estado.pagamento.precisaTroco =
      false;

    estado.pagamento.trocoPara =
      null;
  }

  estado.aguardando =
    null;

  return true;
}


// =====================================================
// RESUMO DO ESTADO PARA LOG
// =====================================================

function resumoEstadoLog(
  estado
) {
  return {
    etapa:
      estado.etapa,

    itens:
      quantidadeTotalItens(
        estado
      ),

    subtotal:
      calcularSubtotal(
        estado
      ),

    total:
      calcularTotalPedido(
        estado
      ),

    tipoEntrega:
      estado.entrega.tipo,

    pagamento:
      estado.pagamento.metodo,

    aguardando:
      estado.aguardando,

    pendencia:
      primeiraPendencia(
        estado
      )?.tipo ||
      null,
  };
}


// =====================================================
// FIM DA PARTE 4/5
//
// NÃO RODE AINDA.
//
// FALTA SOMENTE:
//
// PARTE 5/5
// PROCESSAMENTO + Z-API + FILA + DEBOUNCE +
// WEBHOOK + EXPRESS + START DO SERVIDOR
//
// =====================================================

// =====================================================
// TIQUINHO ESPETINHOS - MOTOR V3
// PARTE 5/5
//
// LEMBRETE + Z-API + PROCESSAMENTO PRINCIPAL +
// FILA + DEBOUNCE + WEBHOOK + ROTAS + SERVIDOR
//
// COLE IMEDIATAMENTE ABAIXO DA PARTE 4.
// =====================================================


// =====================================================
// HORÁRIO
// =====================================================

function obterHoraLocal() {
  const partes =
    new Intl.DateTimeFormat(
      "pt-BR",
      {
        timeZone:
          TIMEZONE,

        hour:
          "2-digit",

        minute:
          "2-digit",

        hour12:
          false,
      }
    ).formatToParts(
      new Date()
    );

  const hora =
    Number(
      partes.find(
        (parte) =>
          parte.type ===
          "hour"
      )?.value
    );

  const minuto =
    Number(
      partes.find(
        (parte) =>
          parte.type ===
          "minute"
      )?.value
    );

  return {
    hora,
    minuto,
  };
}


function estaAbertoAgora() {
  const {
    hora,
  } =
    obterHoraLocal();

  return (
    hora >= 18 &&
    hora < 23
  );
}


function obterAvisoHorario(
  estado
) {
  if (
    estado.avisoHorarioEnviado
  ) {
    return "";
  }

  estado.avisoHorarioEnviado =
    true;

  if (
    estaAbertoAgora()
  ) {
    return "";
  }

  return (
    "ℹ️ Neste momento o Tiquinho está fora do horário informado de atendimento (18h às 23h), " +
    "mas você pode continuar normalmente esta demonstração de pedido.\n\n"
  );
}


// =====================================================
// Z-API
// =====================================================

async function enviarMensagemZAPI(
  phone,
  message
) {
  if (
    !phone ||
    !message
  ) {
    throw new Error(
      "Telefone ou mensagem ausente no envio Z-API."
    );
  }

  const response =
    await axios.post(
      `${ZAPI_BASE_URL}/send-text`,
      {
        phone,
        message:
          String(message),
      },
      {
        headers: {
          "Client-Token":
            CLIENT_TOKEN,

          "Content-Type":
            "application/json",
        },

        timeout:
          20000,
      }
    );

  return response.data;
}


// =====================================================
// LEMBRETE
// =====================================================

function agendarLembrete(
  phone
) {
  cancelarTimer(
    lembretePorTelefone,
    phone
  );

  const estado =
    obterEstado(
      phone
    );

  if (
    estado.finalizado ||
    estado.demonstracaoConfirmada
  ) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        const atual =
          estadoPorTelefone.get(
            phone
          );

        if (
          !atual ||
          atual.finalizado ||
          atual.demonstracaoConfirmada
        ) {
          lembretePorTelefone.delete(
            phone
          );

          return;
        }

        try {
          await enviarMensagemZAPI(
            phone,
            "Opa 😊 ficou com alguma dúvida? Se quiser, posso continuar seu pedido por aqui."
          );

          atual.lembreteEnviado =
            true;
        } catch (error) {
          console.error(
            `❌ ERRO NO LEMBRETE ${phone}:`,
            error.response?.data ||
            error.message
          );
        } finally {
          lembretePorTelefone.delete(
            phone
          );
        }
      },
      LEMBRETE_MS
    );

  lembretePorTelefone.set(
    phone,
    timer
  );
}


// =====================================================
// ENVIAR RESPOSTA
// =====================================================

async function enviarResposta(
  phone,
  message,
  {
    agendarReminder = true,
  } = {}
) {
  if (!message) {
    return;
  }

  await enviarMensagemZAPI(
    phone,
    message
  );

  atualizarEstado(
    phone
  );

  agendarExpiracao(
    phone
  );

  if (
    agendarReminder
  ) {
    agendarLembrete(
      phone
    );
  } else {
    cancelarTimer(
      lembretePorTelefone,
      phone
    );
  }
}


// =====================================================
// SAUDAÇÃO
// =====================================================

const welcomeMessage =
  `🔥 Olá! Seja bem-vindo ao *Tiquinho Espetinhos*! 😋

Posso te mostrar o cardápio ou você pode fazer seu pedido por aqui mesmo.

Temos espetinhos, jantinhas, porções, combos, bebidas e outras opções.

O que você gostaria de ver?`;


// =====================================================
// REGISTRAR RESPOSTA NO HISTÓRICO
// =====================================================

function registrarInteracao(
  phone,
  userMessage,
  resposta
) {
  adicionarHistorico(
    phone,
    "user",
    userMessage
  );

  adicionarHistorico(
    phone,
    "assistant",
    resposta
  );
}


// =====================================================
// RESPONDER E REGISTRAR
// =====================================================

async function responderCliente(
  phone,
  userMessage,
  resposta,
  {
    reminder = true,
  } = {}
) {
  if (!resposta) {
    return;
  }

  registrarInteracao(
    phone,
    userMessage,
    resposta
  );

  await enviarResposta(
    phone,
    resposta,
    {
      agendarReminder:
        reminder,
    }
  );
}


// =====================================================
// RESPOSTA PARA CAMPO DE ENDEREÇO DIRETO
// =====================================================
//
// Quando o bot perguntou especificamente rua,
// número ou bairro, não precisamos mandar "123"
// para a IA interpretar filosofia existencial.
// =====================================================

function tratarCampoEntregaDireto(
  estado,
  texto
) {
  const valor =
    String(
      texto || ""
    ).trim();

  if (!valor) {
    return false;
  }

  if (
    estado.aguardando ===
    "endereco"
  ) {
    estado.entrega.endereco =
      valor;

    estado.aguardando =
      null;

    return true;
  }

  if (
    estado.aguardando ===
    "numero"
  ) {
    estado.entrega.numero =
      valor;

    estado.aguardando =
      null;

    return true;
  }

  if (
    estado.aguardando ===
    "bairro"
  ) {
    estado.entrega.bairro =
      valor;

    estado.aguardando =
      null;

    return true;
  }

  return false;
}


// =====================================================
// MENSAGEM PARECE ENCERRAR ITENS?
// =====================================================

function mensagemEncerraItens(
  texto
) {
  const msg =
    normalizarTexto(
      texto
    );

  const frases = [
    "so isso",
    "só isso",
    "é só isso",
    "e so isso",
    "mais nada",
    "nao quero mais nada",
    "não quero mais nada",
    "pode fechar",
    "pode finalizar",
    "fechar pedido",
    "finalizar pedido",
    "terminei",
  ].map(
    normalizarTexto
  );

  return frases.some(
    (frase) =>
      msg === frase ||
      msg.includes(
        frase
      )
  );
}


// =====================================================
// PROCESSAMENTO PRINCIPAL
// =====================================================

async function processarMensagem(
  phone,
  userMessage
) {
  console.log(
    `🧠 PROCESSANDO ${phone}: ${userMessage}`
  );

  const estado =
    obterEstado(
      phone
    );

  cancelarTimer(
    lembretePorTelefone,
    phone
  );

  atualizarEstado(
    phone
  );

  agendarExpiracao(
    phone
  );

  const msg =
    normalizarTexto(
      userMessage
    );

  // ---------------------------------------------------
  // RESET
  // ---------------------------------------------------

  if (
    msg === "reiniciar" ||
    msg === "resetar"
  ) {
    resetarConversa(
      phone
    );

    obterEstado(
      phone
    );

    agendarExpiracao(
      phone
    );

    const resposta =
      "🔄 Conversa reiniciada.\n\n" +
      welcomeMessage;

    await responderCliente(
      phone,
      userMessage,
      resposta
    );

    return;
  }

  // ---------------------------------------------------
  // FINALIZADO
  // ---------------------------------------------------

  if (
    estado.finalizado ||
    estado.etapa ===
      "finalizado"
  ) {
    const resposta =
      "Essa demonstração já foi finalizada ✅\n\n" +
      "Se quiser começar outra, envie *reiniciar*.";

    await responderCliente(
      phone,
      userMessage,
      resposta,
      {
        reminder:
          false,
      }
    );

    return;
  }

  // ---------------------------------------------------
  // PRIMEIRA MENSAGEM / SAUDAÇÃO
  // ---------------------------------------------------

  const historico =
    obterHistorico(
      phone
    );

  const primeiraMensagem =
    historico.length === 0;

  if (
    primeiraMensagem &&
    ehSaudacaoPura(
      userMessage
    )
  ) {
    const resposta =
      obterAvisoHorario(
        estado
      ) +
      welcomeMessage;

    await responderCliente(
      phone,
      userMessage,
      resposta
    );

    return;
  }

  // ---------------------------------------------------
  // TOTAL TEM PRIORIDADE EM QUALQUER ETAPA
  //
  // Corrige:
  // "qual valor total?"
  // durante pagamento/troco.
  // ---------------------------------------------------

  if (
    ehPerguntaTotal(
      userMessage
    )
  ) {
    const resposta =
      respostaTotalPedido(
        estado
      );

    await responderCliente(
      phone,
      userMessage,
      resposta
    );

    return;
  }

  // ---------------------------------------------------
  // CONFIRMAÇÃO FINAL
  // ---------------------------------------------------

  if (
    estado.etapa ===
    "confirmacao"
  ) {
    if (
      ehConfirmacao(
        userMessage
      )
    ) {
      const resposta =
        tratarConfirmacaoNoFluxo(
          estado
        );

      await responderCliente(
        phone,
        userMessage,
        resposta,
        {
          reminder:
            false,
        }
      );

      return;
    }

    if (
      ehNegacao(
        userMessage
      )
    ) {
      const resposta =
        tratarNegacaoNoFluxo(
          estado
        );

      await responderCliente(
        phone,
        userMessage,
        resposta
      );

      return;
    }
  }

  // ---------------------------------------------------
  // TROCO SIM / NÃO
  // ---------------------------------------------------

  if (
    estado.aguardando ===
    "troco"
  ) {
    const tratado =
      tratarRespostaTroco(
        estado,
        userMessage
      );

    if (tratado) {
      const resposta =
        continuarFluxo(
          estado
        );

      await responderCliente(
        phone,
        userMessage,
        resposta
      );

      return;
    }
  }

  // ---------------------------------------------------
  // TROCO PARA VALOR
  // ---------------------------------------------------

  if (
    estado.aguardando ===
    "troco_para"
  ) {
    const tratado =
      tratarValorTrocoDireto(
        estado,
        userMessage
      );

    if (tratado) {
      const resposta =
        continuarFluxo(
          estado
        );

      await responderCliente(
        phone,
        userMessage,
        resposta
      );

      return;
    }
  }

  // ---------------------------------------------------
  // ENTREGA OU RETIRADA
  // ---------------------------------------------------

  if (
    estado.aguardando ===
    "tipo_entrega"
  ) {
    const tratado =
      tratarTipoEntregaDireto(
        estado,
        userMessage
      );

    if (tratado) {
      const resposta =
        continuarFluxo(
          estado
        );

      await responderCliente(
        phone,
        userMessage,
        resposta
      );

      return;
    }
  }

  // ---------------------------------------------------
  // ENDEREÇO DIRETO
  // ---------------------------------------------------

  if (
    [
      "endereco",
      "numero",
      "bairro",
    ].includes(
      estado.aguardando
    )
  ) {
    const tratado =
      tratarCampoEntregaDireto(
        estado,
        userMessage
      );

    if (tratado) {
      const resposta =
        continuarFluxo(
          estado
        );

      await responderCliente(
        phone,
        userMessage,
        resposta
      );

      return;
    }
  }

  // ---------------------------------------------------
  // PAGAMENTO DIRETO
  // ---------------------------------------------------

  if (
    estado.aguardando ===
    "pagamento"
  ) {
    const tratado =
      tratarPagamentoDireto(
        estado,
        userMessage
      );

    if (tratado) {
      const resposta =
        continuarFluxo(
          estado
        );

      await responderCliente(
        phone,
        userMessage,
        resposta
      );

      return;
    }
  }

  // ---------------------------------------------------
  // PENDÊNCIA OBRIGATÓRIA
  //
  // "mandioca" configura a Jantinha.
  // ---------------------------------------------------

  const pendencia =
    primeiraPendencia(
      estado
    );

  if (
    pendencia &&
    estado.etapa ===
      "itens"
  ) {
    const tentativa =
      tentarResolverPendencia(
        estado,
        userMessage
      );

    if (
      tentativa.resolvida
    ) {
      const proxima =
        primeiraPendencia(
          estado
        );

      const resposta =
        proxima
          ? perguntaPendencia(
              proxima
            )
          : (
              "Perfeito 👍 Configurado.\n\n" +
              "Quer acrescentar mais alguma coisa?"
            );

      await responderCliente(
        phone,
        userMessage,
        resposta
      );

      return;
    }
  }

  // ---------------------------------------------------
  // ENCERRAR ITENS LOCALMENTE
  // ---------------------------------------------------

  if (
    estado.etapa ===
      "itens" &&
    pedidoTemItens(
      estado
    ) &&
    mensagemEncerraItens(
      userMessage
    )
  ) {
    const resposta =
      irParaEntrega(
        estado
      );

    await responderCliente(
      phone,
      userMessage,
      resposta
    );

    return;
  }

  // ---------------------------------------------------
  // "NÃO" DEPOIS DE
  // "QUER ACRESCENTAR MAIS ALGUMA COISA?"
  // ---------------------------------------------------

  if (
    estado.etapa ===
      "itens" &&
    pedidoTemItens(
      estado
    ) &&
    ehNegacao(
      userMessage
    ) &&
    !primeiraPendencia(
      estado
    )
  ) {
    const resposta =
      irParaEntrega(
        estado
      );

    await responderCliente(
      phone,
      userMessage,
      resposta
    );

    return;
  }

  // ---------------------------------------------------
  // INTERPRETADOR V3
  // ---------------------------------------------------

  const interpretacao =
    await interpretarMensagem(
      phone,
      userMessage,
      estado
    );

  console.log(
    "🤖 INTERPRETAÇÃO:",
    JSON.stringify(
      interpretacao,
      null,
      2
    )
  );

  // ---------------------------------------------------
  // CONSOLIDAR ENTREGA/PAGAMENTO
  // ---------------------------------------------------

  consolidarInterpretacaoFluxo(
    estado,
    interpretacao
  );

  // ---------------------------------------------------
  // EXECUTAR AÇÕES + CONSULTAS
  // ---------------------------------------------------

  const execucao =
    executarInterpretacao(
      estado,
      interpretacao
    );

  console.log(
    "🛒 ESTADO:",
    JSON.stringify(
      resumoEstadoLog(
        estado
      ),
      null,
      2
    )
  );

  // ---------------------------------------------------
  // CONFIRMAÇÃO/NEGAÇÃO INTERPRETADA
  // ---------------------------------------------------

  if (
    execucao.respostaSimNao ===
      true
  ) {
    const respostaConfirmacao =
      tratarConfirmacaoNoFluxo(
        estado
      );

    if (
      respostaConfirmacao
    ) {
      await responderCliente(
        phone,
        userMessage,
        respostaConfirmacao,
        {
          reminder:
            !estado.finalizado,
        }
      );

      return;
    }
  }

  if (
    execucao.respostaSimNao ===
      false
  ) {
    const respostaNegacao =
      tratarNegacaoNoFluxo(
        estado
      );

    if (
      respostaNegacao
    ) {
      await responderCliente(
        phone,
        userMessage,
        respostaNegacao
      );

      return;
    }
  }

  // ---------------------------------------------------
  // IA ENTENDEU QUE ACABARAM OS ITENS
  // ---------------------------------------------------

  if (
    execucao.encerrarItens &&
    pedidoTemItens(
      estado
    )
  ) {
    const resposta =
      irParaEntrega(
        estado
      );

    await responderCliente(
      phone,
      userMessage,
      resposta
    );

    return;
  }

  // ---------------------------------------------------
  // RESPOSTA DE CARRINHO + CONSULTAS
  // ---------------------------------------------------

  const respostaCarrinho =
    respostaAlteracaoCarrinho(
      estado,
      execucao
    );

  if (
    respostaCarrinho
  ) {
    await responderCliente(
      phone,
      userMessage,
      respostaCarrinho
    );

    return;
  }

  // ---------------------------------------------------
  // SE ESTAMOS NO FLUXO DE ENTREGA/PAGAMENTO,
  // CONTINUA A MÁQUINA.
  // ---------------------------------------------------

  if (
    estado.etapa !==
      "itens"
  ) {
    const respostaFluxo =
      continuarFluxo(
        estado
      );

    if (
      respostaFluxo
    ) {
      await responderCliente(
        phone,
        userMessage,
        respostaFluxo
      );

      return;
    }
  }

  // ---------------------------------------------------
  // FALLBACK DE CARDÁPIO
  // ---------------------------------------------------

  if (
    ehPerguntaCardapio(
      userMessage
    )
  ) {
    const resposta =
      listarCategoriasCardapio();

    await responderCliente(
      phone,
      userMessage,
      resposta
    );

    return;
  }

  // ---------------------------------------------------
  // FALLBACK FINAL
  // ---------------------------------------------------

  const resposta =
    pedidoTemItens(
      estado
    )
      ? (
          "Não peguei certinho 😅\n\n" +
          "Você pode me dizer o item que quer adicionar, remover ou consultar."
        )
      : (
          "Não peguei certinho 😅\n\n" +
          "Se quiser, diga *cardápio* que eu te mostro as categorias."
        );

  await responderCliente(
    phone,
    userMessage,
    resposta
  );
}


// =====================================================
// FILA POR TELEFONE
// =====================================================
//
// Map() no V3.
// Uma conversa não atropela a outra.
// =====================================================

function enfileirarPorTelefone(
  phone,
  tarefa
) {
  const anterior =
    filaPorTelefone.get(
      phone
    ) ||
    Promise.resolve();

  const atual =
    anterior
      .catch(
        () => {}
      )
      .then(
        tarefa
      );

  filaPorTelefone.set(
    phone,
    atual
  );

  atual.finally(
    () => {
      if (
        filaPorTelefone.get(
          phone
        ) === atual
      ) {
        filaPorTelefone.delete(
          phone
        );
      }
    }
  );

  return atual;
}


// =====================================================
// DEBOUNCE
// =====================================================

function acumularMensagem(
  phone,
  mensagem
) {
  if (
    !bufferPorTelefone.has(
      phone
    )
  ) {
    bufferPorTelefone.set(
      phone,
      []
    );
  }

  bufferPorTelefone
    .get(
      phone
    )
    .push(
      mensagem
    );

  cancelarTimer(
    timerPorTelefone,
    phone
  );

  const timer =
    setTimeout(
      () => {
        const mensagens =
          bufferPorTelefone.get(
            phone
          ) || [];

        const mensagemCompleta =
          mensagens
            .join("\n")
            .trim();

        bufferPorTelefone.delete(
          phone
        );

        timerPorTelefone.delete(
          phone
        );

        if (
          !mensagemCompleta
        ) {
          return;
        }

        console.log(
          `📦 MENSAGEM AGRUPADA ${phone}:`,
          mensagemCompleta
        );

        enfileirarPorTelefone(
          phone,
          () =>
            processarMensagem(
              phone,
              mensagemCompleta
            )
        ).catch(
          (error) => {
            console.error(
              `❌ ERRO FILA ${phone}:`,
              error.response?.data ||
              error.message
            );
          }
        );
      },
      DEBOUNCE_MS
    );

  timerPorTelefone.set(
    phone,
    timer
  );
}


// =====================================================
// WEBHOOK Z-API
// =====================================================
//
// Mantém o formato do Motor V2:
//
// body.phone
// body.text.message
// body.messageId
// body.fromMe
//
// =====================================================

app.post(
  "/webhook",
  (req, res) => {
    const body =
      req.body;

    console.log(
      "📨 BODY RECEBIDO:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    // Responde imediatamente à Z-API.
    res.status(200).json({
      status:
        "received",
    });

    // -------------------------------------------------
    // Ignora mensagens enviadas pelo próprio bot.
    // -------------------------------------------------

    if (
      body?.fromMe
    ) {
      return;
    }

    // -------------------------------------------------
    // Deduplicação.
    // -------------------------------------------------

    if (
      body?.messageId &&
      mensagemJaProcessada(
        body.messageId
      )
    ) {
      console.log(
        `♻️ IGNORADO messageId duplicado: ${body.messageId}`
      );

      return;
    }

    // -------------------------------------------------
    // Dados no formato confirmado pelo Motor V2.
    // -------------------------------------------------

    const phone =
      body?.phone;

    const userMessage =
      body?.text?.message
        ?.trim();

    if (
      !phone ||
      !userMessage
    ) {
      console.log(
        "⚠️ IGNORADO: sem telefone ou texto."
      );

      return;
    }

    console.log(
      `📱 ${phone}: ${userMessage}`
    );

    // Cliente respondeu:
    // mata o lembrete pendente.
    cancelarTimer(
      lembretePorTelefone,
      phone
    );

    // -------------------------------------------------
    // RESET entra sem debounce.
    // -------------------------------------------------

    const msg =
      normalizarTexto(
        userMessage
      );

    if (
      msg === "reiniciar" ||
      msg === "resetar"
    ) {
      enfileirarPorTelefone(
        phone,
        () =>
          processarMensagem(
            phone,
            userMessage
          )
      ).catch(
        (error) => {
          console.error(
            "❌ ERRO NO RESET:",
            error.response?.data ||
            error.message
          );
        }
      );

      return;
    }

    // -------------------------------------------------
    // Mensagem normal entra no debounce.
    // -------------------------------------------------

    acumularMensagem(
      phone,
      userMessage
    );
  }
);


// =====================================================
// ROTA PRINCIPAL
// =====================================================

app.get(
  "/",
  (req, res) => {
    res.send(
      "🔥 Tiquinho Espetinhos - Motor V3 rodando"
    );
  }
);


// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      motor:
        "v3",

      estabelecimento:
        cardapio
          .estabelecimento
          ?.nome ||
        "Tiquinho Espetinhos",

      produtosDelivery:
        produtosDelivery.length,

      categorias:
        categoriasDelivery()
          .length,

      zapiInstanceConfigured:
        Boolean(
          ZAPI_INSTANCE
        ),

      clientTokenConfigured:
        Boolean(
          CLIENT_TOKEN
        ),

      openaiConfigured:
        Boolean(
          OPENAI_API_KEY
        ),

      debounceMs:
        DEBOUNCE_MS,

      reminderMs:
        LEMBRETE_MS,

      sessionExpirationMs:
        EXPIRACAO_SESSAO_MS,

      timestamp:
        new Date()
          .toISOString(),
    });
  }
);


// =====================================================
// TRATAMENTO DE ERRO EXPRESS
// =====================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "❌ ERRO EXPRESS:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(500).json({
      status:
        "error",
    });
  }
);


// =====================================================
// SERVIDOR
// =====================================================

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {
    console.log(
      ""
    );

    console.log(
      "========================================"
    );

    console.log(
      "🔥 TIQUINHO ESPETINHOS - MOTOR V3"
    );

    console.log(
      `🚀 PORTA: ${PORT}`
    );

    console.log(
      `📦 PRODUTOS DELIVERY: ${produtosDelivery.length}`
    );

    console.log(
      `📂 CATEGORIAS: ${categoriasDelivery().length}`
    );

    console.log(
      `⏱️ DEBOUNCE: ${DEBOUNCE_MS}ms`
    );

    console.log(
      `🔔 LEMBRETE: ${LEMBRETE_MS}ms`
    );

    console.log(
      `🧹 EXPIRAÇÃO: ${EXPIRACAO_SESSAO_MS}ms`
    );

    console.log(
      "========================================"
    );

    console.log(
      ""
    );
  }
);


// =====================================================
// FIM DO MOTOR V3
// =====================================================