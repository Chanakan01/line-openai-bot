import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// health check
app.get("/", (req, res) => {
  res.send("LINE OpenAI Bot is running!");
});

// Webhook จาก LINE (ต้องเป็น POST)
app.post("/webhook", async (req, res) => {
  console.log("Received webhook:", JSON.stringify(req.body, null, 2));

  const events = req.body.events;

  // ตอบ 200 ให้ LINE ทันที กัน timeout
  res.sendStatus(200);

  if (!events || events.length === 0) return;

  for (const event of events) {
    try {
      if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text.trim();
        const replyToken = event.replyToken;

        console.log("User message:", userMessage);

        // ถ้าขึ้นต้นด้วย "รูป" หรือ "/img" -> สร้างรูปภาพ
        if (
          userMessage.startsWith("รูป ") ||
          userMessage.startsWith("รูป:") ||
          userMessage.toLowerCase().startsWith("/img ")
        ) {
          const prompt =
            userMessage.startsWith("รูป") ?
            userMessage.replace(/^รูป[:\s]+/i, "") :
            userMessage.replace(/^\/img\s+/i, "");

          const imageUrl = await generateImage(prompt || "a cute cat in thai style");

          console.log("Image URL:", imageUrl);

          await replyImageToLine(replyToken, imageUrl);
        } else {
          // กรณีข้อความปกติ -> คุยกับบอทผู้ชาย
          const aiResponse = await callOpenAI(userMessage);
          console.log("AI reply:", aiResponse);

          await replyTextToLine(replyToken, aiResponse);
        }
      }
    } catch (err) {
      console.error("Error handling event:", err.response?.data || err);
    }
  }
});

// ฟังก์ชันเรียก OpenAI (ข้อความ)
// บอทผู้ชาย เป็นกันเอง ใช้ "ผม"
async function callOpenAI(text) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: `
You are a friendly Thai male assistant.
- พูดจาเป็นกันเอง สุภาพแบบผู้ชาย ใช้สรรพนาม "ผม"
- ตอบแบบมีชีวิตชีวา ใส่อีโมจิได้บ้าง เช่น 😄✨🔥 แต่ไม่เยอะเกินไป
- อธิบายให้เข้าใจง่าย ถ้าผู้ใช้ถามสั้น ตอบสั้นได้
- ถ้าผู้ใช้ถามเรื่องเทคนิค ให้ตอบเป็นขั้น ๆ
- ห้ามบอกว่าคุณเป็นผู้หญิง หรือเป็น AI ให้ยืนยันภาพลักษณ์ว่าเป็นผู้ช่วยผู้ชาย
          `.trim()
          },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err);
    return "ขอโทษครับ ตอนนี้ระบบ AI มีปัญหาชั่วคราว ผมตอบไม่ได้แป๊บหนึ่งนะครับ 😢";
  }
}

// ฟังก์ชันสร้างรูปภาพด้วย OpenAI Image
async function generateImage(prompt) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/images/generations",
      {
        model: "gpt-image-1",
        prompt: prompt,
        size: "1024x1024"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const imageUrl = response.data.data[0].url;
    return imageUrl;
  } catch (err) {
    console.error("OpenAI image error:", err.response?.data || err);
    // ถ้าสร้างรูปไม่ได้ ให้ใช้รูป fallback (หรือจะตอบเป็นข้อความแทนก็ได้)
    throw new Error("IMAGE_GENERATION_FAILED");
  }
}

// ส่งข้อความตัวหนังสือกลับ LINE
async function replyTextToLine(replyToken, text) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken,
        messages: [{ type: "text", text }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("LINE text reply error:", error.response?.data || error);
  }
}

// ส่งรูปภาพกลับ LINE
async function replyImageToLine(replyToken, imageUrl) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken,
        messages: [
          {
            type: "image",
            originalContentUrl: imageUrl,
            previewImageUrl: imageUrl
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("LINE image reply error:", error.response?.data || error);
    // ถ้าเกิด error ตอนส่งรูป ให้ส่งข้อความแทน
    await replyTextToLine(
      replyToken,
      "ขอโทษครับ ผมส่งรูปไม่ได้ ลองใหม่อีกทีนะครับ 😢"
    );
  }
}

// ใช้ PORT จาก Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
