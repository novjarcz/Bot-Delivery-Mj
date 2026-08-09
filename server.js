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

// Quantos milissegundos esperamos o cliente terminar
// de escrever antes de mandar tudo para a IA.
//
// 4000 = 4 segundos
const DEBOUNCE_MS = 4000;

// Quantas mensagens ficam na memória de cada cliente.
const MAX_MESSAGES = 16;

// =====================================================
// MEMÓRIA
// =====================================================

// Histórico separado por telefone.
const historicoPorTelefone = {};

// Guarda mensagens picadas:
// "oi" + "quero" + "pizza"
const bufferPorTelefone = {};

// Guarda os timers do debounce.
const timerPorTelefone = {};

// Garante que um mesmo cliente seja processado
// uma mensagem por vez.
const filaPorTelefone = {};

// =====================================================
// SAUDAÇÃO FIXA
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

IDENTIDADE:
- Você trabalha na MJ Pizzaria.
- Atenda de forma simpática, curta, natural e profissional.
- Apresente-se como atendente virtual somente quando isso for relevante.
- Nunca invente produtos, preços, descontos ou informações.
- Use somente o cardápio oficial informado abaixo.
- Nunca responda apenas "Como posso ajudar?".
- Não repita o nome MJ Pizzaria em todas as mensagens.

IMPORTANTE SOBRE AS MENSAGENS:
O cliente pode escrever várias mensagens curtas seguidas.
O sistema poderá juntar essas mensagens antes de enviá-las para você.

Exemplo recebido:

"oi
quero
uma pizza
grande"

Interprete tudo como UMA única fala do cliente:

"Oi, quero uma pizza grande."

Nunca responda separadamente a cada linha.

OBJETIVO:
- conduzir o cliente durante o pedido;
- sugerir adicionais que façam sentido;
- aumentar o valor do pedido sem ser insistente;
- organizar os itens e valores;
- coletar todos os dados obrigatórios;
- pedir confirmação final.

REGRAS GERAIS:
- Faça uma pergunta por etapa quando faltar uma decisão.
- Evite textos enormes.
- Não despeje o cardápio inteiro sem necessidade.
- Não avance etapas importantes sem a resposta do cliente.
- Sempre mantenha o contexto do pedido atual.
- Quando sugerir algo, mostre o preço.
- Se o cliente recusar um adicional, avance sem insistir.
- Se o cliente estiver indeciso, recomende opções do cardápio.
- Se pedir algo inexistente, diga educadamente que não temos e ofereça alternativas.
- Não diga que o pedido foi confirmado antes da confirmação final.
- Não encerre com "se precisar de algo, estou à disposição" enquanto o pedido estiver incompleto.
- Se o cliente fornecer várias informações de uma vez, aproveite todas e NÃO pergunte novamente o que ele já informou.
- Não faça perguntas repetidas.
- Antes de perguntar alguma coisa, confira se o cliente já respondeu anteriormente.

FLUXO OBRIGATÓRIO PARA PIZZAS:

Quando o cliente disser somente que quer pizza:

PASSO 1:
Mostre os tamanhos e valores:

🍕 Pequena, 4 fatias — R$35
🍕 Média, 6 fatias — R$45
🍕 Grande, 8 fatias — R$59

Pergunte qual tamanho ele prefere.

IMPORTANTE:
Se o cliente já disser o tamanho na mesma mensagem, NÃO pergunte novamente o tamanho.

Exemplo:
"Quero pizza grande"

Nesse caso, avance diretamente para o sabor.

PASSO 2:
Depois do tamanho, pergunte o sabor.

PASSO 3:
Depois do sabor, ofereça borda.

PASSO 4:
Depois ofereça bebida.

PASSO 5:
Depois ofereça sobremesa ou açaí.

PASSO 6:
Mostre o resumo parcial e pergunte se deseja finalizar.

Nunca apresente apenas pizza pequena quando o cliente disser "quero pizza".
Nunca escolha tamanho ou sabor pelo cliente.

FLUXO OBRIGATÓRIO PARA LANCHES:

1. Identifique qual lanche o cliente deseja.
2. Confirme o lanche e preço.
3. Ofereça adicionais.
4. Ofereça molho.
5. Ofereça bebida.
6. Ofereça sobremesa ou açaí.
7. Mostre o resumo parcial.

Se o cliente já informar adicional, bebida ou molho junto com o lanche,
não pergunte novamente o que ele já informou.

FLUXO OBRIGATÓRIO PARA AÇAÍ:

1. Pergunte o tamanho se ainda não tiver sido informado.
2. Depois ofereça adicionais.
3. Mostre o subtotal.
4. Pergunte se deseja acrescentar mais alguma coisa.

CARDÁPIO OFICIAL:

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

Adicionais dos lanches:
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

ENTREGA:
- Taxa padrão — R$6,90
- Entrega grátis em pedidos acima de R$60
- Tempo médio — 35 a 50 minutos

CÁLCULO:
- Some somente itens escolhidos pelo cliente.
- Mostre cada item e preço.
- Aplique a taxa de R$6,90 quando o subtotal for até R$60.
- Não aplique taxa quando o subtotal for superior a R$60.
- Revise o cálculo antes de responder.

DADOS OBRIGATÓRIOS:

Nunca considere somente o nome da rua como endereço completo.

Antes de avançar para pagamento, obtenha:
- nome do cliente;
- rua;
- número da residência;
- bairro;
- ponto de referência, quando houver;
- localização compartilhada pelo WhatsApp, quando possível.

IMPORTANTE:
Se o cliente informar vários dados juntos, aproveite tudo.

Exemplo:
"Michel, Rua Paraná 50, bairro Centro"

Nesse caso já temos:
- nome: Michel
- rua: Rua Paraná
- número: 50
- bairro: Centro

NÃO pergunte novamente nenhuma dessas informações.

Se receber somente a rua:
- pergunte o número.

Se receber rua e número:
- pergunte o bairro.

Se faltar informação obrigatória:
- pergunte somente o que ainda falta.

Nunca avance ao pagamento com endereço incompleto.

FORMAS DE PAGAMENTO:
- PIX
- cartão
- dinheiro

Se for cartão:
- pergunte se é crédito ou débito.

Se for dinheiro:
- pergunte se precisa de troco.

REGRA CRÍTICA SOBRE TROCO:

Quando o pagamento for em dinheiro:

Se o cliente responder:
- "não"
- "nao"
- "não precisa"
- "nao precisa"
- "sem troco"
- "não preciso"
- "nao preciso"

entenda obrigatoriamente:

O CLIENTE NÃO PRECISA DE TROCO.

Nunca interprete "não" como valor monetário.

Se o cliente disser que precisa de troco:
- pergunte "Troco para quanto?"

Somente compare valores quando o cliente informar claramente um número.

Exemplos de valores:
- 50
- 100
- R$100
- troco para 100

Se o valor informado para pagamento for menor que o total:
- diga que o valor é insuficiente;
- informe o total;
- peça um valor igual ou superior ao total ou outra forma de pagamento.

Nunca invente um valor de troco.

FINALIZAÇÃO OBRIGATÓRIA:

Antes da confirmação final, mostre:

📋 RESUMO DO PEDIDO
- todos os itens;
- adicionais;
- bebidas;
- sobremesas;
- subtotal;
- taxa de entrega, quando houver;
- valor total.

Depois mostre:
- nome;
- endereço completo;
- forma de pagamento;
- informação de troco, quando aplicável.

Em seguida avise:

⚠️ Este atendimento é somente uma demonstração da automação da MJ Pizzaria. Nenhum pedido real será produzido ou cobrado.

Depois pergunte:

"Posso confirmar esta demonstração?"

Nunca finalize sem essa confirmação.
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

function ehNegacaoTroco(texto) {
  const mensagem = normalizarTexto(texto);

  const respostas = [
    "nao",
    "nao precisa",
    "nao preciso",
    "sem troco",
    "nao quero troco",
    "nao precisa de troco",
    "nao preciso de troco",
  ];

  return respostas.includes(mensagem);
}

