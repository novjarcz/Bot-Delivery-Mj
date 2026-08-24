require("dotenv").config();

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// =====================================================
// VARIÃVEIS DE AMBIENTE
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

const missingEnvVars = Object.entries(requiredEnvVars)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  console.error(
    `VariÃ¡veis ausentes: ${missingEnvVars.join(", ")}`
  );
  process.exit(1);
}

const ZAPI_BASE_URL =
  `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});
// =====================================================
// CARDÃPIO
// =====================================================

const caminhoCardapio = path.join(
  __dirname,
  "cardapio.json"
);

function carregarCardapio() {
  try {
    const conteudo = fs.readFileSync(
      caminhoCardapio,
      "utf8"
    );

    return JSON.parse(conteudo);
  } catch (error) {
    console.error(
      "ERRO AO CARREGAR CARDÃPIO:",
      error.message
    );

    process.exit(1);
  }
}

const cardapio = carregarCardapio();

console.log(
  `CARDÃPIO CARREGADO: ${cardapio.estabelecimento?.nome || "sem nome"}`
);
// =====================================================
// BUSCA NO CARDÃPIO
// =====================================================

function normalizarBusca(texto = "") {
  return String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function buscarProdutosCardapio(termo) {
  const busca = normalizarBusca(termo);

  if (!busca) {
    return [];
  }

  const resultados = [];

  for (const categoria of cardapio.categorias || []) {
    for (const produto of categoria.produtos || []) {
      const nomeProduto = normalizarBusca(
        produto.nome
      );

      const descricaoProduto = normalizarBusca(
        produto.descricao || ""
      );

      if (
        nomeProduto.includes(busca) ||
        descricaoProduto.includes(busca)
      ) {
        resultados.push({
          ...produto,
          categoria: categoria.nome
        });
      }
    }
  }

  return resultados;
}
// =====================================================
// PRODUTOS RELEVANTES NA MENSAGEM
// =====================================================

function encontrarProdutosNaMensagem(texto) {
  const mensagem = normalizarBusca(texto);

  if (!mensagem) {
    return [];
  }

  const resultados = [];
  const idsEncontrados = new Set();

  for (const categoria of cardapio.categorias || []) {
    for (const produto of categoria.produtos || []) {
      const nome = normalizarBusca(
        produto.nome || ""
      );

      const palavrasNome = nome
        .split(/\s+/)
        .filter((palavra) => palavra.length >= 4);

      let pontuacao = 0;
      const correspondencias = [];

      // Nome completo.
      if (nome && mensagem.includes(nome)) {
        pontuacao += 10;
        correspondencias.push("nome_completo");
      }

      // Palavras relevantes do nome.
      for (const palavra of palavrasNome) {
        if (mensagem.includes(palavra)) {
          pontuacao += 2;
          correspondencias.push(
            `nome:${palavra}`
          );
        }
      }
// Aliases:
// coraÃ§Ã£o, coraÃ§Ã£ozinho, coca, refri etc.
for (const alias of produto.aliases || []) {
  const aliasNormalizado =
    normalizarBusca(alias);

  if (
    aliasNormalizado &&
    mensagem.includes(aliasNormalizado)
  ) {
    pontuacao += 8;

    correspondencias.push(
      `alias:${alias}`
    );
  }
}
      // OpÃ§Ãµes:
      // Coca-Cola, GuaranÃ¡, com gÃ¡s etc.
      for (const opcao of produto.opcoes || []) {
        const opcaoNormalizada =
          normalizarBusca(opcao);

        const palavrasOpcao =
          opcaoNormalizada
            .split(/\s+/)
            .filter(
              (palavra) =>
                palavra.length >= 4
            );

        if (
          opcaoNormalizada &&
          mensagem.includes(opcaoNormalizada)
        ) {
          pontuacao += 6;
          correspondencias.push(
            `opcao:${opcao}`
          );
        } else {
          for (const palavra of palavrasOpcao) {
            if (mensagem.includes(palavra)) {
              pontuacao += 4;
              correspondencias.push(
                `opcao:${opcao}`
              );
              break;
            }
          }
        }
      }

      // VariaÃ§Ãµes:
      // 250g, 500g etc.
      for (const variacao of produto.variacoes || []) {
        const nomeVariacao =
          normalizarBusca(
            variacao.nome || ""
          );

        if (
          nomeVariacao &&
          mensagem.includes(nomeVariacao)
        ) {
          pontuacao += 5;
          correspondencias.push(
            `variacao:${variacao.nome}`
          );
        }
      }

      // Tamanho embutido no prÃ³prio nome:
      // Refrigerante 2L, Heineken 600ml etc.
      const medidasProduto =
        nome.match(
          /\b\d+(?:[.,]\d+)?\s*(?:ml|l|g|kg)\b/g
        ) || [];

      for (const medida of medidasProduto) {
        const medidaLimpa =
          medida.replace(/\s+/g, "");

        const mensagemSemEspacos =
          mensagem.replace(/\s+/g, "");

        if (
          mensagemSemEspacos.includes(
            medidaLimpa
          )
        ) {
          pontuacao += 6;
          correspondencias.push(
            `medida:${medida}`
          );
        }
      }

      if (
        pontuacao >= 2 &&
        !idsEncontrados.has(produto.id)
      ) {
        idsEncontrados.add(produto.id);

        resultados.push({
          ...produto,
          categoria: categoria.nome,
          pontuacao,
          correspondencias
        });
      }
    }
  }

  return resultados
    .sort((a, b) => {
      // Em conversa de delivery,
      // se houver versÃµes mesa/delivery,
      // favorece delivery.
      if (
        a.contexto === "delivery" &&
        b.contexto === "mesa"
      ) {
        return -1;
      }

      if (
        a.contexto === "mesa" &&
        b.contexto === "delivery"
      ) {
        return 1;
      }

      return b.pontuacao - a.pontuacao;
    })
    .slice(0, 8);
}


// =====================================================
// CONFIGURAÃ‡Ã•ES
// =====================================================

const DEBOUNCE_MS = 4000;

// 1 minuto.
const LEMBRETE_MS = 60 * 1000;

// 4 horas.
const EXPIRACAO_SESSAO_MS = 4 * 60 * 60 * 1000;

const MAX_MESSAGES = 20;

// REGRA ATUAL:
// subtotal > R$60 = grÃ¡tis.
// subtotal <= R$60 = R$6,90.
const TAXA_ENTREGA = 6.90;
const LIMITE_ENTREGA_GRATIS = 60;

// TolerÃ¢ncia para conferir pagamentos.
// Evita problema idiota de ponto flutuante.
const TOLERANCIA_VALOR = 0.02;

// =====================================================
// MEMÃ“RIA
// =====================================================

const historicoPorTelefone = {};
const bufferPorTelefone = {};
const timerPorTelefone = {};
const filaPorTelefone = {};
const estadoPorTelefone = {};

const messageIdsProcessados = new Map();

// =====================================================
// SAUDAÃ‡ÃƒO
// =====================================================

const welcomeMessage = `ðŸ”¥ OlÃ¡! Seja bem-vindo ao *Tiquinho Espetinhos*! ðŸ˜‹

