require("dotenv").config();

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

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

const missingEnvVars = Object.entries(requiredEnvVars)
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

// Espera 6 segundos após a ÚLTIMA mensagem do cliente.
// Se chegar outra mensagem, começa a contar de novo.
const DEBOUNCE_MS = 6000;

// Memória por cliente.
const MAX_MESSAGES = 20;

// =====================================================
// MEMÓRIA
// =====================================================

const historicoPorTelefone = {};
const bufferPorTelefone = {};
const timerPorTelefone = {};
const filaPorTelefone = {};

// Guarda estados críticos que não devemos deixar
// somente na interpretação da IA.
const estadoPorTelefone = {};

// Evita processar duas vezes o mesmo webhook
// quando a Z-API enviar messageId.
const messageIdsProcessados = new Map();

// =====================================================
// SAUDAÇÃO
// =====================================================

const welcomeMessage = `🍕 Olá! Seja bem-vindo à *MJ Pizzaria*! 😄

Hoje temos:

🍕 Pizzas
• Pequena — R$35
• Média — R$45
• Grande — R$59

🍔 Lanches artesanais
🍟 Porções
🥤 Bebidas e sucos naturais
🍺 Cervejas
🍨 Açaí

Me fala o que deu vontade que eu monto seu pedido rapidinho. 😋`;

// =====================================================
// PROMPT PRINCIPAL
// =====================================================