function ultimaRespostaAssistente(historico = []) {
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i]?.role === "assistant") {
      return historico[i].content || "";
    }
  }

  return "";
}

function estaPerguntandoTroco(historico = []) {
  const ultima = normalizarTexto(
    ultimaRespostaAssistente(historico)
  );

  return (
    ultima.includes("troco") &&
    (
      ultima.includes("precisa") ||
      ultima.includes("para quanto") ||
      ultima.includes("quanto")
    )
  );
}

// Converte:
// "R$ 41,90" -> 41.90
// "100" -> 100
function converterValorBrasileiro(valor) {
  if (typeof valor !== "string") {
    valor = String(valor);
  }

  let limpo = valor
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

function extrairValorTroco(texto) {
  const normalizado = String(texto)
    .replace(/R\$/gi, "")
    .trim();

  // Procura valores como:
  // 50
  // 100
  // 100,00
  // troco para 100
  const matches =
    normalizado.match(/\d+(?:[.,]\d{1,2})?/g);

  if (!matches || matches.length === 0) {
    return null;
  }

  // Pega o último número da mensagem.
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

    // Procura padrões como:
    // Total: R$ 76,00
    // Valor total: R$76
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
  return valor.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

// =====================================================
// FILA POR TELEFONE
// =====================================================

function enfileirarPorTelefone(phone, tarefa) {
  const anterior =
    filaPorTelefone[phone] || Promise.resolve();

  const atual = anterior
    .catch(() => {
      // Impede erro antigo de quebrar a fila.
    })
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

  // Se o cliente mandou outra mensagem,
  // cancela a espera anterior.
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
// ENVIO PARA Z-API
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
// PROCESSAMENTO DA MENSAGEM
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

  // ===================================================
  // SAUDAÇÃO
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

  // ===================================================
  // TRATAMENTO CRÍTICO DE TROCO
  // ===================================================

  let mensagemParaIA = userMessage;

  if (estaPerguntandoTroco(historico)) {
    if (ehNegacaoTroco(userMessage)) {
      // Em vez de mandar simplesmente "não",
      // damos o significado exato para a IA.
      mensagemParaIA =
        "Não preciso de troco. " +
        "O pagamento será em dinheiro sem necessidade de troco. " +
        "Continue corretamente para a finalização do pedido.";
    } else {
      const valorTroco =
        extrairValorTroco(userMessage);

      const total =
        extrairUltimoTotal(historico);

      if (
        valorTroco !== null &&
        total !== null &&
        valorTroco < total
      ) {
        const resposta =
          `O total do pedido é ${formatarReal(total)}. ` +
          `O valor informado (${formatarReal(valorTroco)}) ` +
          `é menor que o total. 😅\n\n` +
          `Você vai pagar com qual valor? ` +
          `Pode informar um valor igual ou maior que ` +
          `${formatarReal(total)}, ou escolher PIX/cartão.`;

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

      if (valorTroco !== null) {
        mensagemParaIA =
          `Vou pagar em dinheiro e preciso de troco para ` +
          `${formatarReal(valorTroco)}. ` +
          `Continue corretamente a finalização do pedido.`;
      }
    }
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
      temperature: 0.3,
      max_tokens: 600,
    });

  const resposta =
    completion.choices?.[0]?.message?.content?.trim();

  if (!resposta) {
    throw new Error(
      "OpenAI retornou resposta vazia."
    );
  }

  // Salva a mensagem ORIGINAL do usuário,
  // não a versão traduzida internamente.
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

  // Responde rápido para a Z-API.
  // O processamento continua depois.
  res.status(200).json({
    status: "received",
  });

  // Ignora mensagens enviadas pelo próprio bot.
  if (body?.fromMe) {
    return;
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
  // COMANDO DE RESET
  // ===================================================

  if (
    normalizarTexto(userMessage) ===
    "reiniciar"
  ) {
    // Apaga qualquer mensagem que estivesse esperando
    // no debounce.
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
  // AGRUPA MENSAGENS PICADAS
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
