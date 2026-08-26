require("dotenv").config();

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

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
    `Variáveis ausentes: ${missingEnvVars.join(", ")}`
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

const DEBOUNCE_MS = 4000;
const LEMBRETE_MS = 60 * 1000;
const EXPIRACAO_SESSAO_MS =
  4 * 60 * 60 * 1000;

const MAX_MESSAGES = 20;

// Regra provisória aprovada para a demo.
const TAXA_ENTREGA = 6.90;
const LIMITE_ENTREGA_GRATIS = 60;

const TOLERANCIA_VALOR = 0.02;

const TIMEZONE =
  "America/Sao_Paulo";

// =====================================================
// CARDÁPIO / PROMPT
// =====================================================

const caminhoCardapio = path.join(
  __dirname,
  "cardapio.json"
);

const caminhoPrompt = path.join(
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

    return JSON.parse(conteudo);
  } catch (error) {
    console.error(
      "ERRO AO CARREGAR CARDÁPIO:",
      error.message
    );

    process.exit(1);
  }
}

function carregarPrompt() {
  try {
    return fs.readFileSync(
      caminhoPrompt,
      "utf8"
    );
  } catch (error) {
    console.error(
      "ERRO AO CARREGAR PROMPT:",
      error.message
    );

    process.exit(1);
  }
}

const cardapio = carregarCardapio();
const systemPrompt = carregarPrompt();

console.log(
  `CARDÁPIO CARREGADO: ${
    cardapio.estabelecimento?.nome ||
    "sem nome"
  }`
);

console.log(
  "PROMPT CARREGADO: Tiquinho Espetinhos"
);

// =====================================================
// TEXTO
// =====================================================

function normalizarTexto(texto = "") {
  return String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .trim();
}

const normalizarBusca =
  normalizarTexto;

function ehSaudacaoPura(texto) {
  const mensagem =
    normalizarTexto(texto);

  return [
    "oi",
    "oii",
    "oiii",
    "ola",
    "opa",
    "bom dia",
    "boa tarde",
    "boa noite",
  ].includes(mensagem);
}

function ehConfirmacao(texto) {
  const msg =
    normalizarTexto(texto);

  return [
    "sim",
    "pode",
    "pode sim",
    "confirmo",
    "confirmar",
    "pode confirmar",
    "fechado",
    "isso",
    "isso mesmo",
  ].includes(msg);
}

function ehNegacao(texto) {
  const msg =
    normalizarTexto(texto);

  return (
    msg === "nao" ||
    msg === "não" ||
    msg.includes("nao quero") ||
    msg.includes("sem isso") ||
    msg.includes("so isso") ||
    msg.includes("só isso") ||
    msg.includes("nao precisa")
  );
}