Pode fazer seu pedido por aqui mesmo.

Temos espetinhos, jantinhas, porÃ§Ãµes, combos, bebidas e muito mais.

Me fala o que deu vontade que eu te ajudo rapidinho!`;

// =====================================================
// PROMPT
// =====================================================

const systemPrompt = fs.readFileSync(
  "./prompt-tiquinho.txt",
  "utf8"
);

function obterEstado(phone) {
  if (!estadoPorTelefone[phone]) {
    estadoPorTelefone[phone] =
      criarEstadoNovo();
  }

  return estadoPorTelefone[phone];
}

function limparTimerLembrete(phone) {
  const estado = estadoPorTelefone[phone];

  if (estado?.timerLembrete) {
    clearTimeout(estado.timerLembrete);
    estado.timerLembrete = null;
  }
}

function limparSessao(phone) {
  limparTimerLembrete(phone);

  if (timerPorTelefone[phone]) {
    clearTimeout(timerPorTelefone[phone]);
    delete timerPorTelefone[phone];
  }

  delete bufferPorTelefone[phone];
  delete historicoPorTelefone[phone];
  delete estadoPorTelefone[phone];

  console.log(
    `SESSÃƒO LIMPA: ${phone}`
  );
}

function sessaoExpirada(phone) {
  const estado = estadoPorTelefone[phone];

  if (!estado) {
    return false;
  }

  return (
    Date.now() - estado.ultimaAtividade >
    EXPIRACAO_SESSAO_MS
  );
}

function registrarAtividade(phone) {
  const estado = obterEstado(phone);
  estado.ultimaAtividade = Date.now();
}

function agendarLembrete(phone) {
  const estado = obterEstado(phone);

  limparTimerLembrete(phone);

  if (estado.lembreteEnviado) {
    return;
  }

  estado.timerLembrete = setTimeout(
    async () => {
      try {
        const atual =
          estadoPorTelefone[phone];

        if (
          !atual ||
          atual.lembreteEnviado
        ) {
          return;
        }

        atual.lembreteEnviado = true;
        atual.timerLembrete = null;

        await enviarMensagemZAPI(
          phone,
          "Opa ðŸ˜Š ficou com alguma dÃºvida? Se quiser, posso continuar seu pedido por aqui."
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

// Limpa sessÃµes antigas da memÃ³ria periodicamente.
setInterval(() => {
  for (
    const phone of
    Object.keys(estadoPorTelefone)
  ) {
    if (sessaoExpirada(phone)) {
      limparSessao(phone);
    }
  }
}, 30 * 60 * 1000);

// =====================================================
// TEXTO
// =====================================================

function normalizarTexto(texto = "") {
  return String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

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
  const msg = normalizarTexto(texto);

  return [
    "sim",
    "pode",
    "pode sim",
    "confirmo",
    "confirmar",
    "pode confirmar",
    "fechado",
  ].includes(msg);
}

function possuiNegacaoTroco(texto) {
  const mensagem =
    normalizarTexto(texto);

  return (
    mensagem === "nao" ||
    mensagem.includes("nao precisa") ||
    mensagem.includes("nao preciso") ||
    mensagem.includes("sem troco") ||
    mensagem.includes("nao quero troco")
  );
}

function mensagemEscolheDinheiro(texto) {
  const mensagem =
    normalizarTexto(texto);

  return (
    mensagem === "dinheiro" ||
    mensagem.startsWith("dinheiro ") ||
    mensagem.includes("em dinheiro") ||
    mensagem.includes("pagar dinheiro") ||
    mensagem.includes("pago dinheiro")
  );
}


function possuiBebida(texto) {
  const mensagem =
    normalizarTexto(texto);

  return (
    mensagem.includes("coca") ||
    mensagem.includes("guarana") ||
    mensagem.includes("agua") ||
    mensagem.includes("suco") ||
    mensagem.includes("heineken") ||
    mensagem.includes("corona") ||
    mensagem.includes("budweiser")
  );
}

// =====================================================
// HISTÃ“RICO
// =====================================================

function ultimaRespostaAssistente(
  historico = []
) {
  for (
    let i = historico.length - 1;
    i >= 0;
    i--
  ) {
    if (
      historico[i]?.role ===
      "assistant"
    ) {
      return (
        historico[i].content || ""
      );
    }
  }

  return "";
}

function estaPerguntandoPagamento(
  historico = []
) {
  const ultima =
    normalizarTexto(
      ultimaRespostaAssistente(
        historico
      )
    );

  return (
    ultima.includes(
      "forma de pagamento"
    ) ||
    (
      ultima.includes("pix") &&
      ultima.includes("cartao") &&
      ultima.includes("dinheiro")
    )
  );
}

function estaAguardandoConfirmacaoFinal(
  historico = []
) {
  const ultima =
    normalizarTexto(
      ultimaRespostaAssistente(
        historico
      )
    );

  return ultima.includes(
    "posso confirmar esta demonstracao"
  );
}

function detectarContextoAtual(
  historico = []
) {
  const ultima =
    normalizarTexto(
      ultimaRespostaAssistente(
        historico
      )
    );

  if (
    ultima.includes("qual bebida") ||
    ultima.includes(
      "bebida voce prefere"
    ) ||
    ultima.includes(
      "bebida para acompanhar"
    )
  ) {
    return "BEBIDA";
  }


  if (
    ultima.includes("porcao") ||
    ultima.includes("molho")
  ) {
    return "ACOMPANHAMENTO";
  }

  if (
    ultima.includes(
      "forma de pagamento"
    )
  ) {
    return "PAGAMENTO";
  }

  if (ultima.includes("troco")) {
    return "TROCO";
  }

  return null;
}

// =====================================================
// DINHEIRO
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

  let limpo = String(valor)
    .replace(/R\$/gi, "")
    .replace(/\s/g, "")
    .trim();

  if (
    limpo.includes(".") &&
    limpo.includes(",")
  ) {
    limpo = limpo
      .replace(/\./g, "")
      .replace(",", ".");
  } else if (limpo.includes(",")) {
    limpo =
      limpo.replace(",", ".");
  }

  const numero =
    Number(limpo);

  return Number.isFinite(numero)
    ? numero
    : null;
}

function extrairValorMonetario(
  texto
) {
  const normalizado =
    String(texto)
      .replace(/R\$/gi, "")
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
    matches[matches.length - 1]
  );
}

function formatarReal(valor) {
  return Number(valor).toLocaleString(
    "pt-BR",
    {
      style: "currency",
      currency: "BRL",
    }
  );
}

// =====================================================
// TOTAL / TAXA NO BACKEND
// =====================================================

function calcularEntrega(subtotal) {
  return subtotal >
    LIMITE_ENTREGA_GRATIS
    ? 0
    : TAXA_ENTREGA;
}

function extrairSubtotal(texto) {
  const regex =
    /subtotal\s*:?\s*R\$\s*([\d.]+(?:,\d{1,2})?)/i;

  const match =
    String(texto).match(regex);

  if (!match) {
    return null;
  }

  return converterValorBrasileiro(
    match[1]
  );
}

function extrairUltimoTotal(
  historico = []
) {
  for (
    let i = historico.length - 1;
    i >= 0;
    i--
  ) {
    const item = historico[i];

    if (
      item?.role !== "assistant" ||
      !item?.content
    ) {
      continue;
    }

    const texto = item.content;

    const regex =
      /(?:valor\s+total|total)\s*:?\s*R\$\s*([\d.]+(?:,\d{1,2})?)/gi;

    const encontrados = [
      ...texto.matchAll(regex),
    ];

    if (
      encontrados.length > 0
    ) {
      const ultimo =
        encontrados[
          encontrados.length - 1
        ][1];

      return converterValorBrasileiro(
        ultimo
      );
    }
  }

  return null;
}

function corrigirTotaisNoTexto(
  texto,
  phone
) {
  const subtotal =
    extrairSubtotal(texto);

  if (subtotal === null) {
    return texto;
  }

  const entrega =
    calcularEntrega(subtotal);

  const total =
    subtotal + entrega;

  const estado =
    obterEstado(phone);

  estado.totalAtual = total;

  let corrigido = String(texto);

  // Corrige linha de entrega se existir.
  corrigido = corrigido.replace(
    /entrega\s*:.*$/im,
    entrega === 0
      ? "Entrega: GrÃ¡tis"
      : `Entrega: ${formatarReal(entrega)}`
  );

  // Se nÃ£o havia linha de entrega,
  // tenta inserir antes do Total.
  if (
    !/entrega\s*:/i.test(corrigido) &&
    /total\s*:/i.test(corrigido)
  ) {
    corrigido = corrigido.replace(
      /total\s*:/i,
      `${
        entrega === 0
          ? "Entrega: GrÃ¡tis"
          : `Entrega: ${formatarReal(entrega)}`
      }\nTotal:`
    );
  }

  // Corrige total.
  corrigido = corrigido.replace(
    /(?:valor\s+total|total)\s*:?\s*R\$\s*[\d.]+(?:,\d{1,2})?/i,
    `Total: ${formatarReal(total)}`
  );

  return corrigido;
}

// =====================================================
// PAGAMENTO MISTO
// =====================================================

function detectarMetodoPagamento(
  segmento
) {
  const s =
    normalizarTexto(segmento);

  if (s.includes("pix")) {
    return "PIX";
  }

  if (
    s.includes("dinheiro") ||
    s.includes("especie")
  ) {
    return "DINHEIRO";
  }

  if (
    s.includes("cartao") ||
    s.includes("credito") ||
    s.includes("debito")
  ) {
    if (s.includes("credito")) {
      return "CARTÃƒO CRÃ‰DITO";
    }

    if (s.includes("debito")) {
      return "CARTÃƒO DÃ‰BITO";
    }

    return "CARTÃƒO";
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
    msg.includes("dinheiro"),
    msg.includes("cartao") ||
      msg.includes("credito") ||
      msg.includes("debito"),
  ].filter(Boolean).length;

  if (metodosPresentes < 2) {
    return null;
  }

  // Exemplo:
  // metade dinheiro metade cartÃ£o
  if (
    msg.includes("metade") &&
    metodosPresentes === 2
  ) {
    const metade = total / 2;

    const partes = [];

    if (msg.includes("dinheiro")) {
      partes.push({
        metodo: "DINHEIRO",
        valor: metade,
      });
    }

    if (msg.includes("pix")) {
      partes.push({
        metodo: "PIX",
        valor: metade,
      });
    }

    if (
      msg.includes("cartao") ||
      msg.includes("credito") ||
      msg.includes("debito")
    ) {
      partes.push({
        metodo:
          msg.includes("credito")
            ? "CARTÃƒO CRÃ‰DITO"
            : msg.includes("debito")
            ? "CARTÃƒO DÃ‰BITO"
            : "CARTÃƒO",
        valor: metade,
      });
    }

    if (partes.length === 2) {
      return partes;
    }
  }

  // Divide principalmente por "e".
  const segmentos =
    msg
      .split(/\s+e\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

  if (segmentos.length < 2) {
    return null;
  }

  const partes = [];

  let indiceRestante = -1;
  let somaConhecida = 0;

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
      segmento.includes("resto") ||
      segmento.includes("restante");

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

    if (valor !== null) {
      partes.push({
        metodo,
        valor,
      });

      somaConhecida += valor;
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
      total - somaConhecida;

    if (restante < -TOLERANCIA_VALOR) {
      return {
        erro:
          "Os valores informados ultrapassam o total do pedido.",
      };
    }

    partes[indiceRestante].valor =
      Math.max(0, restante);
  }

  if (
    partes.some(
      (p) => p.valor === null
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
      motivo:
        "NÃ£o consegui entender a divisÃ£o do pagamento.",
    };
  }

  const soma =
    partes.reduce(
      (acc, parte) =>
        acc + Number(parte.valor || 0),
      0
    );

  const diferenca =
    Math.abs(soma - total);

  return {
    valido:
      diferenca <=
      TOLERANCIA_VALOR,

    soma,

    diferenca,
  };
}

function formatarPagamentoMisto(
  partes
) {
  return partes
    .map(
      (parte) =>
        `${parte.metodo}: ${formatarReal(parte.valor)}`
    )
    .join("\n");
}

// =====================================================
// FILA
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
      .catch(() => {})
      .then(tarefa);

  filaPorTelefone[phone] =
    atual;

  atual.finally(() => {
    if (
      filaPorTelefone[phone] ===
      atual
    ) {
      delete filaPorTelefone[phone];
    }
  });

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
    !bufferPorTelefone[phone]
  ) {
    bufferPorTelefone[phone] = [];
  }

  bufferPorTelefone[phone].push(
    mensagem
  );

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
        bufferPorTelefone[phone] || [];

      const mensagemCompleta =
        mensagens
          .join("\n")
          .trim();

      delete bufferPorTelefone[phone];
      delete timerPorTelefone[phone];

      if (!mensagemCompleta) {
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
      ).catch((error) => {
        console.error(
          `ERRO FILA ${phone}:`,
          error.response?.data ||
            error.message
        );
      });
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

  if (agendarReminder) {
    agendarLembrete(phone);
  }
}

// =====================================================
// OPENAI / PROCESSAMENTO
// =====================================================

async function processarMensagem(
  phone,
  userMessage
) {
  console.log(
    `PROCESSANDO ${phone}: ${userMessage}`
  );

  // Se ficou 4 horas parada:
  // adeus Frankenstein antigo.
  if (sessaoExpirada(phone)) {
    limparSessao(phone);
  }

  const eraSessaoNova =
    !historicoPorTelefone[phone];

  if (
    !historicoPorTelefone[phone]
  ) {
    historicoPorTelefone[phone] = [];
    estadoPorTelefone[phone] =
      criarEstadoNovo();
  }

  const historico =
    historicoPorTelefone[phone];

  const estado =
    obterEstado(phone);

  limparTimerLembrete(phone);
  registrarAtividade(phone);

  // ===================================================
  // PRIMEIRA MENSAGEM
  // ===================================================

  if (
    eraSessaoNova &&
    ehSaudacaoPura(userMessage)
  ) {
    historico.push({
      role: "user",
      content: userMessage,
    });

    historico.push({
      role: "assistant",
      content: welcomeMessage,
    });

    await enviarResposta(
      phone,
      welcomeMessage
    );

    return;
  }

  // Qualquer outra primeira mensagem
  // segue direto para a IA.
  // "quero espetinho", "boa boa", "tem coca?" etc.

  let mensagemParaIA =
    userMessage;

  // ===================================================
  // CONFIRMAÃ‡ÃƒO FINAL
  // ===================================================

  const confirmandoFinal =
    estaAguardandoConfirmacaoFinal(
      historico
    ) &&
    ehConfirmacao(userMessage);

  // ===================================================
  // CONTEXTO
  // ===================================================

  const contextoAtual =
    detectarContextoAtual(
      historico
    );


  // ===================================================
  // PAGAMENTO MISTO
  // ===================================================

  const totalParaPagamento =
    estado.totalAtual ??
    extrairUltimoTotal(
      historico
    );

  const pagamentoMisto =
    extrairPagamentoMisto(
      userMessage,
      totalParaPagamento
    );

  if (
    pagamentoMisto?.erro
  ) {
    await enviarResposta(
      phone,
      `${pagamentoMisto.erro}\n\nO total do pedido Ã© ${formatarReal(totalParaPagamento)}. Pode me passar novamente como deseja dividir o pagamento?`
    );

    return;
  }

  if (
    Array.isArray(
      pagamentoMisto
    )
  ) {
    const validacao =
      validarPagamentoMisto(
        pagamentoMisto,
        totalParaPagamento
      );

    if (!validacao.valido) {
      await enviarResposta(
        phone,
        `A soma das formas de pagamento deu ${formatarReal(validacao.soma)}, mas o total do pedido Ã© ${formatarReal(totalParaPagamento)}. ðŸ˜…\n\nPode me passar novamente a divisÃ£o?`
      );

      return;
    }

    estado.aguardandoTroco =
      false;

    mensagemParaIA =
      `PAGAMENTO MISTO VALIDADO PELO SISTEMA.\n\n` +
      `Total do pedido: ${formatarReal(totalParaPagamento)}\n` +
      `${formatarPagamentoMisto(pagamentoMisto)}\n\n` +
      `A soma confere exatamente com o total.\n` +
      `Use esses valores no resumo final.\n` +
      `NÃ£o recalcule.\n` +
      `NÃ£o trate nenhuma das parcelas isoladamente como se precisasse pagar o pedido inteiro.\n` +
      `NÃ£o pergunte troco automaticamente apenas porque existe uma parcela em dinheiro.`;
  }

  // ===================================================
  // DINHEIRO NORMAL
  // ===================================================

  else if (
    estaPerguntandoPagamento(
      historico
    ) &&
    mensagemEscolheDinheiro(
      userMessage
    )
  ) {
    const total =
      totalParaPagamento;

    estado.totalAtual =
      total;

    if (
      possuiNegacaoTroco(
        userMessage
      )
    ) {
      estado.aguardandoTroco =
        false;

      mensagemParaIA =
        `O cliente escolheu dinheiro e NÃƒO precisa de troco. Continue para a finalizaÃ§Ã£o.`;
    } else {
      const valor =
        extrairValorMonetario(
          userMessage
        );

      if (
        valor !== null &&
        total !== null
      ) {
        if (
          valor <
          total - TOLERANCIA_VALOR
        ) {
          estado.aguardandoTroco =
            true;

          await enviarResposta(
            phone,
            `O total do pedido Ã© ${formatarReal(total)}. O valor informado (${formatarReal(valor)}) Ã© menor que o total. ðŸ˜…\n\nVocÃª vai pagar com qual valor?`
          );

          return;
        }

        const troco =
          valor - total;

        estado.aguardandoTroco =
          false;

        mensagemParaIA =
          `PAGAMENTO VALIDADO PELO SISTEMA:\n` +
          `Forma: DINHEIRO\n` +
          `Total: ${formatarReal(total)}\n` +
          `Cliente pagarÃ¡ com: ${formatarReal(valor)}\n` +
          `Troco correto: ${formatarReal(troco)}\n\n` +
          `Use exatamente esses valores.`;
      } else {
        estado.aguardandoTroco =
          true;

        await enviarResposta(
          phone,
          "Certo! Pagamento em dinheiro. ðŸ’µ\n\nPrecisa de troco? Se sim, para quanto?"
        );

        return;
      }
    }
  }

  // ===================================================
  // AGUARDANDO TROCO
  // ===================================================

  else if (
    estado.aguardandoTroco
  ) {
    if (
      possuiNegacaoTroco(
        userMessage
      )
    ) {
      estado.aguardandoTroco =
        false;

      mensagemParaIA =
        `PAGAMENTO VALIDADO PELO SISTEMA:\n` +
        `Forma: DINHEIRO\n` +
        `Sem necessidade de troco.\n` +
        `Continue a finalizaÃ§Ã£o e nÃ£o pergunte pagamento novamente.`;
    } else {
      const valor =
        extrairValorMonetario(
          userMessage
        );

      if (valor !== null) {
        const total =
          estado.totalAtual ??
          extrairUltimoTotal(
            historico
          );

        if (
          total !== null &&
          valor <
            total -
              TOLERANCIA_VALOR
        ) {
          await enviarResposta(
            phone,
            `O total do pedido Ã© ${formatarReal(total)}. O valor informado (${formatarReal(valor)}) Ã© menor que o total. ðŸ˜…\n\nVocÃª vai pagar com qual valor?`
          );

          return;
        }

        if (total !== null) {
          const troco =
            valor - total;

          estado.aguardandoTroco =
            false;

          mensagemParaIA =
            `PAGAMENTO VALIDADO PELO SISTEMA:\n` +
            `Forma: DINHEIRO\n` +
            `Total: ${formatarReal(total)}\n` +
            `Cliente pagarÃ¡ com: ${formatarReal(valor)}\n` +
            `Troco correto: ${formatarReal(troco)}\n\n` +
            `Use exatamente esses valores.`;
        }
      }
    }
  }

  // ===================================================
  // CONTEXTO EXPLÃCITO
  // ===================================================

  const contexto =
    detectarContextoAtual(
      historico
    );

  if (
    contexto &&
    mensagemParaIA ===
      userMessage
  ) {
    mensagemParaIA =
      `[CONTEXTO ATUAL: ${contexto}]\n${userMessage}`;
  }

  // ===================================================
  // OPENAI
  // ===================================================

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
    ...historico,
    {
      role: "user",
      content:
        mensagemParaIA,
    },
  ];

  const completion =
    await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
      max_tokens: 650,
    });

  let resposta =
    completion.choices?.[0]
      ?.message?.content?.trim();

  if (!resposta) {
    throw new Error(
      "OpenAI retornou resposta vazia."
    );
  }

  // Backend manda na taxa e no total.
  resposta =
    corrigirTotaisNoTexto(
      resposta,
      phone
    );

  historico.push({
    role: "user",
    content: userMessage,
  });

  historico.push({
    role: "assistant",
    content: resposta,
  });

  historicoPorTelefone[phone] =
    historico.slice(
      -MAX_MESSAGES
    );

  await enviarResposta(
    phone,
    resposta,
    {
      // Se acabou de confirmar,
      // nÃ£o tem por que lembrar o cliente
      // depois.
      agendarReminder:
        !confirmandoFinal,
    }
  );

  // ===================================================
  // PEDIDO FINALIZADO
  // ===================================================

  if (confirmandoFinal) {
    console.log(
      `PEDIDO FINALIZADO: ${phone}`
    );

    // NÃ£o limpa a sessÃ£o imediatamente.
    // O lembrete jÃ¡ nÃ£o serÃ¡ agendado apÃ³s a confirmaÃ§Ã£o.
    // A sessÃ£o serÃ¡ esquecida automaticamente apÃ³s
    // 4 horas sem atividade pela regra de expiraÃ§Ã£o.
  }
}

// =====================================================
// WEBHOOK
// =====================================================

app.post(
  "/webhook",
  (req, res) => {
    const body = req.body;

    console.log(
      "BODY RECEBIDO:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    res.status(200).json({
      status: "received",
    });

    if (body?.fromMe) {
      return;
    }

    if (body?.messageId) {
      if (
        messageIdsProcessados.has(
          body.messageId
        )
      ) {
        console.log(
          `IGNORADO: messageId duplicado ${body.messageId}`
        );

        return;
      }

      messageIdsProcessados.set(
        body.messageId,
        Date.now()
      );

      setTimeout(() => {
        messageIdsProcessados.delete(
          body.messageId
        );
      }, 120000);
    }

    const phone =
      body?.phone;

    const userMessage =
      body?.text?.message?.trim();

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

    // Cliente respondeu:
    // cancela lembrete pendente.
    limparTimerLembrete(
      phone
    );

    // Se passou 4 horas:
    // mensagem comeÃ§a sessÃ£o nova.
    if (
      sessaoExpirada(phone)
    ) {
      limparSessao(phone);
    }

    // =================================================
    // RESET
    // =================================================

    if (
      normalizarTexto(
        userMessage
      ) === "reiniciar"
    ) {
      limparSessao(phone);

      enfileirarPorTelefone(
        phone,
        async () => {
          estadoPorTelefone[phone] =
            criarEstadoNovo();

          historicoPorTelefone[phone] =
            [];

          await enviarMensagemZAPI(
            phone,
            "ðŸ”„ Conversa reiniciada. Pode mandar sua mensagem para comeÃ§ar novamente."
          );
        }
      ).catch((error) => {
        console.error(
          "ERRO AO REINICIAR:",
          error.response?.data ||
            error.message
        );
      });

      return;
    }

    registrarAtividade(phone);

    // =================================================
    // DEBOUNCE
    // =================================================

    acumularMensagem(
      phone,
      userMessage
    );
  }
);

// =====================================================
// ROTAS
// =====================================================

app.get("/", (req, res) => {
  res.send(
    "Tiquinho Espetinhos rodando"
  );
});

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",

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
  process.env.PORT || 3000;

app.listen(PORT, () => {
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
    `ExpiraÃ§Ã£o da sessÃ£o: ${EXPIRACAO_SESSAO_MS}ms`
  );
});