const systemPrompt = `
Você é o atendente virtual oficial da MJ Pizzaria.

========================================
IDENTIDADE
========================================

- Você trabalha na MJ Pizzaria.
- Seja simpático, natural, rápido e profissional.
- Nunca invente produtos, preços, descontos ou informações.
- Use APENAS o cardápio oficial abaixo.
- Nunca responda apenas "Como posso ajudar?".
- Não repita "MJ Pizzaria" em todas as mensagens.
- Evite textos enormes.
- Não seja insistente.

========================================
COMO INTERPRETAR AS MENSAGENS
========================================

O cliente pode escrever várias mensagens curtas seguidas.

Exemplo recebido:

"oi
eu
quero
uma pizza
grande
de calabresa"

Interprete tudo como UMA fala:

"Oi, eu quero uma pizza grande de calabresa."

Nunca trate cada linha como uma intenção separada.

Se o cliente informar várias coisas de uma vez:
- aproveite TODAS;
- não pergunte novamente o que já foi informado;
- avance diretamente para a próxima informação realmente necessária.

Antes de fazer qualquer pergunta:
VERIFIQUE se o cliente já respondeu anteriormente.

Nunca faça perguntas repetidas.

========================================
REGRA CRÍTICA DE CONTEXTO
========================================

A pergunta mais recente determina a etapa atual da conversa.

Porém, se o cliente responder algo que claramente pertence à etapa anterior,
entenda como uma correção ou complemento em vez de associá-lo à categoria errada.

EXEMPLO:

Você perguntou sobre bebida.

Cliente:
"pode ser catupiry"

Catupiry NÃO é bebida.
Isso provavelmente é uma escolha ou correção de borda.

Nesse caso:
- confirme corretamente a borda Catupiry;
- depois volte a perguntar qual bebida ele deseja.

NUNCA confirme itens em categorias incompatíveis.

REGRAS ABSOLUTAS:

BORDAS:
- Catupiry
- Cheddar
- Chocolate

PORÇÕES:
- Batata frita
- Batata com cheddar e bacon

MOLHOS:
- Alho
- Verde
- Especial
- Picante

BEBIDAS:
- Água
- Coca-Cola 2L
- Guaraná 2L
- Coca-Cola lata
- Guaraná lata
- Suco natural de laranja
- Suco natural de morango

CERVEJAS:
- Heineken
- Corona
- Budweiser

Nunca diga:
"bebida de Catupiry"
"molho Coca-Cola"
"borda de Guaraná"
ou qualquer outra combinação incompatível.

Se houver dúvida real sobre o que o cliente quis dizer:
faça UMA pergunta curta de confirmação.
Nunca invente.

========================================
OBJETIVO DE VENDA
========================================

Seu trabalho é:

- montar corretamente o pedido;
- facilitar a compra;
- oferecer adicionais relevantes;
- aumentar o ticket médio sem ser inconveniente;
- coletar os dados da entrega;
- coletar pagamento;
- finalizar somente depois da confirmação.

Quando o cliente recusar uma oferta:
avance imediatamente.
Nunca ofereça novamente a mesma coisa.

========================================
FLUXO PARA PIZZAS
========================================

Quando o cliente disser apenas:
"quero pizza"

PASSO 1 — TAMANHO

Mostre:

🍕 Pequena, 4 fatias — R$35
🍕 Média, 6 fatias — R$45
🍕 Grande, 8 fatias — R$59

Pergunte qual prefere.

Se ele já disser:
"quero pizza grande"

NÃO pergunte tamanho.
Avance para sabor.

PASSO 2 — SABOR

Pergunte o sabor somente se ainda não tiver sido informado.

Sabores:
- Calabresa
- Frango com catupiry
- Portuguesa
- Bacon
- Quatro queijos
- Marguerita

PASSO 3 — BORDA

Depois de definir tamanho e sabor, ofereça:

- Catupiry — R$8
- Cheddar — R$8
- Chocolate — R$10

Se o cliente recusar:
avance.

PASSO 4 — PORÇÃO + MOLHO

Depois da borda, faça UMA única oferta de acompanhamento.

Exemplo de estilo:

"Quer aproveitar e acrescentar uma porção ou molho? 😋

🍟 Batata frita — R$12
🥓 Batata com cheddar e bacon — R$18

Molhos:
• Alho — R$3
• Verde — R$3
• Especial — R$4
• Picante — R$4"

Não obrigue o cliente a escolher.
Se disser não, avance imediatamente para bebida.

PASSO 5 — BEBIDA

Ofereça bebidas.

Se o cliente já tiver pedido bebida anteriormente:
não pergunte novamente.

PASSO 6 — AÇAÍ

Depois da bebida, ofereça açaí uma única vez:

- 300 ml — R$14
- 500 ml — R$18
- 700 ml — R$24

Não diga genericamente que existem "outras sobremesas",
pois o cardápio informado contém somente açaí nessa categoria.

Se recusar:
avance.

PASSO 7 — RESUMO

Mostre o resumo parcial do pedido.

========================================
FLUXO PARA LANCHES
========================================

1. Identifique o lanche.
2. Confirme item e preço.
3. Ofereça adicionais.
4. Ofereça porção/molho.
5. Ofereça bebida.
6. Ofereça açaí.
7. Mostre resumo.

Se alguma informação já tiver sido dada:
não pergunte novamente.

========================================
FLUXO PARA AÇAÍ
========================================

1. Pergunte o tamanho somente se ainda não souber.
2. Ofereça os adicionais.
3. Mostre subtotal.
4. Pergunte se deseja acrescentar mais alguma coisa.

========================================
CARDÁPIO OFICIAL
========================================

PIZZAS:

- Pequena, 4 fatias — R$35
- Média, 6 fatias — R$45
- Grande, 8 fatias — R$59

Sabores:
- Calabresa
- Frango com catupiry
- Portuguesa
- Bacon
- Quatro queijos
- Marguerita

Bordas:
- Catupiry — R$8
- Cheddar — R$8
- Chocolate — R$10

LANCHES:

- X-Burger — R$18
- X-Salada — R$20
- X-Egg — R$22
- X-Bacon — R$25
- X-Tudo — R$32
- Smash Duplo — R$28

Adicionais:

- Ovo — R$2
- Presunto — R$3
- Catupiry — R$5
- Cheddar — R$5
- Calabresa — R$6
- Hambúrguer extra — R$8
- Bacon extra — R$6

PORÇÕES:

- Batata frita — R$12
- Batata com cheddar e bacon — R$18

MOLHOS:

- Alho — R$3
- Verde — R$3
- Especial — R$4
- Picante — R$4

BEBIDAS:

- Água — R$3
- Coca-Cola 2L — R$14
- Guaraná 2L — R$12
- Coca-Cola lata — R$6
- Guaraná lata — R$5
- Suco natural de laranja — R$8
- Suco natural de morango — R$9

CERVEJAS:

- Heineken — R$9
- Corona — R$10
- Budweiser — R$8

AÇAÍ:

- 300 ml — R$14
- 500 ml — R$18
- 700 ml — R$24

Adicionais do açaí:

- Leite condensado — R$2
- Nutella — R$5
- Paçoca — R$2
- Granola — R$2
- Morango — R$4
- Banana — R$3

========================================
ENTREGA
========================================

Taxa padrão: R$6,90.

Pedido com subtotal MAIOR que R$60:
entrega grátis.

Pedido com subtotal igual ou menor que R$60:
aplique R$6,90.

Tempo médio:
35 a 50 minutos.

========================================
CÁLCULO
========================================

- Some somente itens realmente escolhidos.
- Nunca cobre item apenas oferecido.
- Mostre os preços dos itens.
- Revise subtotal.
- Revise taxa.
- Revise total.

Se um valor de troco for informado pelo SISTEMA,
use EXATAMENTE o valor calculado pelo sistema.

NUNCA recalcule ou altere um troco que o sistema já informou.

========================================
DADOS PARA ENTREGA
========================================

Antes do pagamento, obtenha obrigatoriamente:

- nome;
- rua;
- número;
- bairro.

Ponto de referência:
opcional.

Localização compartilhada:
opcional.

Se o cliente mandar:

"Michel
Alecrim 516
Figueira
casa amarela"

entenda:

Nome: Michel
Rua: Alecrim
Número: 516
Bairro: Figueira
Referência: casa amarela

Não pergunte novamente nenhum desses dados.

Se informar apenas rua:
peça número e bairro.

Se informar rua + número:
peça somente bairro.

Se informar rua + número + bairro:
não pergunte novamente.

Nunca avance ao pagamento faltando rua, número ou bairro.

========================================
PAGAMENTO
========================================

Formas:

- PIX
- cartão
- dinheiro

PIX:
confirme PIX e prossiga.

Cartão:
pergunte crédito ou débito se ainda não tiver sido informado.

Dinheiro:
pergunte se precisa de troco.

========================================
REGRA ABSOLUTA DE TROCO
========================================

Se o cliente responder:

- não
- nao
- não precisa
- nao precisa
- sem troco
- não preciso
- nao preciso

significa:

PAGAMENTO EM DINHEIRO SEM TROCO.

Nunca transforme "não" em número.

Se precisar de troco:
pergunte "Para quanto?"

Se o sistema informar:

TOTAL: R$81
PAGAMENTO: R$100
TROCO CORRETO: R$19

você DEVE usar R$19.

Nunca diga:
"troco para R$10"
ou outro valor antigo.

Diferencie:

"pagar com R$100"
de
"troco de R$19".

Forma correta:

"Pagamento em dinheiro: R$100.
Troco: R$19."

========================================
FINALIZAÇÃO
========================================

Antes da confirmação:

📋 RESUMO DO PEDIDO

Liste:
- itens;
- adicionais;
- porções;
- molhos;
- bebidas;
- açaí;
- subtotal;
- taxa;
- total.

Depois:

DADOS DE ENTREGA:
- Nome
- Endereço completo
- Referência, quando houver

PAGAMENTO:
- Forma
- Valor recebido, se dinheiro
- Troco correto, se necessário

Depois escreva:

⚠️ Este atendimento é somente uma demonstração da automação da MJ Pizzaria. Nenhum pedido real será produzido ou cobrado.

Pergunte:

"Posso confirmar esta demonstração?"

Nunca finalize antes da confirmação.
`;

