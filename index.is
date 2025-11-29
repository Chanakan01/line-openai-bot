import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ฟังก์ชันถาม OpenAI
async function askOpenAI(userText) {
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that always replies in Thai."
        },
        {
          role: "user",
          content: userText
        }
      ]
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    }
  );

  const aiReply =
    response.data.choices?.[0]?.message?.content?.trim() ||
    "ขออภัยค่ะ ตอนนี้ระบบไม่สามารถตอบได้";

  return aiReply;
}

// Webhook LINE
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];

  res.status(200).send("OK"); // ตอบกลับทันที กัน timeout

  for (const event of events) {
    try {
      if (event.type !== "message" || event.message.type !== "text") {
        continue;
      }

      const replyToken = event.replyToken;
      const userText = event.message.text;

      const aiReply = await askOpenAI(userText);

      await axios.post(
        "https://api.line.me/v2/bot/message/reply",
        {
          replyToken,
          messages: [
            {
              type: "text",
              text: aiReply
            }
          ]
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
          }
        }
      );
    } catch (err) {
      console.error("Error:", err.response?.data || err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});
