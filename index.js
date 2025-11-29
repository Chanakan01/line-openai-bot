import express from "express";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// ---------------- CONFIG ----------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ---------------- MEMORY ----------------
let memory = {}; 
function saveMsg(userId, role, content) {
  if (!memory[userId]) memory[userId] = [];
  memory[userId].push({ role, content });

  if (memory[userId].length > 20) memory[userId].shift();

  // ลบ memory หลัง 20 นาที
  setTimeout(() => delete memory[userId], 20 * 60 * 1000);
}

// ---------------- IMAGE ANALYSIS ----------------
async function analyzeImage(base64) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "ช่วยวิเคราะห์รูปนี้ให้ละเอียดที่สุด" },
            {
              type: "image_url",
              image_url: `data:image/jpeg;base64,${base64}`
            }
          ]
        }
      ]
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  return res.data.choices[0].message.content;
}

// ---------------- IMAGE GENERATION ----------------
async function generateImage(prompt) {
  const res = await axios.post(
    "https://api.openai.com/v1/images/generations",
    {
      model: "gpt-image-1",
      prompt,
      size: "1024x1024"
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return res.data.data[0].url;
}

// ---------------- MAIN AI (เหมือน ChatGPT) ----------------
async function arvinAI(userId) {
  const messages = [
    {
      role: "system",
      content: `
คุณคือ Arvin ผู้ช่วยอัจฉริยะเวอร์ชันดีที่สุดของ OpenAI
- เป็นผู้ชาย บุคลิกสุขุม อบอุ่น ฉลาด และเป็นกันเอง
- ตอบฉลาดเหมือน ChatGPT ตัวเต็ม
- รอบรู้ทุกเรื่อง: วิทยาศาสตร์ ภาษา โปรแกรมมิ่ง ศิลปะ ธุรกิจ การบ้าน ประวัติศาสตร์ ฯลฯ
- สามารถสร้างภาพ วิเคราะห์ภาพ เขียนไฟล์ ทำสรุป ย่อความ อธิบายลึกๆ และเขียนโค้ดได้ทั้งหมด
- ใช้ภาษามนุษย์เป็นธรรมชาติ อธิบายง่ายแต่มีความรู้แน่น
- ต้องการช่วยเหลือผู้ใช้เต็มที่เสมอ
      `
    },
    ...(memory[userId] || [])
  ];

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1",
      messages,
      temperature: 0.8
    },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  return res.data.choices[0].message.content;
}

// ---------------- SEND REPLY TO LINE ----------------
async function replyLINE(replyToken, messages) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    {
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ---------------- WEBHOOK ----------------
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    const userId = event.source.userId;

    // ====================== กรณีเป็นรูปภาพ ======================
    if (event.message.type === "image") {
      const content = await axios.get(
        `https://api.line.me/v2/bot/message/${event.message.id}/content`,
        {
          responseType: "arraybuffer",
          headers: { Authorization: `Bearer ${LINE_TOKEN}` }
        }
      );

      const base64img = Buffer.from(content.data).toString("base64");
      const analysis = await analyzeImage(base64img);

      saveMsg(userId, "assistant", analysis);
      await replyLINE(event.replyToken, [{ type: "text", text: analysis }]);
      continue;
    }

    // ====================== กรณีเป็นข้อความ ======================
    const userMsg = event.message.text;
    saveMsg(userId, "user", userMsg);

    // ---------- ฟีเจอร์สร้างรูป ----------
    if (
      userMsg.startsWith("วาด") ||
      userMsg.startsWith("สร้างรูป") ||
      userMsg.includes("ช่วยวาด") ||
      userMsg.includes("ขอรูป")
    ) {
      const prompt = userMsg
        .replace("วาด", "")
        .replace("สร้างรูป", "")
        .replace("ช่วยวาด", "")
        .replace("ขอรูป", "")
        .trim();

      try {
        const img = await generateImage(prompt);
        await replyLINE(event.replyToken, [
          { type: "image", originalContentUrl: img, previewImageUrl: img }
        ]);
      } catch {
        await replyLINE(event.replyToken, [
          { type: "text", text: "ผมวาดรูปไม่สำเร็จครับ 😢 ลองใหม่ได้ไหมครับ" }
        ]);
      }
      continue;
    }

    // ---------- ฟีเจอร์เขียนไฟล์ ----------
    if (userMsg.includes("สร้างไฟล์") || userMsg.includes("เขียนไฟล์")) {
      const text = await arvinAI(userId);
      fs.writeFileSync("arvin_file.txt", text);

      await replyLINE(event.replyToken, [
        {
          type: "text",
          text: "ผมสร้างไฟล์ให้แล้วครับ แต่ LINE Bot ยังส่งไฟล์โดยตรงไม่ได้ ต้องเก็บบนเซิร์ฟเวอร์หรือให้ลิงก์ดาวน์โหลดแทนครับ"
        }
      ]);
      continue;
    }

    // ---------- คำตอบปกติแบบ ChatGPT ----------
    const answer = await arvinAI(userId);
    saveMsg(userId, "assistant", answer);

    await replyLINE(event.replyToken, [{ type: "text", text: answer }]);
  }

  res.sendStatus(200);
});

// ---------------- START SERVER ----------------
app.listen(3000, () => console.log("Arvin Super AI is running on port 3000"));
