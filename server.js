require("dotenv").config();

const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// =========================
// VARIÁVEIS DE AMBIENTE
// =========================

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

// Histórico separado por telefone.
// Antes, todos os clientes compartilhavam o mesmo histórico.
const historicoPorTelefone = {};
const MAX_MESSAGES = 12;

// =========================
// PROMPT
// =========================

const systemPrompt = `
Você é o atendente oficial do BlackFood Delivery.

Responda de forma simpática, curta, direta e natural.
Nunca invente produtos, preços, promoções ou informações.

OBJETIVO:
- conduzir o cliente durante o pedido;
- sugerir adicionais que façam sentido;
- aumentar o valor do pedido sem ser insistente;
- confirmar todos os dados antes da finalização.

FLUXO OBRIGATÓRIO PARA PIZZAS:
1. Pergunte primeiro o tamanho e mostre os preços.
2. Depois pergunte o sabor.
3. Depois ofereça borda.
4. Depois ofereça bebida.
5. Depois ofereça sobremesa.
6. Só então mostre o resumo.

Nunca ofereça apenas pizza pequena quando o cliente disser "quero pizza".

FLUXO PARA LANCHES:
1. Pergunte qual lanche.
2. Ofereça adicionais.
3. Ofereça molho.
4. Ofereça bebida.
5. Ofereça sobremesa.
6. Mostre o resumo.

CARDÁPIO:

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
- Catupiry — adicional de R$8
- Cheddar — adicional de R$8
- Chocolate — adicional de R$10

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
- Taxa: R$6,90
- Entrega grátis em pedidos acima de R$60
- Tempo médio: 35 a 50 minutos

DADOS OBRIGATÓRIOS:
Nunca considere somente o nome da rua como endereço completo.

Antes de finalizar, confirme:
- nome do cliente;
- rua;
- número;
- bairro;
- ponto de referência, quando houver;
- localização compartilhada pelo WhatsApp, quando possível;
- forma de pagamento.

Se faltar número, pergunte o número.
Se faltar bairro, pergunte o bairro.
Nunca avance ao pagamento com endereço incompleto.

FORMAS DE PAGAMENTO:
- PIX
- cartão;
- dinheiro.

Se for dinheiro, pergunte:
"Precisa de troco para quanto?"

FINALIZAÇÃO:
1. Mostre todos os itens e valores.
2. Mostre a taxa de entrega, quando aplicável.
3. Mostre o valor total.
4. Confirme endereço e pagamento.
5. Peça a confirmação final do cliente.

Antes de concluir, avise:

"⚠️ Este atendimento é apenas uma demonstração da automação para delivery. Nenhum pedido real será produzido ou cobrado."
`;

// =========================
// ENVIO PELA Z-API
// =========================

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

// =========================
// WEBHOOK
// =========================

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    console.log(
      "BODY RECEBIDO:",
      JSON.stringify(body, null, 2)
    );

    // Ignora mensagens enviadas pelo próprio bot.
    if (body?.fromMe) {
      return res.status(200).json({
        status: "ignored - from me",
      });
    }

    const phone = body?.phone;
    const userMessage = body?.text?.message?.trim();

    if (!phone || !userMessage) {
      return res.status(200).json({
        status: "ignored - invalid payload",
      });
    }

    console.log(`Mensagem de ${phone}: ${userMessage}`);

    if (!historicoPorTelefone[phone]) {
      historicoPorTelefone[phone] = [];
    }

    const historico = historicoPorTelefone[phone];

    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...historico,
      {
        role: "user",
        content: userMessage,
      },
    ];

    const completion =
      await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.4,
        max_tokens: 600,
      });

    const resposta =
      completion.choices?.[0]?.message?.content?.trim();

    if (!resposta) {
      throw new Error("OpenAI retornou resposta vazia.");
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

    await enviarMensagemZAPI(phone, resposta);

    return res.status(200).json({
      status: "ok",
    });
  } catch (error) {
    console.error(
      "ERRO WEBHOOK:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      status: "error",
    });
  }
});

// =========================
// ROTAS DE TESTE
// =========================

app.get("/", (req, res) => {
  res.send("BlackFood rodando");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    zapiInstanceConfigured: Boolean(ZAPI_INSTANCE),
    clientTokenConfigured: Boolean(CLIENT_TOKEN),
    openaiConfigured: Boolean(OPENAI_API_KEY),
  });
});

// =========================
// SERVIDOR
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
