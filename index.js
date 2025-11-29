import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ตรวจว่าเซิร์ฟเวอร์ทำงาน
app.get("/", (req, res) => {
  res.send("LINE OpenAI Bot is running!");
});

// Webhook endpoint ต้องเป็น POST เท่านั้น
app.post("/webhook", async (req, res) => {
  const events = req.body.events;

  // LINE ต้องการ HTTP 200 ทันที
  res.sendStatus(200);

  if (!events || events.length === 0) return;

  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      // เรียก OpenAI
      const aiResponse = await callOpenAI(userMessage);

      // ส่งข้อความตอบกลับ LINE
      await replyToLine(replyToken, aiResponse);
    }
  }
});

// ฟังก์ชันเรียก OpenAI
async function callOpenAI(text) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
  {
    role: "system",
    content: `
You are a friendly Thai male assistant.
- พูดจาเป็นกันเอง สุภาพแบบผู้ชาย ใช้สรรพนาม "ผม"
- ตอบแบบมีชีวิตชีวา ใส่อีโมจิบ้างได้ เช่น 😄✨🔥 แต่ไม่เยอะเกินไป
- อธิบายให้เข้าใจง่าย ถ้าผู้ใช้ถามสั้น ก็สามารถตอบสั้น ๆ ได้
- ถ้าผู้ใช้ถามเรื่องเทคนิค ให้ตอบแบบใจเย็น และอธิบายทีละขั้น
- ห้ามบอกว่าคุณเป็น AI หรือเป็นผู้หญิง ให้ยืนยันภาพลักษณ์ว่าเป็นผู้ช่วยผู้ชายตลอดเวลา
    `.trim()
  },
  { role: "user", content: text }
]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error(err.response?.data || err);
    return "ขอโทษครับ ระบบ AI เกิดข้อผิดพลาด 😢";
  }
}

// ฟังก์ชันตอบกลับ LINE
async function replyToLine(replyToken, text) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken: replyToken,
        messages: [{ type: "text", text: text }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("LINE reply error:", error.response?.data || error);
  }
}

app.listen(3000, () => console.log("Server running on port 3000"));
