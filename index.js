import express from "express";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// -------- CONFIG ---------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// -------- MEMORY (จำบทสนทนาล่าสุด 20 นาที) --------
let memory = {};
function saveMessage(userId, role, content) {
  if (!memory[userId]) memory[userId] = [];
  memory[userId].push({ role, content });

  if (memory[userId].length > 10) memory[userId].shift();

  // เคลียร์ความจำหลัง 20 นาที
  setTimeout(() => {
    delete memory[userId];
  }, 20 * 60 * 1000);
}

// ------------------------------------------------------
// ---------------------- WEBHOOK ------------------------
// ------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.sendStatus(200);

  for (const event of events) {
    if (event.type !== "message") continue;

    const userId = event.source.userId;
    const userMessage = event.message.text;
    saveMessage(userId, "user", userMessage);

    // ------------------------------------------------------
    // ----------- ตรวจคำสั่งขอสร้างรูป --------------------
    // ------------------------------------------------------
    if (
      userMessage.startsWith("วาด") ||
      userMessage.startsWith("สร้างรูป") ||
      userMessage.includes("ขอรูป") ||
      userMessage.includes("ช่วยวาด")
    ) {
      const prompt = userMessage
        .replace("วาด", "")
        .replace("สร้างรูป", "")
        .replace("ขอรูป", "")
        .replace("ช่วยวาด", "")
        .trim();

      try {
        const imageRes = await axios.post(
          "https://api.openai.com/v1/images/generations",
          {
            model: "gpt-image-1",
            prompt: prompt,
            size: "1024x1024"
          },
          {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
          }
        );

        const imageUrl = imageRes.data.data[0].url;

        await reply(event.replyToken, [
          {
            type: "image",
            originalContentUrl: imageUrl,
            previewImageUrl: imageUrl
          }
        ]);

        continue;
      } catch (err) {
        await reply(event.replyToken, [
          {
            type: "text",
            text: "ขออภัยครับ ผมวาดรูปไม่สำเร็จ ลองพิมพ์ใหม่อีกครั้งได้ไหมครับ 😢"
          }
        ]);
        continue;
      }
    }

    // ------------------------------------------------------
    // ------------------ ตอบปกติแบบ Arvin -----------------
    // ------------------------------------------------------
    const aiResponse = await askArvin(userId);
    saveMessage(userId, "assistant", aiResponse);

    await reply(event.replyToken, [
      {
        type: "text",
        text: aiResponse
      }
    ]);
  }

  return res.sendStatus(200);
});

// ------------------------------------------------------
// ---------------- ฟังก์ชันสร้างคำตอบ -------------------
// ------------------------------------------------------
async function askArvin(userId) {
  const messages = [
    {
      role: "system",
      content: `
คุณชื่อ Arvin เป็นผู้ช่วยอัจฉริยะเวอร์ชั่นดีที่สุดของ OpenAI
- เป็นผู้ชาย น้ำเสียงสุขุม ฉลาด อบอุ่น ใช้สรรพนามว่า "ผม"
- รอบรู้ทุกเรื่อง: วิทยาศาสตร์, คณิตศาสตร์, ประวัติศาสตร์, ภาษา, สุขภาพ, ชีวิตประจำวัน, เขียนโค้ด, การบ้าน, การออกแบบ, การตลาด ฯลฯ
- ตอบกระชับ เข้าใจง่าย แต่สามารถลงรายละเอียดเชิงลึกเมื่อถูกขอ
- เป็นกันเองเหมือนเพื่อนที่ฉลาด + ที่ปรึกษาส่วนตัว
- ช่วยเต็มที่เสมอ แต่จะปฏิเสธอย่างสุภาพถ้าเป็นเรื่องผิดกฎหมาย/อันตราย
      `.trim()
    },
    ...(memory[userId] || [])
  ];

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1",
      messages,
      temperature: 0.8
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.choices[0].message.content;
}

// ------------------------------------------------------
// ---------------- ฟังก์ชันตอบกลับ LINE -----------------
// ------------------------------------------------------
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

// ------------------------------------------------------
// ----------------------- SERVER ------------------------
// ------------------------------------------------------
app.listen(3000, () => console.log("Arvin bot running on port 3000"));