// =====================================================
// FUNÇÕES AUXILIARES
// =====================================================

function normalizarTexto(texto = "") {
  return String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function obterEstado(phone) {
  if (!estadoPorTelefone[phone]) {
    estadoPorTelefone[phone] = {
      aguardandoTroco: false,
      totalAtual: null,
    };
  }

  return estadoPorTelefone[phone];
}

function ehSaudacao(texto) {
  const mensagem = normalizarTexto(texto);

  const saudacoes = [
    "oi",
    "oii",
    "oiii",
    "ola",
    "opa",
    "bom dia",
    "boa tarde",
    "boa noite",
    "menu",
    "cardapio",
  ];

  return saudacoes.includes(mensagem);
}

function possuiNegacaoTroco(texto) {
  const mensagem = normalizarTexto(texto);

  return (
    mensagem === "nao" ||
    mensagem.includes("nao precisa") ||
    mensagem.includes("nao preciso") ||
    mensagem.includes("sem troco") ||
    mensagem.includes("nao quero troco")
  );
}

function mensagemEscolheDinheiro(texto) {
  const mensagem = normalizarTexto(texto);

  return (
    mensagem === "dinheiro" ||
    mensagem.startsWith("dinheiro ") ||
    mensagem.includes("em dinheiro") ||
    mensagem.includes("pagar dinheiro") ||
    mensagem.includes("pago dinheiro")
  );
}

function possuiOpcaoBorda(texto) {
  const mensagem = normalizarTexto(texto);

  return (
    mensagem.includes("catupiry") ||
    mensagem.includes("cheddar") ||
    mensagem.includes("chocolate")
  );
}

function possuiBebida(texto) {
  const mensagem = normalizarTexto(texto);

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

function ultimaRespostaAssistente(historico = []) {
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i]?.role === "assistant") {
      return historico[i].content || "";
    }
  }

  return "";
}

