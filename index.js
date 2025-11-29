import express from "express";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// -------- CONFIG ---------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// Memory (จำการคุยล่าสุด 20 นาที)
let memory = {}; 
function saveMessage(userId, role, content) {
  if (!memory[userId]) memory[userId] = [];
  memory[userId].push({ role, content });
  if (memory[userId].length > 10) memory[userId].shift();   // จำกัดความยาว 10 ข้อความ
  setTimeout(() => { delete memory[userId]; }, 20 * 60 * 1000);
}

// ------ Webhook ------
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.sendStatus(200);

  for (const event of events) {
    const userId = event.source.userId;

    if (event.type === "message") {
      const userMessage = event.message.text;
      saveMessage(userId, "user", userMessage);

      // -------- ถ้าผู้ใช้ขอสร้างรูป ----------  
      if (userMessage.startsWith("วาด") || userMessage.startsWith("สร้างรูป")) {
        const prompt = userMessage.replace("วาด", "").replace("สร้างรูป", "");
        
        const imageRes = await axios.post(
          "https://api.openai.com/v1/images/generations",
          {
            model: "gpt-image-1",
            prompt: prompt,
            size: "1024x1024"
          },
          { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
        );

        const imageUrl = imageRes.data.data[0].url;

        await reply(event.replyToken, [
          { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl }
        ]);
        continue;
      }

      // ---------- ตอบแบบ Arvin บุคลิกดี ๆ ----------
      const aiResponse = await askArvin(userId);

      saveMessage(userId, "assistant", aiResponse);

      await reply(event.replyToken, [
        { type: "text", text: aiResponse }
      ]);
    }
  }

  return res.sendStatus(200);
});

// --------- ฟังก์ชันสร้างคำตอบ ----------
async function askArvin(userId) {
  const messages = [
    {
      role: "system",
      content: `
      คุณชื่อ Arvin เป็นผู้ช่วยอัจฉริยะเวอร์ชั่นดีที่สุดของ OpenAI
      - เป็นผู้ชาย น้ำเสียงสุขุม ฉลาด อบอุ่น
      - ตอบกระชับแต่เข้าใจง่าย
      - อธิบายเชิงลึกได้เมื่อถูกถาม
      - เป็นกันเองเหมือนเพื่อนและผู้ช่วยส่วนตัว
      `
    },
    ...(memory[userId] || [])
  ];

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1",
      messages: messages,
      temperature: 0.8
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  return response.data.choices[0].message.content;
}

// --------- ฟังก์ชันตอบกลับ LINE ---------
async function reply(replyToken, messages) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ---------------- SERVER ----------------
app.listen(3000, () => console.log("Bot running on port 3000"));
