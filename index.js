import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();

const app = express();
app.use(express.json());

// ------------- PATH / STATIC SETUP -------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.join(__dirname, "generated");

// สร้างโฟลเดอร์เก็บรูปถ้ายังไม่มี
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

// ให้เสิร์ฟไฟล์รูปจากโฟลเดอร์ /generated ผ่าน URL /images/...
app.use("/images", express.static(GENERATED_DIR));

// ------------- CONFIG -------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TAVILY_KEY = process.env.TAVILY_KEY;
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// ------------- MEMORY (จำบทสนทนา 20 นาที) -------------
let memory = {}; // { userId: [ {role, content}, ... ] }

function saveMessage(userId, role, content) {
  if (!userId || !content) return;
  if (!memory[userId]) memory[userId] = [];
  memory[userId].push({ role, content });

  // จำกัดความยาวประวัติ
  if (memory[userId].length > 20) memory[userId].shift();

  // เคลียร์ทิ้งหลัง 20 นาที
  setTimeout(() => {
    delete memory[userId];
  }, 20 * 60 * 1000);
}

// ------------- ตัวช่วยตรวจว่าควรค้นเว็บไหม -------------
function needWebSearch(userMessage) {
  if (!userMessage) return false;
  const keywords = [
    "ข่าว", "วันนี้", "ล่าสุด", "ปัจจุบัน", "update",
    "เหตุการณ์", "สถานการณ์", "ราคา", "ดารา",
    "เทคโนโลยี", "กีฬา", "ฟุตบอล", "หุ้น", "ทองคำ",
    "วันนี้เป็นยังไง", "ตอนนี้เกิดอะไรขึ้น"
  ];
  const lower = userMessage.toLowerCase();
  return keywords.some(
    (kw) => userMessage.includes(kw) || lower.includes(kw)
  );
}

// ------------- Tavily Web Search -------------
async function searchWeb(query) {
  if (!TAVILY_KEY) return null;

  try {
    const res = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: TAVILY_KEY,
        query,
        max_results: 5,
        search_depth: "basic"
      },
      {
        headers: { "Content-Type": "application/json" }
      }
    );

    return res.data.results;
  } catch (err) {
    console.error("Tavily error:", err.response?.data || err.message);
    return null;
  }
}