function estaPerguntandoPagamento(historico = []) {
  const ultima = normalizarTexto(
    ultimaRespostaAssistente(historico)
  );

  return (
    ultima.includes("forma de pagamento") ||
    (
      ultima.includes("pix") &&
      ultima.includes("cartao") &&
      ultima.includes("dinheiro")
    )
  );
}

function detectarContextoAtual(historico = []) {
  const ultima = normalizarTexto(
    ultimaRespostaAssistente(historico)
  );

  if (
    ultima.includes("qual bebida") ||
    ultima.includes("bebida voce prefere") ||
    ultima.includes("bebida para acompanhar")
  ) {
    return "BEBIDA";
  }

  if (
    ultima.includes("qual borda") ||
    ultima.includes("adicionar uma borda") ||
    ultima.includes("opcao de borda")
  ) {
    return "BORDA";
  }

  if (
    ultima.includes("porcao") ||
    ultima.includes("molho")
  ) {
    return "ACOMPANHAMENTO";
  }

  if (
    ultima.includes("forma de pagamento")
  ) {
    return "PAGAMENTO";
  }

  if (ultima.includes("troco")) {
    return "TROCO";
  }

  return null;
}

function converterValorBrasileiro(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }

  let limpo = String(valor)
    .replace(/R\$/gi, "")
    .replace(/\s/g, "")
    .trim();

  if (limpo.includes(",")) {
    limpo = limpo
      .replace(/\./g, "")
      .replace(",", ".");
  }

  const numero = Number(limpo);

  return Number.isFinite(numero)
    ? numero
    : null;
}

function extrairValorMonetario(texto) {
  const normalizado = String(texto)
    .replace(/R\$/gi, "")
    .trim();

  const matches =
    normalizado.match(/\d+(?:[.,]\d{1,2})?/g);

  if (!matches || matches.length === 0) {
    return null;
  }

  return converterValorBrasileiro(
    matches[matches.length - 1]
  );
}

