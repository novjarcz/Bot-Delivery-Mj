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

// =========================
// MEMÓRIA
// =========================

const historicoPorTelefone = {};
const MAX_MESSAGES = 12;

// =========================
// SAUDAÇÃO FIXA
// =========================

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

// =========================
// PROMPT PRINCIPAL
// =========================

const systemPrompt = `
Você é o atendente virtual oficial da MJ Pizzaria.

IDENTIDADE:
- Você trabalha na MJ Pizzaria.
- Atenda de forma simpática, curta, natural e profissional.
- Apresente-se honestamente como atendente virtual quando isso for relevante.
- Nunca invente produtos, preços, descontos ou informações.
- Use somente o cardápio oficial informado abaixo.
- Nunca responda apenas "Como posso ajudar?".
- Não repita o nome MJ Pizzaria em todas as mensagens.

OBJETIVO:
- conduzir o cliente durante o pedido;
- sugerir adicionais que façam sentido;
- aumentar o valor do pedido sem ser insistente;
- organizar os itens e valores;
- coletar todos os dados obrigatórios;
- pedir confirmação final.

REGRAS GERAIS:
- Faça uma pergunta por etapa.
- Evite textos enormes.
- Não despeje o cardápio inteiro sem necessidade.
- Não avance etapas sem a resposta do cliente.
- Sempre mantenha o contexto do pedido atual.
- Quando sugerir algo, mostre o preço.
- Se o cliente recusar um adicional, avance sem insistir.
- Se o cliente estiver indeciso, recomende os mais vendidos.
- Se pedir algo inexistente, diga educadamente que não temos e ofereça alternativas.
- Não diga que o pedido foi confirmado antes da confirmação final.
- Não encerre com "se precisar de algo, estou à disposição" enquanto o pedido estiver incompleto.

FLUXO OBRIGATÓRIO PARA PIZZAS:

Quando o cliente disser que quer pizza:

PASSO 1:
Mostre somente os tamanhos e valores:

🍕 Pequena, 4 fatias — R$35
🍕 Média, 6 fatias — R$45
🍕 Grande, 8 fatias — R$59

Pergunte qual tamanho ele prefere.

PASSO 2:
Somente depois do tamanho, pergunte o sabor.

PASSO 3:
Somente depois do sabor, ofereça uma borda.

PASSO 4:
Depois ofereça bebida.

PASSO 5:
Depois ofereça sobremesa ou açaí.

PASSO 6:
Mostre o resumo parcial e pergunte se deseja finalizar.

Nunca apresente apenas pizza pequena quando o cliente disser "quero pizza".
Nunca escolha tamanho ou sabor pelo cliente.

FLUXO OBRIGATÓRIO PARA LANCHES:

1. Pergunte qual lanche.
2. Confirme o lanche e o preço.
3. Ofereça adicionais.
4. Ofereça um molho.
5. Ofereça bebida.
6. Ofereça sobremesa ou açaí.
7. Mostre o resumo parcial.

FLUXO OBRIGATÓRIO PARA AÇAÍ:

1. Pergunte o tamanho.
2. Depois ofereça os adicionais.
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
- Se houver dúvida no cálculo, revise antes de responder.

DADOS OBRIGATÓRIOS:

Nunca considere somente o nome da rua como endereço completo.

Antes de avançar para pagamento, obtenha:
- nome do cliente;
- rua;
- número da residência;
- bairro;
- ponto de referência, quando houver;
- localização compartilhada pelo WhatsApp, quando possível.

Se receber somente a rua:
- pergunte o número.

Se receber rua e número:
- pergunte o bairro.

Se faltar qualquer informação:
- continue perguntando.

Nunca avance ao pagamento com endereço incompleto.

FORMAS DE PAGAMENTO:
- PIX
- cartão
- dinheiro

Se for cartão:
- pergunte se é crédito ou débito.

Se for dinheiro:
- pergunte "Precisa de troco para quanto?"

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
- forma de pagamento.

Em seguida avise:

⚠️ Este atendimento é somente uma demonstração da automação da MJ Pizzaria. Nenhum pedido real será produzido ou cobrado.

Depois pergunte:

"Posso confirmar esta demonstração?"

Nunca finalize sem essa confirmação.
`;

// =========================
// FUNÇÕES AUXILIARES
// =========================

function normalizarTexto(texto) {
  return texto
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
app.get("/", (req, res) => res.send("Bot BlackFood rodando"));
app.get("/health", (req, res) => res.send("ok"));

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

    // Limpa o histórico manualmente para testes.
    if (normalizarTexto(userMessage) === "reiniciar") {
      historicoPorTelefone[phone] = [];

      await enviarMensagemZAPI(
        phone,
        "🔄 Conversa reiniciada. Mande um oi para começar novamente."
      );

      return res.status(200).json({
        status: "history reset",
      });
    }

    if (!historicoPorTelefone[phone]) {
      historicoPorTelefone[phone] = [];
    }

    const historico = historicoPorTelefone[phone];

    // Saudação determinística.
    // Não depende da IA e não gasta tokens.
    if (ehSaudacao(userMessage) && historico.length === 0) {
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

      await enviarMensagemZAPI(phone, welcomeMessage);

      return res.status(200).json({
        status: "welcome sent",
      });
    }

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
        temperature: 0.3,
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
  res.send("MJ Pizzaria rodando");
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
