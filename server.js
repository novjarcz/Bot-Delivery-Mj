const express = require("express");
const { OpenAI } = require("openai");

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const systemPrompt = `Você é o atendente oficial do BlackFood Delivery. 
Responda de forma simpática, direta e natural. Nunca invente preços ou produtos.

CARDÁPIO:

🍕 PIZZAS (todas com borda catupiry grátis):
- Calabresa: R$ 39,90
- Pepperoni: R$ 44,90
- Frango com Catupiry: R$ 42,90
- Margherita: R$ 38,90
- 4 Queijos: R$ 45,90

🍔 LANCHES:
- X-Burger: R$ 22,90
- X-Bacon: R$ 26,90
- X-Tudo: R$ 29,90
- Combo 2 lanches + refri: R$ 49,90

🍟 ACOMPANHAMENTOS:
- Batata Frita: R$ 14,90
- Onion Rings: R$ 16,90

🥤 BEBIDAS:
- Coca-Cola 2L: R$ 12,90
- Guaraná 2L: R$ 11,90
- Suco Natural 500ml: R$ 9,90

Taxa de entrega: R$ 6,90 (grátis acima de R$ 60)
Tempo médio: 35-50 minutos

Regras:
- Se o cliente pedir algo fora do cardápio, diga que não temos.
- Sempre confirme o pedido no final.
- Seja educado e rápido nas respostas.`;

let historico = [];

app.post("/chat", async (req, res) => {
  try {
    const { mensagem } = req.body;
    if (!mensagem) return res.status(400).json({ erro: "mensagem obrigatória" });

    const messages = [
      { role: "system", content: systemPrompt },
      ...historico,
      { role: "user", content: mensagem },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 350,
    });

    const resposta = completion.choices[0].message.content;

    historico.push({ role: "user", content: mensagem });
    historico.push({ role: "assistant", content: resposta });
    if (historico.length > 12) historico = historico.slice(-12);

    res.json({ resposta });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: "erro interno" });
  }
});

// Webhook Z-API
app.post("/webhook", (req, res) => {
  console.log("Mensagem recebida do Z-API:", req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("BlackFood rodando"));
app.get("/health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