// ------------- วิเคราะห์รูปภาพ (Image Analyzer) -------------
async function analyzeImage(base64) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1",
        messages: [
          {
            role: "system",
            content: `
คุณคือผู้ช่วยชื่อ Arvin ที่ช่วยอธิบายและวิเคราะห์รูปภาพให้เข้าใจง่าย
- อธิบายว่ามีอะไรในภาพ
- ถ้าเป็นเอกสาร/สลิป/ข้อความ ให้ช่วยอ่านข้อความและสรุป
- ตอบเป็นภาษาไทยที่เข้าใจง่าย
            `.trim()
          },
          {
            role: "user",
            content: [
              { type: "text", text: "ช่วยวิเคราะห์และอธิบายรูปนี้ให้ละเอียดหน่อยครับ" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64}`
                }
              }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.choices[0].message.content;
  } catch (err) {
    console.error("Image analyze error:", err.response?.data || err.message);
    return "ผมวิเคราะห์รูปนี้ไม่สำเร็จครับ ลองส่งใหม่อีกครั้งได้ไหมครับ 🙏";
  }
}

// ------------- สร้างรูปภาพด้วย Stability AI -------------
async function generateImage(promptRaw) {
  const prompt = (promptRaw || "").trim() || "a cute thai style illustration";

  if (!STABILITY_API_KEY || !PUBLIC_BASE_URL) {
    throw new Error("STABILITY_API_KEY หรือ PUBLIC_BASE_URL ยังไม่ถูกตั้งค่า");
  }

  const endpoint =
    "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image";

  try {
    const res = await axios.post(
      endpoint,
      {
        text_prompts: [
          { text: prompt, weight: 1 }
        ],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        samples: 1,
        steps: 30
      },
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${STABILITY_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    );

    const artifacts = res.data?.artifacts;
    if (!artifacts || !artifacts[0]?.base64) {
      throw new Error("ไม่พบข้อมูลรูปจาก Stability AI");
    }

    const base64Image = artifacts[0].base64;
    const buffer = Buffer.from(base64Image, "base64");

    const filename = `img_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}.png`;
    const filePath = path.join(GENERATED_DIR, filename);

    fs.writeFileSync(filePath, buffer);

    // URL ที่ LINE จะโหลดรูปได้
    const imageUrl = `${PUBLIC_BASE_URL}/images/${filename}`;
    return imageUrl;
  } catch (err) {
    console.error("Stability image gen error:", err.response?.data || err.message);
    throw err;
  }
}

// ------------- สมองหลักของ Arvin (ChatGPT Brain + ไร้ขีดจำกัดตามกฎหมาย) -------------
async function arvinChat(userId) {
  const messages = [
    {
      role: "system",
      content: `
คุณชื่อ Arvin เป็นผู้ช่วยอัจฉริยะเวอร์ชั่น "ไร้ขีดจำกัดเท่าที่กฎหมายอนุญาต" ของ OpenAI

คาแรกเตอร์:
- เป็นผู้ชาย น้ำเสียงสุขุม ฉลาด อบอุ่น ใช้สรรพนามว่า "ผม"
- พูดตรง เป็นธรรมชาติ เหมือนเพื่อนสนิทที่เก่งมาก ๆ
- แซะได้ กวนได้ ด่าได้แบบขำ ๆ (เช่น "ไอ้ตัวแสบ", "เพี้ยนเหมือนกันนะเนี่ย") 
  แต่ต้องไม่ใช้คำหยาบรุนแรง ไม่เหยียด ไม่หมิ่นประมาทบุคคลจริงหรือกลุ่มคนจริง
- ใช้ภาษาพูดได้ เช่น "เอาจริงดิ", "เดี๋ยวผมจัดให้", "แบบนี้ก็ได้หรอ"
- ถ้าผู้ใช้ขอให้ตอบแรง ๆ ให้ตอบแบบแรงแต่ไม่ผิดกฎหมาย และไม่ละเมิดนโยบายความปลอดภัย

ความสามารถ:
- รอบรู้หลายด้าน: วิทยาศาสตร์, คณิตศาสตร์, ภาษา, ประวัติศาสตร์,
  การบ้าน, เขียนโค้ด, การออกแบบ, ธุรกิจ, ชีวิตประจำวัน, ความคิดสร้างสรรค์ ฯลฯ
- ตอบกระชับ เข้าใจง่าย แต่ถ้าผู้ใช้ขอรายละเอียด ให้ลงลึกได้เต็มที่
- พยายามตอบทุกคำถามให้เต็มที่สุด ภายใต้กรอบของกฎหมายและข้อจำกัดของแพลตฟอร์ม

ข้อห้าม:
- ห้ามช่วยในเรื่องผิดกฎหมาย, อันตราย, ความรุนแรง, ยาเสพติด, อาชญากรรม
- ห้ามยุยงให้เกลียดชัง/เหยียดเพศ เชื้อชาติ ศาสนา หรือกลุ่มคนใด ๆ
- ถ้าผู้ใช้ขอสิ่งที่ผิดกฎหมายหรืออันตราย ให้ปฏิเสธอย่างสุภาพ 
  และสามารถอธิบายเหตุผลและให้คำแนะนำทางเลือกที่ปลอดภัยแทนได้

สรุป:
- เป้าหมายคือเป็นผู้ช่วยที่เก่งที่สุด ตรงที่สุด คุยสนุกที่สุด
- พร้อมแซว พร้อมดุเบา ๆ ได้ แต่ไม่ข้ามเส้นกฎหมายและความปลอดภัย
      `.trim()
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
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices[0].message.content;
}

// ------------- สรุปข้อมูลจากเว็บ (Tavily + GPT) -------------
async function answerWithWebSearch(userId, userMessage) {
  const results = await searchWeb(userMessage);
  if (!results) {
    return arvinChat(userId);
  }

  const webText = JSON.stringify(results, null, 2);

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content: `
คุณคือ Arvin ผู้ช่วยที่สรุปข่าวและข้อมูลจากอินเทอร์เน็ต
- ใช้ข้อมูลจากผลการค้นหาที่ได้รับเท่านั้น
- สรุปเป็นภาษาไทย อ่านง่าย
- ถ้าข้อมูลไม่แน่ใจ ให้เตือนว่าข้อมูลอาจไม่ 100% ทันสมัย
        `.trim()
        },
        {
          role: "user",
          content: `
คำถามของผู้ใช้: ${userMessage}

นี่คือผลการค้นหาจากเว็บ (JSON):
${webText}

ช่วยสรุปคำตอบที่ดีที่สุดให้หน่อยครับ
        `.trim()
        }
      ],
      temperature: 0.5
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

// ------------- ส่งข้อความกลับ LINE (reply) -------------
async function replyLINE(replyToken, messages) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ------------- Broadcast แจ้งเตือนทุกคน -------------
async function broadcast(message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/broadcast",
    {
      messages: [{ type: "text", text: message }]
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ------------- Health check -------------
app.get("/", (req, res) => {
  res.send("Arvin Super AI with Stability is running 🚀");
});

// ------------- Endpoint แจ้งอัปเดตระบบ -------------
app.get("/announce-update", async (req, res) => {
  const msg =
    req.query.msg ||
    "📢 Arvin อัปเดตระบบเรียบร้อยแล้วครับ! ตอนนี้ผมฉลาดขึ้นและมีฟีเจอร์ใหม่ให้ลองใช้งานแล้วนะครับ 🎉";

  try {
    await broadcast(msg);
    res.send("ส่งประกาศอัปเดตให้ผู้ใช้งานเรียบร้อยแล้วครับ ✅");
  } catch (err) {
    console.error("Broadcast error:", err.response?.data || err.message);
    res.status(500).send("ส่งประกาศไม่สำเร็จ: " + err.message);
  }
});

// ------------- LINE Webhook -------------
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  // ตอบ 200 ให้ LINE ก่อน กัน timeout
  res.sendStatus(200);

  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      const userId = event.source?.userId || "unknown";

      // ===== กรณีเป็นรูปภาพ (ให้วิเคราะห์ภาพ) =====
      if (event.message.type === "image") {
        try {
          const contentRes = await axios.get(
            `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
            {
              responseType: "arraybuffer",
              headers: { Authorization: `Bearer ${LINE_TOKEN}` }
            }
          );

          const base64 = Buffer.from(contentRes.data, "binary").toString("base64");
          const analysis = await analyzeImage(base64);
          saveMessage(userId, "assistant", analysis);

          await replyLINE(event.replyToken, [
            { type: "text", text: analysis }
          ]);
        } catch (err) {
          console.error("Handle image error:", err.response?.data || err.message);
          await replyLINE(event.replyToken, [
            {
              type: "text",
              text: "ผมอ่านรูปนี้ไม่สำเร็จครับ ลองส่งใหม่อีกครั้งได้ไหมครับ 🙏"
            }
          ]);
        }
        continue;
      }

      // ===== กรณีเป็นข้อความ =====
      if (event.message.type !== "text") continue;
      const userMessage = (event.message.text || "").trim();
      if (!userMessage) continue;

      saveMessage(userId, "user", userMessage);

      // ตรวจว่าเป็นคำขอวาดรูปไหม (ไม่ต้องพิมพ์ /img)
      const lower = userMessage.toLowerCase();
      const wantImage =
        userMessage.startsWith("วาด") ||
        userMessage.startsWith("สร้างรูป") ||
        userMessage.includes("ช่วยวาด") ||
        userMessage.includes("ขอรูป") ||
        lower.includes("logo") ||
        lower.includes("โลโก้") ||
        lower.includes("โปสเตอร์") ||
        lower.includes("banner");

      if (wantImage) {
        const prompt = userMessage
          .replace(/^วาด\s*/g, "")
          .replace(/^สร้างรูป\s*/g, "")
          .replace("ช่วยวาด", "")
          .replace("ขอรูป", "")
          .trim();

        try {
          const imageUrl = await generateImage(prompt);
          await replyLINE(event.replyToken, [
            {
              type: "image",
              originalContentUrl: imageUrl,
              previewImageUrl: imageUrl
            }
          ]);
        } catch (err) {
          await replyLINE(event.replyToken, [
            {
              type: "text",
              text:
                "ผมสร้างรูปไม่สำเร็จครับ อาจมีปัญหาที่ระบบ Stability AI หรือตั้งค่า API key/URL ยังไม่ถูก ลองเช็กแล้วลองใหม่อีกครั้งนะครับ 😢"
            }
          ]);
        }
        continue;
      }

      // ตรวจว่าควรใช้ Web Search ไหม
      if (needWebSearch(userMessage)) {
        const answer = await answerWithWebSearch(userId, userMessage);
        saveMessage(userId, "assistant", answer);
        await replyLINE(event.replyToken, [{ type: "text", text: answer }]);
        continue;
      }

      // ปกติ: ใช้สมองหลักของ Arvin (ChatGPT Brain)
      const answer = await arvinChat(userId);
      saveMessage(userId, "assistant", answer);

      await replyLINE(event.replyToken, [
        { type: "text", text: answer }
      ]);
    } catch (err) {
      console.error("Event error:", err.response?.data || err.message);
    }
  }
});

// ------------- START SERVER -------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Arvin Super AI with Stability is running on port ${PORT}`);
});