function possuiNegacaoTroco(texto) {
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

function formatarReal(valor) {
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

// =====================================================
// ÍNDICE DO CARDÁPIO
// =====================================================

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

const produtosPorId =
  new Map(
    todosProdutos.map(
      (produto) => [
        produto.id,
        produto,
      ]
    )
  );

function obterProdutoPorId(id) {
  return (
    produtosPorId.get(id) ||
    null
  );
}

function buscarProdutosCardapio(
  termo
) {
  const busca =
    normalizarBusca(termo);

  if (!busca) {
    return [];
  }

  return todosProdutos.filter(
    (produto) => {
      const nome =
        normalizarBusca(
          produto.nome
        );

      const descricao =
        normalizarBusca(
          produto.descricao || ""
        );

      return (
        nome.includes(busca) ||
        descricao.includes(busca)
      );
    }
  );
}

// =====================================================
// PRODUTOS RELEVANTES NA MENSAGEM
// =====================================================

function encontrarProdutosNaMensagem(
  texto
) {
  const mensagem =
    normalizarBusca(texto);

  if (!mensagem) {
    return [];
  }

  const resultados = [];

  for (
    const produto of
    todosProdutos
  ) {
    // WhatsApp atual é delivery.
    // Não usamos versão de mesa.
    if (
      produto.contexto ===
      "mesa"
    ) {
      continue;
    }

    if (
      produto.disponivel ===
      false
    ) {
      continue;
    }

    const nome =
      normalizarBusca(
        produto.nome || ""
      );

    const palavrasNome =
      nome
        .split(/\s+/)
        .filter(
          (palavra) =>
            palavra.length >= 4
        );

    let pontuacao = 0;
    const correspondencias = [];

    if (
      nome &&
      mensagem.includes(nome)
    ) {
      pontuacao += 12;

      correspondencias.push(
        "nome_completo"
      );
    }

    for (
      const palavra of
      palavrasNome
    ) {
      if (
        mensagem.includes(
          palavra
        )
      ) {
        pontuacao += 2;

        correspondencias.push(
          `nome:${palavra}`
        );
      }
    }

    for (
      const alias of
      produto.aliases || []
    ) {
      const aliasNormalizado =
        normalizarBusca(alias);

      if (
        aliasNormalizado &&
        mensagem.includes(
          aliasNormalizado
        )
      ) {
        pontuacao += 8;

        correspondencias.push(
          `alias:${alias}`
        );
      }
    }

    for (
      const opcao of
      produto.opcoes || []
    ) {
      const opcaoNormalizada =
        normalizarBusca(opcao);

      if (
        opcaoNormalizada &&
        mensagem.includes(
          opcaoNormalizada
        )
      ) {
        pontuacao += 6;

        correspondencias.push(
          `opcao:${opcao}`
        );
      }
    }

    for (
      const variacao of
      produto.variacoes || []
    ) {
      const variacaoNormalizada =
        normalizarBusca(
          variacao.nome || ""
        );

      if (
        variacaoNormalizada &&
        mensagem
          .replace(/\s+/g, "")
          .includes(
            variacaoNormalizada
              .replace(/\s+/g, "")
          )
      ) {
        pontuacao += 6;

        correspondencias.push(
          `variacao:${variacao.nome}`
        );
      }
    }

    // Opções presentes em "escolhas".
    for (
      const escolha of
      produto.escolhas || []
    ) {
      for (
        const opcao of
        escolha.opcoes || []
      ) {
        const normalizada =
          normalizarBusca(opcao);

        if (
          normalizada &&
          mensagem.includes(
            normalizada
          )
        ) {
          pontuacao += 4;

          correspondencias.push(
            `escolha:${escolha.id}:${opcao}`
          );
        }
      }
    }

    // Medidas no próprio nome.
    const medidas =
      nome.match(
        /\b\d+(?:[.,]\d+)?\s*(?:ml|l|g|kg)\b/g
      ) || [];

    const mensagemCompacta =
      mensagem.replace(
        /\s+/g,
        ""
      );

    for (
      const medida of medidas
    ) {
      if (
        mensagemCompacta.includes(
          medida.replace(
            /\s+/g,
            ""
          )
        )
      ) {
        pontuacao += 6;

        correspondencias.push(
          `medida:${medida}`
        );
      }
    }

    if (pontuacao >= 2) {
      resultados.push({
        ...produto,
        pontuacao,
        correspondencias,
      });
    }
  }

  return resultados
    .sort(
      (a, b) =>
        b.pontuacao -
        a.pontuacao
    )
    .slice(0, 8);
}

// =====================================================
// ESTADO
// =====================================================

function criarEstadoNovo() {
  return {
    pedido: {
      itens: [],

      subtotal: 0,
      taxaEntrega: null,
      total: 0,

      complementoOferecido:
        false,

      bebidaOferecida:
        false,
    },

    entrega: {
      nome: null,
      rua: null,
      numero: null,
      bairro: null,
      referencia: null,
      localidade: null,

      precisaConsultar:
        false,
    },

    pagamento: {
      metodo: null,
      tipoCartao: null,

      partes: null,

      valorDinheiro: null,
      troco: null,

      confirmado: false,
    },

    etapa: "MONTANDO_PEDIDO",

    pendencia: null,

    aguardandoTroco:
      false,

    totalAtual: null,

    aguardandoConfirmacaoFinal:
      false,

    demonstracaoConfirmada:
      false,

    avisoHorarioEnviado:
      false,

    ultimaAtividade:
      Date.now(),

    lembreteEnviado:
      false,

    timerLembrete:
      null,

    sessaoAtiva:
      true,
  };
}

const historicoPorTelefone = {};
const bufferPorTelefone = {};
const timerPorTelefone = {};
const filaPorTelefone = {};
const estadoPorTelefone = {};

const messageIdsProcessados =
  new Map();

function obterEstado(phone) {
  if (
    !estadoPorTelefone[phone]
  ) {
    estadoPorTelefone[phone] =
      criarEstadoNovo();
  }

  return estadoPorTelefone[phone];
}

function limparTimerLembrete(
  phone
) {
  const estado =
    estadoPorTelefone[phone];

  if (
    estado?.timerLembrete
  ) {
    clearTimeout(
      estado.timerLembrete
    );

    estado.timerLembrete =
      null;
  }
}

function limparSessao(phone) {
  limparTimerLembrete(phone);

  if (
    timerPorTelefone[phone]
  ) {
    clearTimeout(
      timerPorTelefone[phone]
    );

    delete timerPorTelefone[
      phone
    ];
  }

  delete bufferPorTelefone[
    phone
  ];

  delete historicoPorTelefone[
    phone
  ];

  delete estadoPorTelefone[
    phone
  ];

  console.log(
    `SESSÃO LIMPA: ${phone}`
  );
}

function sessaoExpirada(phone) {
  const estado =
    estadoPorTelefone[phone];

  if (!estado) {
    return false;
  }

  return (
    Date.now() -
      estado.ultimaAtividade >
    EXPIRACAO_SESSAO_MS
  );
}

function registrarAtividade(
  phone
) {
  const estado =
    obterEstado(phone);

  estado.ultimaAtividade =
    Date.now();
}

// =====================================================
// HORÁRIO
// =====================================================

function obterHoraLocal() {
  const partes =
    new Intl.DateTimeFormat(
      "pt-BR",
      {
        timeZone: TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }
    )
      .formatToParts(
        new Date()
      );

  const hora =
    Number(
      partes.find(
        (p) =>
          p.type === "hour"
      )?.value
    );

  const minuto =
    Number(
      partes.find(
        (p) =>
          p.type === "minute"
      )?.value
    );

  return {
    hora,
    minuto,
  };
}

function estaAbertoAgora() {
  const { hora } =
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

  if (estaAbertoAgora()) {
    return "";
  }

  return (
    "ℹ️ Neste momento o Tiquinho está fora do horário informado de atendimento (18h às 23h), " +
    "mas você pode continuar normalmente esta demonstração de pedido.\n\n"
  );
}

// =====================================================
// LEMBRETE
// =====================================================

function agendarLembrete(
  phone
) {
  const estado =
    obterEstado(phone);

  limparTimerLembrete(phone);

  if (
    estado.lembreteEnviado ||
    estado.demonstracaoConfirmada
  ) {
    return;
  }

  estado.timerLembrete =
    setTimeout(
      async () => {
        try {
          const atual =
            estadoPorTelefone[
              phone
            ];

          if (
            !atual ||
            atual.lembreteEnviado ||
            atual.demonstracaoConfirmada
          ) {
            return;
          }

          atual.lembreteEnviado =
            true;

          atual.timerLembrete =
            null;

          await enviarMensagemZAPI(
            phone,
            "Opa 😊 ficou com alguma dúvida? Se quiser, posso continuar seu pedido por aqui."
          );

          console.log(
            `LEMBRETE ENVIADO: ${phone}`
          );
        } catch (error) {
          console.error(
            "ERRO AO ENVIAR LEMBRETE:",
            error.response?.data ||
              error.message
          );
        }
      },
      LEMBRETE_MS
    );
}

setInterval(() => {
  for (
    const phone of
    Object.keys(
      estadoPorTelefone
    )
  ) {
    if (
      sessaoExpirada(phone)
    ) {
      limparSessao(phone);
    }
  }
}, 30 * 60 * 1000);

// =====================================================
// CARRINHO
// =====================================================

function normalizarOpcao(
  valor
) {
  if (
    valor === null ||
    valor === undefined
  ) {
    return null;
  }

  return normalizarTexto(valor);
}

function encontrarVariacao(
  produto,
  valor
) {
  if (
    !valor ||
    !Array.isArray(
      produto.variacoes
    )
  ) {
    return null;
  }

  const procurado =
    normalizarTexto(valor)
      .replace(/\s+/g, "");

  return (
    produto.variacoes.find(
      (variacao) =>
        normalizarTexto(
          variacao.nome
        )
          .replace(/\s+/g, "") ===
        procurado
    ) ||
    null
  );
}

function encontrarOpcao(
  produto,
  valor
) {
  if (
    !valor ||
    !Array.isArray(
      produto.opcoes
    )
  ) {
    return null;
  }

  const procurado =
    normalizarTexto(valor);

  return (
    produto.opcoes.find(
      (opcao) =>
        normalizarTexto(
          opcao
        ) === procurado
    ) ||
    null
  );
}

function resolverEscolhas(
  produto,
  escolhasRecebidas = {}
) {
  const resultado = {};

  for (
    const escolha of
    produto.escolhas || []
  ) {
    const valor =
      escolhasRecebidas[
        escolha.id
      ];

    if (!valor) {
      continue;
    }

    const encontrado =
      (escolha.opcoes || [])
        .find(
          (opcao) =>
            normalizarTexto(
              opcao
            ) ===
            normalizarTexto(
              valor
            )
        );

    if (encontrado) {
      resultado[
        escolha.id
      ] = encontrado;
    }
  }

  return resultado;
}

function obterPrecoProduto(
  produto,
  variacaoNome = null
) {
  if (!produto) {
    return null;
  }

  if (
    Array.isArray(
      produto.variacoes
    ) &&
    produto.variacoes.length >
      0
  ) {
    const variacao =
      encontrarVariacao(
        produto,
        variacaoNome
      );

    if (!variacao) {
      return null;
    }

    return Number(
      variacao.preco
    );
  }

  if (
    Number.isFinite(
      Number(produto.preco)
    )
  ) {
    return Number(
      produto.preco
    );
  }

  return null;
}

function itemEstaCompleto(item) {
  const produto =
    obterProdutoPorId(
      item.produtoId
    );

  if (!produto) {
    return false;
  }

  if (
    Array.isArray(
      produto.variacoes
    ) &&
    produto.variacoes.length >
      0 &&
    !item.variacao
  ) {
    return false;
  }

  if (
    Array.isArray(
      produto.opcoes
    ) &&
    produto.opcoes.length >
      0 &&
    !item.opcao
  ) {
    return false;
  }

  for (
    const escolha of
    produto.escolhas || []
  ) {
    if (
      escolha.obrigatorio &&
      !item.escolhas?.[
        escolha.id
      ]
    ) {
      return false;
    }
  }

  return (
    item.precoUnitario !==
      null &&
    item.precoUnitario !==
      undefined
  );
}

function gerarChaveItem(item) {
  return JSON.stringify({
    produtoId:
      item.produtoId,

    variacao:
      item.variacao || null,

    opcao:
      item.opcao || null,

    escolhas:
      item.escolhas || {},
  });
}

function recalcularPedido(
  estado
) {
  let subtotal = 0;

  for (
    const item of
    estado.pedido.itens
  ) {
    if (
      Number.isFinite(
        Number(
          item.precoUnitario
        )
      )
    ) {
      subtotal +=
        Number(
          item.precoUnitario
        ) *
        Number(
          item.quantidade || 1
        );
    }
  }

  subtotal =
    Number(
      subtotal.toFixed(2)
    );

  estado.pedido.subtotal =
    subtotal;

  if (subtotal <= 0) {
    estado.pedido.taxaEntrega =
      null;

    estado.pedido.total =
      0;

    estado.totalAtual =
      null;

    return;
  }

  if (
    estado.entrega
      .precisaConsultar
  ) {
    estado.pedido.taxaEntrega =
      null;

    estado.pedido.total =
      null;

    estado.totalAtual =
      null;

    return;
  }

  const taxa =
    subtotal >
    LIMITE_ENTREGA_GRATIS
      ? 0
      : TAXA_ENTREGA;

  estado.pedido.taxaEntrega =
    taxa;

  estado.pedido.total =
    Number(
      (
        subtotal +
        taxa
      ).toFixed(2)
    );

  estado.totalAtual =
    estado.pedido.total;
}

function adicionarItem(
  estado,
  acao
) {
  const produto =
    obterProdutoPorId(
      acao.produtoId
    );

  if (
    !produto ||
    produto.disponivel ===
      false ||
    produto.contexto ===
      "mesa"
  ) {
    return false;
  }

  const quantidade =
    Math.max(
      1,
      Number(
        acao.quantidade
      ) || 1
    );

  const variacaoObj =
    encontrarVariacao(
      produto,
      acao.variacao
    );

  const variacao =
    variacaoObj?.nome ||
    null;

  const opcao =
    encontrarOpcao(
      produto,
      acao.opcao
    );

  const escolhas =
    resolverEscolhas(
      produto,
      acao.escolhas || {}
    );

  const precoUnitario =
    obterPrecoProduto(
      produto,
      variacao
    );

  const novoItem = {
    produtoId:
      produto.id,

    nome:
      produto.nome,

    categoria:
      produto.categoria,

    quantidade,

    variacao,

    opcao,

    escolhas,

    precoUnitario,
  };

  const chave =
    gerarChaveItem(
      novoItem
    );

  const existente =
    estado.pedido.itens.find(
      (item) =>
        gerarChaveItem(
          item
        ) === chave
    );

  if (existente) {
    existente.quantidade +=
      quantidade;
  } else {
    estado.pedido.itens.push(
      novoItem
    );
  }

  recalcularPedido(estado);

  return true;
}

function configurarItem(
  estado,
  acao
) {
  const item =
    [...estado.pedido.itens]
      .reverse()
      .find(
        (itemAtual) =>
          itemAtual.produtoId ===
          acao.produtoId
      );

  if (!item) {
    return false;
  }

  const produto =
    obterProdutoPorId(
      item.produtoId
    );

  if (!produto) {
    return false;
  }

  if (acao.variacao) {
    const variacao =
      encontrarVariacao(
        produto,
        acao.variacao
      );

    if (variacao) {
      item.variacao =
        variacao.nome;
    }
  }

  if (acao.opcao) {
    const opcao =
      encontrarOpcao(
        produto,
        acao.opcao
      );

    if (opcao) {
      item.opcao =
        opcao;
    }
  }

  const novasEscolhas =
    resolverEscolhas(
      produto,
      acao.escolhas || {}
    );

  item.escolhas = {
    ...(item.escolhas || {}),
    ...novasEscolhas,
  };

  item.precoUnitario =
    obterPrecoProduto(
      produto,
      item.variacao
    );

  recalcularPedido(estado);

  return true;
}

function removerItem(
  estado,
  acao
) {
  const indice =
    estado.pedido.itens
      .findIndex(
        (item) =>
          item.produtoId ===
          acao.produtoId
      );

  if (indice === -1) {
    return false;
  }

  const item =
    estado.pedido.itens[
      indice
    ];

  const quantidade =
    Number(
      acao.quantidade
    );

  if (
    Number.isFinite(
      quantidade
    ) &&
    quantidade > 0 &&
    item.quantidade >
      quantidade
  ) {
    item.quantidade -=
      quantidade;
  } else {
    estado.pedido.itens.splice(
      indice,
      1
    );
  }

  recalcularPedido(estado);

  return true;
}

function definirQuantidade(
  estado,
  acao
) {
  const item =
    [...estado.pedido.itens]
      .reverse()
      .find(
        (itemAtual) =>
          itemAtual.produtoId ===
          acao.produtoId
      );

  if (!item) {
    return false;
  }

  const quantidade =
    Number(
      acao.quantidade
    );

  if (
    !Number.isFinite(
      quantidade
    ) ||
    quantidade < 1
  ) {
    return false;
  }

  item.quantidade =
    quantidade;

  recalcularPedido(estado);

  return true;
}

function aplicarAcoesPedido(
  estado,
  acoes = []
) {
  let alterou = false;

  for (
    const acao of
    Array.isArray(acoes)
      ? acoes
      : []
  ) {
    if (
      !acao ||
      !acao.produtoId
    ) {
      continue;
    }

    if (
      acao.tipo === "adicionar"
    ) {
      alterou =
        adicionarItem(
          estado,
          acao
        ) || alterou;
    }

    if (
      acao.tipo === "configurar"
    ) {
      alterou =
        configurarItem(
          estado,
          acao
        ) || alterou;
    }

    if (
      acao.tipo === "remover"
    ) {
      alterou =
        removerItem(
          estado,
          acao
        ) || alterou;
    }

    if (
      acao.tipo ===
      "definir_quantidade"
    ) {
      alterou =
        definirQuantidade(
          estado,
          acao
        ) || alterou;
    }
  }

  return alterou;
}

function encontrarPendencia(
  estado
) {
  for (
    const item of
    estado.pedido.itens
  ) {
    const produto =
      obterProdutoPorId(
        item.produtoId
      );

    if (!produto) {
      continue;
    }

    if (
      Array.isArray(
        produto.variacoes
      ) &&
      produto.variacoes.length >
        0 &&
      !item.variacao
    ) {
      return {
        tipo: "variacao",

        item,

        produto,

        opcoes:
          produto.variacoes.map(
            (v) => v.nome
          ),
      };
    }

    if (
      Array.isArray(
        produto.opcoes
      ) &&
      produto.opcoes.length >
        0 &&
      !item.opcao
    ) {
      return {
        tipo: "opcao",

        item,

        produto,

        opcoes:
          produto.opcoes,
      };
    }

    for (
      const escolha of
      produto.escolhas || []
    ) {
      if (
        escolha.obrigatorio &&
        !item.escolhas?.[
          escolha.id
        ]
      ) {
        return {
          tipo: "escolha",

          item,

          produto,

          escolhaId:
            escolha.id,

          nome:
            escolha.nome,

          opcoes:
            escolha.opcoes || [],
        };
      }
    }
  }

  return null;
}

function pedidoTemBebida(
  estado
) {
  return estado.pedido.itens
    .some(
      (item) =>
        normalizarTexto(
          item.categoria
        ) ===
        "bebidas"
    );
}

function pedidoTemItens(
  estado
) {
  return (
    estado.pedido.itens
      .length > 0
  );
}

// =====================================================
// RESUMOS
// =====================================================

function formatarItemPedido(
  item
) {
  let linha =
    `${item.quantidade}x ${item.nome}`;

  if (item.variacao) {
    linha +=
      ` (${item.variacao})`;
  }

  if (item.opcao) {
    linha +=
      ` - ${item.opcao}`;
  }

  const escolhas =
    Object.values(
      item.escolhas || {}
    );

  if (
    escolhas.length > 0
  ) {
    linha +=
      ` - ${escolhas.join(", ")}`;
  }

  if (
    Number.isFinite(
      Number(
        item.precoUnitario
      )
    )
  ) {
    const total =
      Number(
        item.precoUnitario
      ) *
      Number(
        item.quantidade
      );

    linha +=
      ` — ${formatarReal(total)}`;
  }

  return linha;
}

function gerarResumoItens(
  estado
) {
  if (
    !pedidoTemItens(
      estado
    )
  ) {
    return "";
  }

  return estado.pedido.itens
    .map(
      formatarItemPedido
    )
    .join("\n");
}

function gerarResumoFinal(
  estado
) {
  const linhas = [
    "📋 *RESUMO DA DEMONSTRAÇÃO*",
    "",
    gerarResumoItens(
      estado
    ),
    "",
    `Subtotal: ${formatarReal(
      estado.pedido.subtotal
    )}`,
  ];

  if (
    estado.entrega
      .precisaConsultar
  ) {
    linhas.push(
      "Entrega: a consultar"
    );

    linhas.push(
      "Total: a confirmar após consulta da entrega"
    );
  } else {
    linhas.push(
      estado.pedido
        .taxaEntrega === 0
        ? "Entrega: Grátis"
        : `Entrega: ${formatarReal(
            estado.pedido
              .taxaEntrega
          )}`
    );

    linhas.push(
      `Total: ${formatarReal(
        estado.pedido.total
      )}`
    );
  }

  linhas.push("");

  if (estado.entrega.nome) {
    linhas.push(
      `Nome: ${estado.entrega.nome}`
    );
  }

  if (
    estado.entrega.rua ||
    estado.entrega.numero
  ) {
    linhas.push(
      `Endereço: ${
        estado.entrega.rua ||
        ""
      } ${
        estado.entrega.numero ||
        ""
      }`.trim()
    );
  }

  if (
    estado.entrega.bairro
  ) {
    linhas.push(
      `Bairro: ${estado.entrega.bairro}`
    );
  }

  if (
    estado.entrega.referencia
  ) {
    linhas.push(
      `Referência: ${estado.entrega.referencia}`
    );
  }

  linhas.push("");

  linhas.push(
    `Pagamento: ${
      formatarPagamentoEstado(
        estado
      )
    }`
  );

  if (
    estado.pagamento.troco !==
      null &&
    estado.pagamento.troco !==
      undefined
  ) {
    linhas.push(
      `Troco: ${formatarReal(
        estado.pagamento.troco
      )}`
    );
  }

  linhas.push("");

  linhas.push(
    "⚠️ Esta é uma demonstração da automação do Tiquinho Espetinhos."
  );

  linhas.push(
    "Nenhum pedido real será produzido ou cobrado."
  );

  linhas.push("");

  linhas.push(
    "Posso confirmar esta demonstração?"
  );

  return linhas.join("\n");
}

function formatarPagamentoEstado(
  estado
) {
  const pagamento =
    estado.pagamento;

  if (!pagamento.metodo) {
    return "não informado";
  }

  if (
    pagamento.metodo ===
      "MISTO" &&
    Array.isArray(
      pagamento.partes
    )
  ) {
    return pagamento.partes
      .map(
        (parte) =>
          `${parte.metodo} ${formatarReal(parte.valor)}`
      )
      .join(" + ");
  }

  if (
    pagamento.metodo ===
      "CARTAO" &&
    pagamento.tipoCartao
  ) {
    return (
      `Cartão ${pagamento.tipoCartao}`
    );
  }

  return pagamento.metodo;
}

// =====================================================
// ENTREGA
// =====================================================

function atualizarEntrega(
  estado,
  dados = {}
) {
  const entrega =
    estado.entrega;

  if (dados.nome) {
    entrega.nome =
      String(
        dados.nome
      ).trim();
  }

  if (dados.rua) {
    entrega.rua =
      String(
        dados.rua
      ).trim();
  }

  if (dados.numero) {
    entrega.numero =
      String(
        dados.numero
      ).trim();
  }

  if (dados.bairro) {
    entrega.bairro =
      String(
        dados.bairro
      ).trim();
  }

  if (dados.referencia) {
    entrega.referencia =
      String(
        dados.referencia
      ).trim();
  }

  if (dados.localidade) {
    entrega.localidade =
      String(
        dados.localidade
      ).trim();
  }

  const textoLocal =
    normalizarTexto(
      [
        entrega.localidade,
        entrega.bairro,
        entrega.rua,
      ]
        .filter(Boolean)
        .join(" ")
    );

  entrega.precisaConsultar =
    (
      textoLocal.includes(
        "aurora"
      ) ||
      textoLocal.includes(
        "sao jorge"
      ) ||
      textoLocal.includes(
        "santa rosa"
      )
    );

  recalcularPedido(estado);
}

function dadosEntregaFaltando(
  estado
) {
  const faltando = [];

  if (
    !estado.entrega.nome
  ) {
    faltando.push("nome");
  }

  if (
    !estado.entrega.rua
  ) {
    faltando.push("rua");
  }

  if (
    !estado.entrega.numero
  ) {
    faltando.push("número");
  }

  if (
    !estado.entrega.bairro
  ) {
    faltando.push("bairro");
  }

  return faltando;
}

// =====================================================
// PAGAMENTO
// =====================================================

function converterValorBrasileiro(
  valor
) {
  if (
    valor === null ||
    valor === undefined
  ) {
    return null;
  }

  let limpo =
    String(valor)
      .replace(
        /R\$/gi,
        ""
      )
      .replace(
        /\s/g,
        ""
      )
      .trim();

  if (
    limpo.includes(".") &&
    limpo.includes(",")
  ) {
    limpo =
      limpo
        .replace(
          /\./g,
          ""
        )
        .replace(
          ",",
          "."
        );
  } else if (
    limpo.includes(",")
  ) {
    limpo =
      limpo.replace(
        ",",
        "."
      );
  }

  const numero =
    Number(limpo);

  return Number.isFinite(
    numero
  )
    ? numero
    : null;
}

function extrairValorMonetario(
  texto
) {
  const normalizado =
    String(texto)
      .replace(
        /R\$/gi,
        ""
      )
      .trim();

  const matches =
    normalizado.match(
      /\d+(?:[.,]\d{1,2})?/g
    );

  if (
    !matches ||
    matches.length === 0
  ) {
    return null;
  }

  return converterValorBrasileiro(
    matches[
      matches.length - 1
    ]
  );
}

function detectarMetodoPagamento(
  segmento
) {
  const s =
    normalizarTexto(
      segmento
    );

  if (
    s.includes("pix")
  ) {
    return "PIX";
  }

  if (
    s.includes(
      "dinheiro"
    ) ||
    s.includes(
      "especie"
    )
  ) {
    return "DINHEIRO";
  }

  if (
    s.includes(
      "cartao"
    ) ||
    s.includes(
      "credito"
    ) ||
    s.includes(
      "debito"
    )
  ) {
    if (
      s.includes(
        "credito"
      )
    ) {
      return "CARTAO CREDITO";
    }

    if (
      s.includes(
        "debito"
      )
    ) {
      return "CARTAO DEBITO";
    }

    return "CARTAO";
  }

  return null;
}

function extrairPagamentoMisto(
  texto,
  total
) {
  if (
    total === null ||
    total === undefined
  ) {
    return null;
  }

  const msg =
    normalizarTexto(texto);

  const metodosPresentes = [
    msg.includes("pix"),

    msg.includes(
      "dinheiro"
    ),

    msg.includes(
      "cartao"
    ) ||
      msg.includes(
        "credito"
      ) ||
      msg.includes(
        "debito"
      ),
  ].filter(Boolean).length;

  if (
    metodosPresentes < 2
  ) {
    return null;
  }

  if (
    msg.includes(
      "metade"
    ) &&
    metodosPresentes === 2
  ) {
    const metade =
      Number(
        (
          total / 2
        ).toFixed(2)
      );

    const partes = [];

    if (
      msg.includes(
        "dinheiro"
      )
    ) {
      partes.push({
        metodo:
          "DINHEIRO",

        valor:
          metade,
      });
    }

    if (
      msg.includes("pix")
    ) {
      partes.push({
        metodo:
          "PIX",

        valor:
          metade,
      });
    }

    if (
      msg.includes(
        "cartao"
      ) ||
      msg.includes(
        "credito"
      ) ||
      msg.includes(
        "debito"
      )
    ) {
      partes.push({
        metodo:
          msg.includes(
            "credito"
          )
            ? "CARTAO CREDITO"
            : msg.includes(
                "debito"
              )
            ? "CARTAO DEBITO"
            : "CARTAO",

        valor:
          metade,
      });
    }

    if (
      partes.length === 2
    ) {
      return partes;
    }
  }

  const segmentos =
    msg
      .split(
        /\s+e\s+/
      )
      .map(
        (s) => s.trim()
      )
      .filter(Boolean);

  if (
    segmentos.length < 2
  ) {
    return null;
  }

  const partes = [];

  let indiceRestante =
    -1;

  let somaConhecida =
    0;

  for (
    let i = 0;
    i < segmentos.length;
    i++
  ) {
    const segmento =
      segmentos[i];

    const metodo =
      detectarMetodoPagamento(
        segmento
      );

    if (!metodo) {
      continue;
    }

    const ehRestante =
      segmento.includes(
        "resto"
      ) ||
      segmento.includes(
        "restante"
      );

    if (ehRestante) {
      partes.push({
        metodo,
        valor: null,
      });

      indiceRestante =
        partes.length - 1;

      continue;
    }

    const valor =
      extrairValorMonetario(
        segmento
      );

    if (
      valor !== null
    ) {
      partes.push({
        metodo,
        valor,
      });

      somaConhecida +=
        valor;
    }
  }

  if (
    partes.length < 2
  ) {
    return null;
  }

  if (
    indiceRestante >= 0
  ) {
    const restante =
      total -
      somaConhecida;

    if (
      restante <
      -TOLERANCIA_VALOR
    ) {
      return {
        erro:
          "Os valores informados ultrapassam o total do pedido.",
      };
    }

    partes[
      indiceRestante
    ].valor =
      Math.max(
        0,
        Number(
          restante.toFixed(2)
        )
      );
  }

  if (
    partes.some(
      (parte) =>
        parte.valor === null
    )
  ) {
    return null;
  }

  return partes;
}

function validarPagamentoMisto(
  partes,
  total
) {
  if (
    !Array.isArray(partes)
  ) {
    return {
      valido: false,
      soma: 0,
    };
  }

  const soma =
    partes.reduce(
      (
        acc,
        parte
      ) =>
        acc +
        Number(
          parte.valor || 0
        ),
      0
    );

  return {
    valido:
      Math.abs(
        soma - total
      ) <=
      TOLERANCIA_VALOR,

    soma,
  };
}

function atualizarPagamento(
  estado,
  interpretacao,
  userMessage
) {
  const total =
    estado.pedido.total;

  if (
    total !== null &&
    total !== undefined
  ) {
    const misto =
      extrairPagamentoMisto(
        userMessage,
        total
      );

    if (
      misto?.erro
    ) {
      return {
        erro:
          misto.erro,
      };
    }

    if (
      Array.isArray(misto)
    ) {
      const validacao =
        validarPagamentoMisto(
          misto,
          total
        );

      if (
        !validacao.valido
      ) {
        return {
          erro:
            `A soma das formas de pagamento deu ${formatarReal(validacao.soma)}, mas o total é ${formatarReal(total)}.`,
        };
      }

      estado.pagamento.metodo =
        "MISTO";

      estado.pagamento.partes =
        misto;

      estado.pagamento.confirmado =
        true;

      estado.aguardandoTroco =
        false;

      return {
        alterou: true,
      };
    }
  }

  const pagamento =
    interpretacao.pagamento ||
    {};

  if (
    pagamento.metodo
  ) {
    const metodo =
      normalizarTexto(
        pagamento.metodo
      );

    if (
      metodo.includes("pix")
    ) {
      estado.pagamento.metodo =
        "PIX";

      estado.pagamento.confirmado =
        true;
    }

    if (
      metodo.includes(
        "cart"
      )
    ) {
      estado.pagamento.metodo =
        "CARTAO";

      const tipo =
        normalizarTexto(
          pagamento.tipoCartao ||
          ""
        );

      if (
        tipo.includes(
          "credito"
        )
      ) {
        estado.pagamento.tipoCartao =
          "crédito";

        estado.pagamento.confirmado =
          true;
      } else if (
        tipo.includes(
          "debito"
        )
      ) {
        estado.pagamento.tipoCartao =
          "débito";

        estado.pagamento.confirmado =
          true;
      } else {
        estado.pagamento.confirmado =
          false;
      }
    }

    if (
      metodo.includes(
        "dinheiro"
      )
    ) {
      estado.pagamento.metodo =
        "DINHEIRO";

      estado.pagamento.confirmado =
        false;

      estado.aguardandoTroco =
        true;
    }
  }

  if (
    estado.pagamento.metodo ===
      "DINHEIRO"
  ) {
    if (
      possuiNegacaoTroco(
        userMessage
      ) ||
      pagamento.semTroco ===
        true
    ) {
      estado.aguardandoTroco =
        false;

      estado.pagamento.troco =
        0;

      estado.pagamento.confirmado =
        true;
    } else {
      const valor =
        pagamento.valorDinheiro ??
        (
          estado.etapa ===
            "TROCO"
            ? extrairValorMonetario(
                userMessage
              )
            : null
        );

      if (
        valor !== null &&
        valor !== undefined &&
        estado.pedido.total !==
          null
      ) {
        const valorNumero =
          Number(valor);

        if (
          valorNumero <
          estado.pedido.total -
            TOLERANCIA_VALOR
        ) {
          return {
            erro:
              `O total é ${formatarReal(estado.pedido.total)}. O valor informado é menor que o total.`,
          };
        }

        estado.pagamento.valorDinheiro =
          valorNumero;

        estado.pagamento.troco =
          Number(
            (
              valorNumero -
              estado.pedido.total
            ).toFixed(2)
          );

        estado.pagamento.confirmado =
          true;

        estado.aguardandoTroco =
          false;
      }
    }
  }

  return {
    alterou:
      Boolean(
        pagamento.metodo
      ),
  };
}

// =====================================================
// INTERPRETAÇÃO COM IA
// =====================================================

function produtosPermitidosParaIA(
  estado,
  produtosDetectados
) {
  const mapa =
    new Map();

  for (
    const produto of
    produtosDetectados
  ) {
    mapa.set(
      produto.id,
      produto
    );
  }

  for (
    const item of
    estado.pedido.itens
  ) {
    const produto =
      obterProdutoPorId(
        item.produtoId
      );

    if (produto) {
      mapa.set(
        produto.id,
        produto
      );
    }
  }

  if (
    estado.pendencia?.produtoId
  ) {
    const produto =
      obterProdutoPorId(
        estado.pendencia
          .produtoId
      );

    if (produto) {
      mapa.set(
        produto.id,
        produto
      );
    }
  }

  return [
    ...mapa.values(),
  ].filter(
    (produto) =>
      produto.contexto !==
      "mesa"
  );
}

function resumirProdutoParaIA(
  produto
) {
  return {
    id:
      produto.id,

    nome:
      produto.nome,

    categoria:
      produto.categoria,

    preco:
      produto.preco,

    variacoes:
      produto.variacoes,

    opcoes:
      produto.opcoes,

    escolhas:
      produto.escolhas,

    descricao:
      produto.descricao,

    composicao:
      produto.composicao,

    contexto:
      produto.contexto,

    disponivel:
      produto.disponivel,
  };
}

async function interpretarMensagem(
  userMessage,
  estado,
  produtosDetectados,
  historico
) {
  const permitidos =
    produtosPermitidosParaIA(
      estado,
      produtosDetectados
    );

  const estadoResumido = {
    etapa:
      estado.etapa,

    pendencia:
      estado.pendencia,

    pedido:
      estado.pedido.itens,

    entrega:
      estado.entrega,

    pagamento:
      estado.pagamento,

    aguardandoConfirmacaoFinal:
      estado.aguardandoConfirmacaoFinal,

    ultimaResposta:
      [...historico]
        .reverse()
        .find(
          (item) =>
            item.role ===
            "assistant"
        )?.content || null,
  };

  const instructions = `
${systemPrompt}

========================================
MODO INTERPRETADOR DO BACKEND
========================================

Nesta chamada você NÃO deve conversar diretamente com o cliente.

Sua função é interpretar a mensagem e retornar SOMENTE JSON válido.

Use APENAS IDs de produtos presentes em PRODUTOS_PERMITIDOS.

Nunca crie IDs.

Se o cliente apenas perguntar se existe, preço, composição ou informação de um produto, NÃO adicione ao pedido. Use intent "consulta".

Somente use ação "adicionar" quando houver intenção clara de pedir/comprar.

Para alterar item já existente:
- configurar = escolher variação, opção ou escolha obrigatória;
- remover = retirar item;
- definir_quantidade = trocar a quantidade existente.

Se o cliente disser "coca 2l", prefira Refrigerante 2L contexto delivery e use opção Coca-Cola.

Nunca escolha produto de contexto mesa.

Se houver uma pendência ativa e o cliente responder apenas com uma opção correspondente, configure o produto pendente.

Retorne exatamente esta estrutura:

{
  "intent": "pedido|alteracao|consulta|dados_entrega|pagamento|confirmacao|continuar|outro",
  "acoes": [
    {
      "tipo": "adicionar|remover|configurar|definir_quantidade",
      "produtoId": "id_exato",
      "quantidade": 1,
      "variacao": null,
      "opcao": null,
      "escolhas": {}
    }
  ],
  "produtoIdsConsulta": [],
  "entrega": {
    "nome": null,
    "rua": null,
    "numero": null,
    "bairro": null,
    "referencia": null,
    "localidade": null
  },
  "pagamento": {
    "metodo": null,
    "tipoCartao": null,
    "valorDinheiro": null,
    "semTroco": false
  },
  "respostaSimNao": "sim|nao|null",
  "encerrarItens": false
}

Regras:
- quantidade deve ser número inteiro positivo;
- não invente endereço;
- não invente pagamento;
- "só isso", "pode fechar", "não quero mais nada" => encerrarItens true;
- responda "sim" ou "nao" em respostaSimNao somente quando isso realmente responder à última pergunta.
`;

  const completion =
    await openai.chat.completions.create({
      model:
        "gpt-4o-mini",

      messages: [
        {
          role:
            "system",

          content:
            instructions,
        },
        {
          role:
            "user",

          content:
            JSON.stringify(
              {
                mensagem:
                  userMessage,

                estado:
                  estadoResumido,

                PRODUTOS_PERMITIDOS:
                  permitidos.map(
                    resumirProdutoParaIA
                  ),
              },
              null,
              2
            ),
        },
      ],

      response_format: {
        type:
          "json_object",
      },

      temperature: 0,

      max_tokens: 900,
    });

  const texto =
    completion.choices?.[0]
      ?.message?.content;

  if (!texto) {
    throw new Error(
      "OpenAI retornou interpretação vazia."
    );
  }

  try {
    const parsed =
      JSON.parse(texto);

    return {
      intent:
        parsed.intent ||
        "outro",

      acoes:
        Array.isArray(
          parsed.acoes
        )
          ? parsed.acoes
          : [],

      produtoIdsConsulta:
        Array.isArray(
          parsed.produtoIdsConsulta
        )
          ? parsed.produtoIdsConsulta
          : [],

      entrega:
        parsed.entrega ||
        {},

      pagamento:
        parsed.pagamento ||
        {},

      respostaSimNao:
        parsed.respostaSimNao ||
        null,

      encerrarItens:
        Boolean(
          parsed.encerrarItens
        ),
    };
  } catch (error) {
    console.error(
      "JSON DA IA INVÁLIDO:",
      texto
    );

    throw error;
  }
}

// =====================================================
// CONSULTAS DO CARDÁPIO
// =====================================================

function descreverProduto(
  produto
) {
  if (!produto) {
    return null;
  }

  const linhas = [
    `*${produto.nome}*`,
  ];

  if (
    Number.isFinite(
      Number(produto.preco)
    )
  ) {
    linhas.push(
      formatarReal(
        produto.preco
      )
    );
  }

  if (
    Array.isArray(
      produto.variacoes
    ) &&
    produto.variacoes.length >
      0
  ) {
    for (
      const variacao of
      produto.variacoes
    ) {
      linhas.push(
        `${variacao.nome} — ${formatarReal(variacao.preco)}`
      );
    }
  }

  if (
    Array.isArray(
      produto.opcoes
    ) &&
    produto.opcoes.length >
      0
  ) {
    linhas.push(
      `Opções: ${produto.opcoes.join(", ")}`
    );
  }

  if (
    produto.descricao
  ) {
    linhas.push(
      produto.descricao
    );
  }

  if (
    Array.isArray(
      produto.composicao
    ) &&
    produto.composicao.length >
      0
  ) {
    linhas.push(
      "Inclui:"
    );

    for (
      const item of
      produto.composicao
    ) {
      linhas.push(
        `• ${item}`
      );
    }
  }

  return linhas.join("\n");
}

function responderConsulta(
  interpretacao,
  produtosDetectados,
  userMessage
) {
  const msg =
    normalizarTexto(
      userMessage
    );

  if (
    msg.includes(
      "cardapio"
    )
  ) {
    const categorias =
      (cardapio.categorias || [])
        .map(
          (categoria) =>
            `• ${categoria.nome}`
        )
        .join("\n");

    return (
      "Claro 😋 Temos:\n\n" +
      categorias +
      "\n\nMe fala uma categoria ou o nome do que você está procurando."
    );
  }

  const ids =
    interpretacao
      .produtoIdsConsulta || [];

  const escolhidos = [];

  for (
    const id of ids
  ) {
    const produto =
      obterProdutoPorId(id);

    if (
      produto &&
      produto.contexto !==
        "mesa"
    ) {
      escolhidos.push(
        produto
      );
    }
  }

  if (
    escolhidos.length === 0
  ) {
    escolhidos.push(
      ...produtosDetectados.slice(
        0,
        3
      )
    );
  }

  if (
    escolhidos.length === 0
  ) {
    return (
      "Não encontrei esse item no cardápio oficial. " +
      "Me fala o nome de outro produto que eu confiro pra você."
    );
  }

  return escolhidos
    .map(
      descreverProduto
    )
    .filter(Boolean)
    .join("\n\n");
}

// =====================================================
// FLUXO
// =====================================================

function perguntaPendencia(
  pendencia
) {
  if (!pendencia) {
    return null;
  }

  if (
    pendencia.tipo ===
      "variacao"
  ) {
    return (
      `Boa 😋 Para *${pendencia.produto.nome}*, qual tamanho/peso você prefere?\n\n` +
      pendencia.opcoes
        .join(" • ")
    );
  }

  if (
    pendencia.tipo ===
      "opcao"
  ) {
    return (
      `Qual opção você prefere para *${pendencia.produto.nome}*?\n\n` +
      pendencia.opcoes
        .join(" • ")
    );
  }

  if (
    pendencia.tipo ===
      "escolha"
  ) {
    return (
      `${pendencia.nome || "Qual opção você prefere"} para *${pendencia.produto.nome}*?\n\n` +
      pendencia.opcoes
        .join(" • ")
    );
  }

  return null;
}

function irParaEntrega(
  estado
) {
  estado.etapa =
    "ENTREGA";

  const faltando =
    dadosEntregaFaltando(
      estado
    );

  if (
    faltando.length === 0
  ) {
    estado.etapa =
      "PAGAMENTO";

    return (
      "Perfeito. Qual seria a forma de pagamento: *PIX, cartão ou dinheiro*?"
    );
  }

  return (
    "Fechou 😋 Agora me passa os dados para entrega:\n\n" +
    "• nome\n• rua\n• número\n• bairro\n\n" +
    "Pode mandar tudo junto."
  );
}

function continuarFluxo(
  estado,
  interpretacao,
  {
    alterouPedido,
    userMessage,
  }
) {
  const pendencia =
    encontrarPendencia(
      estado
    );

  if (pendencia) {
    estado.pendencia = {
      produtoId:
        pendencia.produto.id,

      tipo:
        pendencia.tipo,

      escolhaId:
        pendencia.escolhaId ||
        null,
    };

    estado.etapa =
      "ESCOLHA_PENDENTE";

    return perguntaPendencia(
      pendencia
    );
  }

  estado.pendencia = null;

  if (
    !pedidoTemItens(
      estado
    )
  ) {
    estado.etapa =
      "MONTANDO_PEDIDO";

    return (
      "Pode mandar seu pedido 😋"
    );
  }

  // Cliente disse que acabou os itens.
  if (
    interpretacao.encerrarItens
  ) {
    estado.pedido.complementoOferecido =
      true;

    estado.pedido.bebidaOferecida =
      true;

    return irParaEntrega(
      estado
    );
  }

  // Se está montando ou acabou de resolver uma escolha.
  if (
    estado.etapa ===
      "MONTANDO_PEDIDO" ||
    estado.etapa ===
      "ESCOLHA_PENDENTE"
  ) {
    if (
      !estado.pedido
        .complementoOferecido
    ) {
      estado.pedido.complementoOferecido =
        true;

      estado.etapa =
        "COMPLEMENTO";

      return (
        `Fechou 😋\n\n${gerarResumoItens(estado)}\n\n` +
        "Quer acrescentar uma *porção* ou mais algum *espetinho*?"
      );
    }
  }

  // Complemento.
  if (
    estado.etapa ===
      "COMPLEMENTO"
  ) {
    if (
      interpretacao
        .respostaSimNao ===
        "sim" &&
      !alterouPedido
    ) {
      return (
        "Manda o que você quer acrescentar 😋"
      );
    }

    if (
      alterouPedido ||
      interpretacao
        .respostaSimNao ===
        "nao" ||
      ehNegacao(userMessage)
    ) {
      if (
        pedidoTemBebida(
          estado
        )
      ) {
        estado.pedido.bebidaOferecida =
          true;

        return irParaEntrega(
          estado
        );
      }

      if (
        !estado.pedido
          .bebidaOferecida
      ) {
        estado.pedido.bebidaOferecida =
          true;

        estado.etapa =
          "BEBIDA";

        return (
          "Quer alguma *bebida* para acompanhar? 🥤"
        );
      }
    }

    return (
      "Quer acrescentar mais alguma coisa?"
    );
  }

  // Bebida.
  if (
    estado.etapa ===
      "BEBIDA"
  ) {
    if (
      interpretacao
        .respostaSimNao ===
        "sim" &&
      !alterouPedido
    ) {
      return (
        "Qual bebida você prefere?"
      );
    }

    if (
      alterouPedido ||
      interpretacao
        .respostaSimNao ===
        "nao" ||
      ehNegacao(userMessage)
    ) {
      return irParaEntrega(
        estado
      );
    }

    return (
      "Se quiser bebida, me fala qual. Se não quiser, pode dizer *não*."
    );
  }

  // Entrega.
  if (
    estado.etapa ===
      "ENTREGA"
  ) {
    const faltando =
      dadosEntregaFaltando(
        estado
      );

    if (
      faltando.length > 0
    ) {
      return (
        `Faltou só: *${faltando.join(", ")}*.\nPode me passar?`
      );
    }

    estado.etapa =
      "PAGAMENTO";

    if (
      estado.entrega
        .precisaConsultar
    ) {
      return (
        "Para essa localidade, a disponibilidade e a taxa de entrega precisam ser consultadas. 👍\n\n" +
        "Podemos continuar a demonstração normalmente.\nQual forma de pagamento você usaria: *PIX, cartão ou dinheiro*?"
      );
    }

    return (
      "Perfeito. Qual seria a forma de pagamento: *PIX, cartão ou dinheiro*?"
    );
  }

  // Pagamento.
  if (
    estado.etapa ===
      "PAGAMENTO"
  ) {
    if (
      !estado.pagamento.metodo
    ) {
      return (
        "Qual forma de pagamento: *PIX, cartão ou dinheiro*?"
      );
    }

    if (
      estado.pagamento.metodo ===
        "CARTAO" &&
      !estado.pagamento.tipoCartao
    ) {
      return (
        "Cartão *crédito ou débito*?"
      );
    }

    if (
      estado.pagamento.metodo ===
        "DINHEIRO" &&
      !estado.pagamento.confirmado
    ) {
      estado.etapa =
        "TROCO";

      return (
        "Certo 💵 Precisa de troco? Se sim, para quanto?"
      );
    }

    if (
      estado.pagamento.confirmado
    ) {
      estado.etapa =
        "CONFIRMACAO";

      estado.aguardandoConfirmacaoFinal =
        true;

      return gerarResumoFinal(
        estado
      );
    }
  }

  if (
    estado.etapa ===
      "TROCO"
  ) {
    if (
      estado.pagamento.confirmado
    ) {
      estado.etapa =
        "CONFIRMACAO";

      estado.aguardandoConfirmacaoFinal =
        true;

      return gerarResumoFinal(
        estado
      );
    }

    return (
      "Me fala se precisa de troco e, se precisar, para quanto."
    );
  }

  // Caso tenha alterado pedido depois do fluxo.
  if (alterouPedido) {
    estado.aguardandoConfirmacaoFinal =
      false;

    estado.etapa =
      "MONTANDO_PEDIDO";

    return (
      `Pedido atualizado 👍\n\n${gerarResumoItens(estado)}\n\nQuer acrescentar mais alguma coisa?`
    );
  }

  return null;
}

// =====================================================
// FILA / DEBOUNCE
// =====================================================

function enfileirarPorTelefone(
  phone,
  tarefa
) {
  const anterior =
    filaPorTelefone[phone] ||
    Promise.resolve();

  const atual =
    anterior
      .catch(
        () => {}
      )
      .then(tarefa);

  filaPorTelefone[phone] =
    atual;

  atual.finally(() => {
    if (
      filaPorTelefone[phone] ===
      atual
    ) {
      delete filaPorTelefone[
        phone
      ];
    }
  });

  return atual;
}

function acumularMensagem(
  phone,
  mensagem
) {
  if (
    !bufferPorTelefone[phone]
  ) {
    bufferPorTelefone[phone] =
      [];
  }

  bufferPorTelefone[
    phone
  ].push(mensagem);

  if (
    timerPorTelefone[phone]
  ) {
    clearTimeout(
      timerPorTelefone[phone]
    );
  }

  timerPorTelefone[phone] =
    setTimeout(() => {
      const mensagens =
        bufferPorTelefone[
          phone
        ] || [];

      const mensagemCompleta =
        mensagens
          .join("\n")
          .trim();

      delete bufferPorTelefone[
        phone
      ];

      delete timerPorTelefone[
        phone
      ];

      if (
        !mensagemCompleta
      ) {
        return;
      }

      console.log(
        `MENSAGEM AGRUPADA DE ${phone}:`,
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
            `ERRO FILA ${phone}:`,
            error.response?.data ||
              error.message
          );
        }
      );
    }, DEBOUNCE_MS);
}