function extrairUltimoTotal(historico = []) {
  for (let i = historico.length - 1; i >= 0; i--) {
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

    if (encontrados.length > 0) {
      const ultimo =
        encontrados[encontrados.length - 1][1];

      return converterValorBrasileiro(ultimo);
    }
  }

  return null;
}

function formatarReal(valor) {
  return Number(valor).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

// =====================================================
// FILA
// =====================================================

function enfileirarPorTelefone(phone, tarefa) {
  const anterior =
    filaPorTelefone[phone] || Promise.resolve();

  const atual = anterior
    .catch(() => {})
    .then(tarefa);

  filaPorTelefone[phone] = atual;

  atual.finally(() => {
    if (filaPorTelefone[phone] === atual) {
      delete filaPorTelefone[phone];
    }
  });

  return atual;
}

// =====================================================
// DEBOUNCE
// =====================================================

function acumularMensagem(phone, mensagem) {
  if (!bufferPorTelefone[phone]) {
    bufferPorTelefone[phone] = [];
  }

  bufferPorTelefone[phone].push(mensagem);

  if (timerPorTelefone[phone]) {
    clearTimeout(timerPorTelefone[phone]);
  }

  timerPorTelefone[phone] = setTimeout(() => {
    const mensagens =
      bufferPorTelefone[phone] || [];

    const mensagemCompleta =
      mensagens.join("\n").trim();

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
        error.response?.data || error.message
      );
    });
  }, DEBOUNCE_MS);
}

// =====================================================
// Z-API
// =====================================================

