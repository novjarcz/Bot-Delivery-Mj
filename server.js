const express = require("express");
const { OpenAI } = require("openai");
const axios = require("axios");

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE || "3F3501433C3532F505358ED7FF7B999D";
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || "2567375A130613D6936DEC06";
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "Fe50f4e8e40664a07bada2fb92da37137S";

const systemPrompt = `Você é o atendente oficial do BlackFood Delivery. 
Responda de forma simpática, direta e natural. Nunca invente preços ou produtos.

CARDÁPIO:

?? PIZZAS

Pequena R$35
Média R$45
Grande R$59

Sabores:
Calabresa
Frango Catupiry
Portuguesa
Bacon
Quatro Queijos
Marguerita

Bordas:
Catupiry +8
Cheddar +8
Chocolate +10

?? LANCHES

X-Burger R$18
X-Salada R$20
X-Egg R$22
X-Bacon R$25
X-Tudo R$32
Smash Duplo R$28

Adicionais:
Ovo +2
Presunto +3
Catupiry +5
Cheddar +5
Calabresa +6
Hambúrguer extra +8
Bacon extra +6

?? PORÇÕES

Batata frita R$12
Batata cheddar e bacon R$18

?? MOLHOS

Alho +3
Verde +3
Especial +4
Picante +4

?? BEBIDAS

Água R$3
Coca-Cola 2L R$14
Guaraná 2L R$12
Coca lata R$6
Guaraná lata R$5
Suco de laranja R$8
Suco de morango R$9

?? CERVEJAS

Heineken R$9
Corona R$10
Budweiser R$8

?? AÇAÍ

300ml R$14
500ml R$18
700ml R$24

Adicionais:
Leite condensado +2
Nutella +5
Paçoca +2
Granola +2
Morango +4
Banana +3


Taxa de entrega: R$ 6,90 (grátis acima de R$ 60)
Tempo médio: 35-50 minutos

Regras:
- Se o cliente pedir algo fora do cardápio, diga que não temos.
- Sempre confirme o pedido no final.
- Seja educado e rápido nas respostas.`;

let historico = [];

async function enviarMensagemZAPI(phone, mensagem) {
  try {
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      {
        phone: phone,
        message: mensagem,
      },
      {
        headers: {
          "Client-Token": ZAPI_CLIENT_TOKEN,
        },
      }
    );
  } catch (err) {
    console.error("Erro ao enviar no Z-API:", err.response?.data || err.message);
  }
}

// Webhook Z-API com resposta automática
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.text && body.text.message && !body.fromMe) {
      const mensagem = body.text.message;
      const phone = body.phone;

      console.log(`Mensagem de ${phone}: ${mensagem}`);

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

      await enviarMensagemZAPI(phone, resposta);
    }
  } catch (e) {
    console.error("Erro no webhook:", e);
  }
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("BlackFood rodando"));
app.get("/health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