// =====================================================
// Z-API
// =====================================================

async function enviarMensagemZAPI(
  phone,
  message
) {
  const response =
    await axios.post(
      `${ZAPI_BASE_URL}/send-text`,
      {
        phone,
        message,
      },
      {
        headers: {
          "Client-Token":
            CLIENT_TOKEN,

          "Content-Type":
            "application/json",
        },

        timeout: 20000,
      }
    );

  return response.data;
}

async function enviarResposta(
  phone,
  message,
  {
    agendarReminder = true,
  } = {}
) {
  await enviarMensagemZAPI(
    phone,
    message
  );

  registrarAtividade(phone);

  if (
    agendarReminder
  ) {
    agendarLembrete(phone);
  }
}

// =====================================================
// PROCESSAMENTO PRINCIPAL
// =====================================================

const welcomeMessage =
  `🔥 Olá! Seja bem-vindo ao *Tiquinho Espetinhos*! 😋

Pode fazer seu pedido por aqui mesmo.

Temos espetinhos, jantinhas, porções, combos, bebidas e muito mais.

Me fala o que deu vontade que eu te ajudo rapidinho!`;

async function processarMensagem(
  phone,
  userMessage
) {
  console.log(
    `PROCESSANDO ${phone}: ${userMessage}`
  );

  if (
    sessaoExpirada(phone)
  ) {
    limparSessao(phone);
  }

  const eraSessaoNova =
    !historicoPorTelefone[
      phone
    ];

  if (
    !historicoPorTelefone[
      phone
    ]
  ) {
    historicoPorTelefone[
      phone
    ] = [];

    estadoPorTelefone[
      phone
    ] =
      criarEstadoNovo();
  }

  const historico =
    historicoPorTelefone[
      phone
    ];

  const estado =
    obterEstado(phone);

  limparTimerLembrete(phone);

  registrarAtividade(phone);

  // ===================================================
  // CONFIRMAÇÃO FINAL REAL DO BACKEND
  // ===================================================

  if (
    estado.aguardandoConfirmacaoFinal
  ) {
    if (
      ehConfirmacao(
        userMessage
      )
    ) {
      estado.aguardandoConfirmacaoFinal =
        false;

      estado.demonstracaoConfirmada =
        true;

      estado.etapa =
        "FINALIZADO";

      historico.push({
        role: "user",
        content:
          userMessage,
      });

      const resposta =
        "Demonstração confirmada com sucesso! ✅";

      historico.push({
        role: "assistant",
        content:
          resposta,
      });

      await enviarResposta(
        phone,
        resposta,
        {
          agendarReminder:
            false,
        }
      );

      console.log(
        `DEMONSTRAÇÃO FINALIZADA: ${phone}`
      );

      return;
    }

    if (
      ehNegacao(
        userMessage
      )
    ) {
      estado.aguardandoConfirmacaoFinal =
        false;

      estado.etapa =
        "MONTANDO_PEDIDO";

      await enviarResposta(
        phone,
        "Beleza 👍 O que você quer alterar no pedido?"
      );

      return;
    }
  }

  if (
    estado.demonstracaoConfirmada
  ) {
    await enviarResposta(
      phone,
      "Essa demonstração já foi confirmada ✅\n\nSe quiser começar outra, envie *reiniciar*.",
      {
        agendarReminder:
          false,
      }
    );

    return;
  }

  // ===================================================
  // PRIMEIRA MENSAGEM
  // ===================================================

  if (
    eraSessaoNova &&
    ehSaudacaoPura(
      userMessage
    )
  ) {
    historico.push({
      role:
        "user",

      content:
        userMessage,
    });

    const resposta =
      obterAvisoHorario(
        estado
      ) +
      welcomeMessage;

    historico.push({
      role:
        "assistant",

      content:
        resposta,
    });

    await enviarResposta(
      phone,
      resposta
    );

    return;
  }

  // ===================================================
  // DETECÇÃO + IA
  // ===================================================

  const produtosDetectados =
    encontrarProdutosNaMensagem(
      userMessage
    );

  const interpretacao =
    await interpretarMensagem(
      userMessage,
      estado,
      produtosDetectados,
      historico
    );

  console.log(
    "INTERPRETAÇÃO:",
    JSON.stringify(
      interpretacao,
      null,
      2
    )
  );

  // ===================================================
  // CONSULTA SEM ADICIONAR AO CARRINHO
  // ===================================================

  if (
    interpretacao.intent ===
      "consulta" &&
    interpretacao.acoes
      .length === 0
  ) {
    const resposta =
      obterAvisoHorario(
        estado
      ) +
      responderConsulta(
        interpretacao,
        produtosDetectados,
        userMessage
      );

    historico.push({
      role:
        "user",

      content:
        userMessage,
    });

    historico.push({
      role:
        "assistant",

      content:
        resposta,
    });

    historicoPorTelefone[
      phone
    ] =
      historico.slice(
        -MAX_MESSAGES
      );

    await enviarResposta(
      phone,
      resposta
    );

    return;
  }

  // ===================================================
  // ATUALIZA CARRINHO
  // ===================================================

  const alterouPedido =
    aplicarAcoesPedido(
      estado,
      interpretacao.acoes
    );

  // ===================================================
  // DADOS DE ENTREGA
  // ===================================================

  atualizarEntrega(
    estado,
    interpretacao.entrega
  );

  // ===================================================
  // PAGAMENTO
  // ===================================================

  const resultadoPagamento =
    atualizarPagamento(
      estado,
      interpretacao,
      userMessage
    );

  if (
    resultadoPagamento?.erro
  ) {
    await enviarResposta(
      phone,
      `${resultadoPagamento.erro}\n\nPode me passar novamente?`
    );

    return;
  }

  // Se forma de pagamento foi informada
  // antes da etapa, guardamos normalmente.
  if (
    interpretacao
      .pagamento?.metodo &&
    estado.etapa ===
      "ENTREGA"
  ) {
    // Não pula endereço.
  }

  // ===================================================
  // FLUXO
  // ===================================================

  let resposta =
    continuarFluxo(
      estado,
      interpretacao,
      {
        alterouPedido,
        userMessage,
      }
    );

  // Mensagem que não foi compreendida.
  if (!resposta) {
    if (
      produtosDetectados.length >
        0 &&
      !alterouPedido
    ) {
      resposta =
        "Encontrei esse item no cardápio 👍\nMe fala se você quer pedir ou só consultar o valor.";
    } else {
      resposta =
        "Não consegui entender certinho 😅 Pode me falar de outro jeito?";
    }
  }

  const avisoHorario =
    obterAvisoHorario(
      estado
    );

  resposta =
    avisoHorario +
    resposta;

  historico.push({
    role:
      "user",

    content:
      userMessage,
  });

  historico.push({
    role:
      "assistant",

    content:
      resposta,
  });

  historicoPorTelefone[
    phone
  ] =
    historico.slice(
      -MAX_MESSAGES
    );

  await enviarResposta(
    phone,
    resposta,
    {
      agendarReminder:
        !estado.demonstracaoConfirmada,
    }
  );
}