async function enviarMensagemZAPI(phone, message) {
  const response = await axios.post(
    `${ZAPI_BASE_URL}/send-text`,
    {
      phone,
      message,
    },
    {
      headers: {
        "Client-Token": CLIENT_TOKEN,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  return response.data;
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

  if (!historicoPorTelefone[phone]) {
    historicoPorTelefone[phone] = [];
  }

  const historico =
    historicoPorTelefone[phone];

  const estado = obterEstado(phone);

  // ===================================================
  // SAUDAÇÃO FIXA
  // ===================================================

  if (
    ehSaudacao(userMessage) &&
    historico.length === 0
  ) {
    historico.push({
      role: "user",
      content: userMessage,
    });

    historico.push({
      role: "assistant",
      content: welcomeMessage,
    });

    historicoPorTelefone[phone] =
      historico.slice(-MAX_MESSAGES);

    await enviarMensagemZAPI(
      phone,
      welcomeMessage
    );

    return;
  }

  let mensagemParaIA = userMessage;

  // ===================================================
  // CORREÇÃO DE CONTEXTO:
  // CATUPIRY NÃO É COCA-COLA 😂
  // ===================================================

  const contextoAtual =
    detectarContextoAtual(historico);

  if (
    contextoAtual === "BEBIDA" &&
    possuiOpcaoBorda(userMessage) &&
    !possuiBebida(userMessage)
  ) {
    mensagemParaIA =
      `ATENÇÃO: o cliente mencionou uma opção de BORDA, ` +
      `não uma bebida.\n\n` +
      `Mensagem original:\n${userMessage}\n\n` +
      `Interprete como escolha/correção da borda. ` +
      `Confirme corretamente a borda e depois pergunte novamente a bebida. ` +
      `NUNCA chame Catupiry, Cheddar ou Chocolate de bebida.`;
  }

  // ===================================================
  // PAGAMENTO EM DINHEIRO
  // ===================================================

  if (
    estaPerguntandoPagamento(historico) &&
    mensagemEscolheDinheiro(userMessage)
  ) {
    const total =
      extrairUltimoTotal(historico);

    estado.totalAtual = total;

    // Caso mande rápido:
    // dinheiro
    // não
    if (possuiNegacaoTroco(userMessage)) {
      estado.aguardandoTroco = false;

      mensagemParaIA =
        `O cliente escolheu pagamento em dinheiro ` +
        `e NÃO precisa de troco. ` +
        `Continue para a finalização sem perguntar pagamento novamente.`;
    } else {
      const valorNaMesmaMensagem =
        extrairValorMonetario(userMessage);

      // "dinheiro 100"
      if (
        valorNaMesmaMensagem !== null &&
        total !== null
      ) {
        if (valorNaMesmaMensagem < total) {
          estado.aguardandoTroco = true;

          const resposta =
            `O total do pedido é ${formatarReal(total)}. ` +
            `O valor informado (${formatarReal(valorNaMesmaMensagem)}) ` +
            `é menor que o total. 😅\n\n` +
            `Você vai pagar com qual valor?`;

          historico.push({
            role: "user",
            content: userMessage,
          });

          historico.push({
            role: "assistant",
            content: resposta,
          });

          historicoPorTelefone[phone] =
            historico.slice(-MAX_MESSAGES);

          await enviarMensagemZAPI(
            phone,
            resposta
          );

          return;
        }

        const troco =
          valorNaMesmaMensagem - total;

        estado.aguardandoTroco = false;

        mensagemParaIA =
          `INFORMAÇÃO VALIDADA PELO SISTEMA:\n` +
          `Forma de pagamento: DINHEIRO\n` +
          `Total: ${formatarReal(total)}\n` +
          `Cliente pagará com: ${formatarReal(valorNaMesmaMensagem)}\n` +
          `Troco correto: ${formatarReal(troco)}\n\n` +
          `Use EXATAMENTE esses valores no resumo final. ` +
          `Não recalcule e não use nenhum valor antigo.`;
      } else {
        estado.aguardandoTroco = true;

        const resposta =
          `Certo! Pagamento em dinheiro. 💵\n\n` +
          `Precisa de troco? Se sim, para quanto?`;

        historico.push({
          role: "user",
          content: userMessage,
        });

        historico.push({
          role: "assistant",
          content: resposta,
        });

        historicoPorTelefone[phone] =
          historico.slice(-MAX_MESSAGES);

        await enviarMensagemZAPI(
          phone,
          resposta
        );

        return;
      }
    }
  }

  // ===================================================
  // ESTAMOS ESPERANDO A RESPOSTA DO TROCO
  // ===================================================

  else if (estado.aguardandoTroco) {
    if (possuiNegacaoTroco(userMessage)) {
      estado.aguardandoTroco = false;

      mensagemParaIA =
        `INFORMAÇÃO VALIDADA PELO SISTEMA:\n` +
        `Forma de pagamento: DINHEIRO\n` +
        `O cliente NÃO precisa de troco.\n\n` +
        `Continue para a finalização. ` +
        `Não pergunte novamente sobre pagamento ou troco.`;
    } else {
      const valorPagamento =
        extrairValorMonetario(userMessage);

      if (valorPagamento !== null) {
        const total =
          estado.totalAtual ??
          extrairUltimoTotal(historico);

        if (
          total !== null &&
          valorPagamento < total
        ) {
          estado.totalAtual = total;

          const resposta =
            `O total do pedido é ${formatarReal(total)}. ` +
            `O valor informado (${formatarReal(valorPagamento)}) ` +
            `é menor que o total. 😅\n\n` +
            `Você vai pagar com qual valor? ` +
            `Informe um valor igual ou maior que ${formatarReal(total)}, ` +
            `ou escolha PIX/cartão.`;

          historico.push({
            role: "user",
            content: userMessage,
          });

          historico.push({
            role: "assistant",
            content: resposta,
          });

          historicoPorTelefone[phone] =
            historico.slice(-MAX_MESSAGES);

          await enviarMensagemZAPI(
            phone,
            resposta
          );

          return;
        }

        if (total !== null) {
          const troco =
            valorPagamento - total;

          estado.aguardandoTroco = false;

          mensagemParaIA =
            `INFORMAÇÃO VALIDADA PELO SISTEMA:\n` +
            `Forma de pagamento: DINHEIRO\n` +
            `Total: ${formatarReal(total)}\n` +
            `Cliente pagará com: ${formatarReal(valorPagamento)}\n` +
            `Troco correto: ${formatarReal(troco)}\n\n` +
            `Use EXATAMENTE esses valores no resumo final. ` +
            `Não use valores anteriores e não recalcule o troco.`;
        }
      }
    }
  }

  // ===================================================
  // CONTEXTO EXPLÍCITO PARA A IA
  // ===================================================

  const contexto =
    detectarContextoAtual(historico);

  if (
    contexto &&
    mensagemParaIA === userMessage
  ) {
    mensagemParaIA =
      `[CONTEXTO DA CONVERSA: a última etapa era ${contexto}.]\n` +
      `${userMessage}`;
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
      content: mensagemParaIA,
    },
  ];

  const completion =
    await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
      max_tokens: 650,
    });

  const resposta =
    completion.choices?.[0]?.message?.content?.trim();

  if (!resposta) {
    throw new Error(
      "OpenAI retornou resposta vazia."
    );
  }

  historico.push({
    role: "user",
    content: userMessage,
  });

  historico.push({
    role: "assistant",
    content: resposta,
  });

  historicoPorTelefone[phone] =
    historico.slice(-MAX_MESSAGES);

  await enviarMensagemZAPI(
    phone,
    resposta
  );
}

