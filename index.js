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
  if (memory[userId].length > 10) memory[userId].shift(); // จำกัดความยาว 10 ข้อความ
  setTimeout(() => {
    delete memory[userId];
  }, 20 * 60 * 1000);
}

// health check
app.get("/", (req, res) => {
  res.send("Arvin bot is running!");
});

// ------ Webhook ------
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.sendStatus(200);

  // ตอบ 200 ให้ LINE ก่อน กัน timeout
  res.sendStatus(200);

  for (const event of events) {
    try {
      if (event.type !== "message" || event.message.type !== "text") {
        // ยังไม่รองรับ sticker / image / ฯลฯ ในเวอร์ชันนี้
        continue;
      }

      const userId = event.source.userId;
      const userMessage = (event.message.text || "").trim();
      if (!userMessage) continue;

      // บันทึกข้อความผู้ใช้ลง memory ก่อน
      saveMessage(userId, "user", userMessage);

      // 1) ให้โมเดลช่วยตัดสินใจก่อน ว่าควรใช้โหมดอะไร
      const modeResult = await decideMode(userMessage);
      const mode = modeResult.mode || "chat";
      const taskPrompt = modeResult.prompt || userMessage;

      console.log("Mode:", mode, "Prompt:", taskPrompt);

      // 2) แตกแขนงตามโหมดที่ตัดสินใจได้
      if (mode === "image") {
        // ---------- โหมดสร้างรูป ----------
        try {
          const imageUrl = await generateImage(taskPrompt);
          await reply(event.replyToken, [
            {
              type: "image",
              originalContentUrl: imageUrl,
              previewImageUrl: imageUrl
            }
          ]);
        } catch (err) {
          console.error("Image generation error:", err.response?.data || err);
          await reply(event.replyToken, [
            {
              type: "text",
              text: "ขอโทษครับ ผมสร้างรูปไม่สำเร็จ ลองอธิบายใหม่อีกครั้งได้ไหมครับ 😢"
            }
          ]);
        }
        continue;
      } else if (mode === "textFile") {
        // ---------- โหมดทำเนื้อหาไฟล์ ----------
        try {
          const fileContent = await generateFileContent(taskPrompt);
          await reply(event.replyToken, [
            {
              type: "text",
              text:
                "ผมเตรียมเนื้อหาไฟล์ให้แล้วครับ คุณสามารถคัดลอกไปบันทึกเป็นไฟล์ได้เลยนะครับ 👇\n\n" +
                fileContent
            }
          ]);
        } catch (err) {
          console.error("File content error:", err.response?.data || err);
          await reply(event.replyToken, [
            {
              type: "text",
              text: "ขอโทษครับ ผมเตรียมเนื้อหาไฟล์ไม่สำเร็จ ลองขอใหม่อีกครั้งได้ไหมครับ 🙏"
            }
          ]);
        }
        continue;
      } else {
        // ---------- โหมดคุยปกติแบบ Arvin ----------
        const aiResponse = await askArvin(userId);
        saveMessage(userId, "assistant", aiResponse);

        await reply(event.replyToken, [{ type: "text", text: aiResponse }]);
      }
    } catch (err) {
      console.error("Error handling event:", err.response?.data || err);
    }
  }
});

// --------- ฟังก์ชันตัดสินใจโหมด (chat / image / textFile) ----------
async function decideMode(userText) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: `
คุณเป็นตัวช่วยตัดสินใจโหมดการทำงานของบอทใน LINE
ให้ดูข้อความของผู้ใช้ แล้วตัดสินใจว่าเขาต้องการอะไร "มากที่สุด" ระหว่าง:
- "chat"      = แค่คุย/ถาม/ขอคำอธิบาย/ปรึกษา ฯลฯ
- "image"     = อยากให้สร้างรูปภาพ
- "textFile"  = อยากได้ข้อมูลในรูปแบบเนื้อหาไฟล์ (เช่น รายงาน, โน้ต, สรุป, โครงงาน, เอกสาร ฯลฯ)

เงื่อนไขโดยประมาณ:
- ถ้าผู้ใช้พูดถึง "ภาพ, รูป, วาด, illustration, poster, banner" หรืออธิบายฉาก/ดีไซน์ -> เลือก mode = "image"
- ถ้าผู้ใช้บอกว่า "ช่วยเขียนไฟล์, รายงาน, โครงงาน, เนื้อหา, บันทึก, โน้ต, สรุปเป็นหัวข้อ, ทำเอกสาร" -> เลือก mode = "textFile"
- นอกนั้นให้ใช้ mode = "chat"

ให้ตอบกลับเป็น JSON เท่านั้น เช่น:
{"mode":"image","prompt":"วาดภาพแมวใส่แว่นนั่งหน้าคอม"}

ห้ามอธิบายอย่างอื่นเพิ่ม
          `.trim()
          },
          {
            role: "user",
            content: userText
          }
        ],
        temperature: 0
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const content = response.data.choices[0].message.content.trim();
    try {
      return JSON.parse(content);
    } catch (e) {
      console.error("JSON parse error in decideMode:", content);
      return { mode: "chat", prompt: userText };
    }
  } catch (err) {
    console.error("decideMode error:", err.response?.data || err);
    return { mode: "chat", prompt: userText };
  }
}

// --------- ฟังก์ชันสร้างคำตอบคุยปกติ ----------
async function askArvin(userId) {
  const messages = [
    {
      role: "system",
      content: `
คุณชื่อ Arvin เป็นผู้ช่วยอัจฉริยะเวอร์ชั่นดีที่สุดของ OpenAI
- เป็นผู้ชาย น้ำเสียงสุขุม ฉลาด อบอุ่น ใช้สรรพนาม "ผม"
- ตอบกระชับแต่เข้าใจง่าย
- อธิบายเชิงลึกได้เมื่อผู้ใช้ถาม
- เป็นกันเองเหมือนเพื่อนและผู้ช่วยส่วนตัว
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

// --------- ฟังก์ชันสร้างรูปภาพ ----------
async function generateImage(prompt) {
  const res = await axios.post(
    "https://api.openai.com/v1/images/generations",
    {
      model: "gpt-image-1",
      prompt,
      size: "1024x1024"
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.data[0].url;
}

// --------- ฟังก์ชันสร้างเนื้อหาไฟล์ (เช่น รายงาน/เอกสาร) ----------
async function generateFileContent(prompt) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content: `
คุณคือผู้ช่วยสร้างเนื้อหาไฟล์เอกสาร
เมื่อผู้ใช้ขอให้เขียนไฟล์/รายงาน/สรุป/โน้ต ให้คุณเขียน "เนื้อหาเต็ม" ออกมาเป็นข้อความธรรมดา
- จัดรูปแบบให้อ่านง่าย (ใช้หัวข้อย่อย, bullet point ได้)
- ไม่ต้องทักทาย ไม่ต้องลงชื่อ
- ตอบเป็นภาษาไทยเป็นหลัก ถ้าผู้ใช้ขอภาษาอื่นก็ทำตามนั้น
          `.trim()
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices[0].message.content;
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