// =====================================================
// WEBHOOK
// =====================================================

app.post(
  "/webhook",
  (req, res) => {
    const body =
      req.body;

    console.log(
      "BODY RECEBIDO:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    res.status(200).json({
      status:
        "received",
    });

    if (
      body?.fromMe
    ) {
      return;
    }

    if (
      body?.messageId
    ) {
      if (
        messageIdsProcessados
          .has(
            body.messageId
          )
      ) {
        console.log(
          `IGNORADO: messageId duplicado ${body.messageId}`
        );

        return;
      }

      messageIdsProcessados
        .set(
          body.messageId,
          Date.now()
        );

      setTimeout(() => {
        messageIdsProcessados
          .delete(
            body.messageId
          );
      }, 120000);
    }

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
        "IGNORADO: sem telefone ou texto."
      );

      return;
    }

    console.log(
      `Mensagem recebida de ${phone}: ${userMessage}`
    );

    limparTimerLembrete(
      phone
    );

    if (
      sessaoExpirada(phone)
    ) {
      limparSessao(phone);
    }

    // RESET MANUAL.
    if (
      normalizarTexto(
        userMessage
      ) === "reiniciar"
    ) {
      limparSessao(phone);

      enfileirarPorTelefone(
        phone,
        async () => {
          estadoPorTelefone[
            phone
          ] =
            criarEstadoNovo();

          historicoPorTelefone[
            phone
          ] = [];

          await enviarMensagemZAPI(
            phone,
            "🔄 Conversa reiniciada. Pode mandar sua mensagem para começar novamente."
          );
        }
      ).catch(
        (error) => {
          console.error(
            "ERRO AO REINICIAR:",
            error.response?.data ||
              error.message
          );
        }
      );

      return;
    }

    registrarAtividade(
      phone
    );

    acumularMensagem(
      phone,
      userMessage
    );
  }
);

// =====================================================
// ROTAS
// =====================================================

app.get(
  "/",
  (req, res) => {
    res.send(
      "Tiquinho Espetinhos rodando"
    );
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      estabelecimento:
        cardapio.estabelecimento
          ?.nome,

      produtos:
        todosProdutos.length,

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
      `Servidor rodando na porta ${PORT}`
    );

    console.log(
      `Debounce: ${DEBOUNCE_MS}ms`
    );

    console.log(
      `Lembrete: ${LEMBRETE_MS}ms`
    );

    console.log(
      `Expiração da sessão: ${EXPIRACAO_SESSAO_MS}ms`
    );
  }
);