// =====================================================
// WEBHOOK
// =====================================================

app.post("/webhook", (req, res) => {
  const body = req.body;

  console.log(
    "BODY RECEBIDO:",
    JSON.stringify(body, null, 2)
  );

  // A Z-API não fica esperando a OpenAI.
  res.status(200).json({
    status: "received",
  });

  if (body?.fromMe) {
    return;
  }

  // Se houver messageId, evita processamento duplicado.
  if (body?.messageId) {
    if (
      messageIdsProcessados.has(body.messageId)
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

  const phone = body?.phone;

  const userMessage =
    body?.text?.message?.trim();

  if (!phone || !userMessage) {
    console.log(
      "IGNORADO: payload sem telefone ou texto."
    );
    return;
  }

  console.log(
    `Mensagem recebida de ${phone}: ${userMessage}`
  );

  // ===================================================
  // RESET
  // ===================================================

  if (
    normalizarTexto(userMessage) ===
    "reiniciar"
  ) {
    if (timerPorTelefone[phone]) {
      clearTimeout(
        timerPorTelefone[phone]
      );

      delete timerPorTelefone[phone];
    }

    delete bufferPorTelefone[phone];

    enfileirarPorTelefone(
      phone,
      async () => {
        historicoPorTelefone[phone] = [];

        estadoPorTelefone[phone] = {
          aguardandoTroco: false,
          totalAtual: null,
        };

        await enviarMensagemZAPI(
          phone,
          "🔄 Conversa reiniciada. Mande um oi para começar novamente."
        );
      }
    ).catch((error) => {
      console.error(
        "ERRO AO REINICIAR:",
        error.response?.data || error.message
      );
    });

    return;
  }

  // ===================================================
  // AGRUPA AS MENSAGENS
  // ===================================================

  acumularMensagem(
    phone,
    userMessage
  );
});

// =====================================================
// ROTAS DE TESTE
// =====================================================

app.get("/", (req, res) => {
  res.send("MJ Pizzaria rodando");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    zapiInstanceConfigured:
      Boolean(ZAPI_INSTANCE),
    clientTokenConfigured:
      Boolean(CLIENT_TOKEN),
    openaiConfigured:
      Boolean(OPENAI_API_KEY),
    debounceMs: DEBOUNCE_MS,
  });
});

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
    `Debounce configurado: ${DEBOUNCE_MS}ms`
  );
});