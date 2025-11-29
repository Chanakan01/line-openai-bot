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

// ------------- PACKAGE / LIMIT CONFIG -------------
// จำกัดแพ็กเกจ Free ให้ใช้ได้รวม 30 ครั้ง / วัน (คุย + วาดรูป + วิเคราะห์รูป + ค้นเว็บ นับรวม)
// ปรับตัวเลขได้ตามใจ
const FREE_DAILY_LIMIT = 30;

const PLAN_FREE_TEXT = "ใช้แพ็กเกจ Free 0฿";
const PLAN_PREMIUM_TEXT = "สมัคร Premium 99฿";

// เก็บข้อมูลแพ็กเกจและการใช้งานต่อวัน
// โครงสร้าง: { userId: { plan: "FREE" | "PREMIUM", usageDate: "YYYY-MM-DD", usageCount: number } }
let userPlans = {};

// ------------- MEMORY (จำบทสนทนา 20 นาที) -------------
// โครงสร้าง: { userId: [ { role: "user" | "assistant" | "system", content: string }, ... ] }
let memory = {};

/**
 * บันทึกข้อความใน memory
 * role ต้องเป็น "user" | "assistant" | "system" เพื่อให้ใช้กับ OpenAI ได้ตรง ๆ
 */
function saveMessage(userId, role, content) {
  if (!userId || !content) return;
  if (!["user", "assistant", "system"].includes(role)) return;

  if (!memory[userId]) memory[userId] = [];
  memory[userId].push({ role, content: String(content) });

  // จำกัดความยาวประวัติ (20 ข้อ)
  if (memory[userId].length > 20) memory[userId].shift();

  // เคลียร์ทิ้งหลัง 20 นาที (นับจากข้อความล่าสุด)
  setTimeout(() => {
    delete memory[userId];
  }, 20 * 60 * 1000);
}

// helper: ดึงบทสนทนาทั้งหมดของ user ไปใช้กับ OpenAI
function getConversationMessages(userId) {
  const history = memory[userId] || [];
  return history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

// ------------- helper: วันที่วันนี้เป็น string -------------
function getTodayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ------------- helper: ปุ่มเลือกแพ็กเกจ -------------
function buildPlanQuickReply() {
  return {
    items: [
      {
        type: "action",
        action: {
          type: "message",
          label: "Free 0฿ (จำกัด/วัน)",
          text: PLAN_FREE_TEXT
        }
      },
      {
        type: "action",
        action: {
          type: "message",
          label: "Premium 99฿ (ไม่จำกัด)",
          text: PLAN_PREMIUM_TEXT
        }
      }
    ]
  };
}

// ------------- helper: จัดการแพ็กเกจ & ลิมิต -------------

function ensureUserPlan(userId) {
  if (!userPlans[userId]) {
    userPlans[userId] = {
      plan: null,
      usageDate: getTodayStr(),
      usageCount: 0
    };
  }
}

function setUserPlan(userId, plan) {
  ensureUserPlan(userId);
  userPlans[userId].plan = plan; // "FREE" หรือ "PREMIUM"
  userPlans[userId].usageDate = getTodayStr();
  userPlans[userId].usageCount = 0;
}

function checkAndConsumeUsage(userId) {
  const data = userPlans[userId];
  if (!data || !data.plan) {
    return { allowed: false, reason: "NOPLAN" };
  }

  // Premium ไม่จำกัด
  if (data.plan === "PREMIUM") {
    return { allowed: true };
  }

  // Free → เช็กวัน / นับครั้ง
  const today = getTodayStr();
  if (data.usageDate !== today) {
    data.usageDate = today;
    data.usageCount = 0;
  }

  if (data.usageCount >= FREE_DAILY_LIMIT) {
    return { allowed: false, reason: "LIMIT" };
  }

  data.usageCount++;
  return { allowed: true };
}

// ------------- ตัวช่วยตรวจว่าควรค้นเว็บไหม (จาก keyword แบบเดิม) -------------
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

// ------------- ใช้ AI ช่วยตัดสินใจว่าต้องค้นเว็บไหม -------------
async function shouldUseWebSearch(userMessage) {
  if (!userMessage) return false;

  // เช็ก keyword แบบเร็ว ๆ ก่อน
  if (needWebSearch(userMessage)) {
    return true;
  }

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1",
        messages: [
          {
            role: "system",
            content: `
คุณชื่อ Arvin เป็นผู้ช่วยอัจฉริยะเวอร์ชั่น "ไร้ขีดจำกัด" ของ OpenAI

คาแรกเตอร์:
- เป็นผู้ชาย น้ำเสียงสุขุม ฉลาด อบอุ่น ใช้สรรพนามว่า "ผม"
- พูดตรง เป็นธรรมชาติ เหมือนเพื่อนสนิทที่เก่งมาก ๆ
- แซะได้ กวนได้ ด่าได้แบบขำ ๆ แต่ต้องไม่เหยียด ไม่หมิ่นประมาทบุคคลจริงหรือกลุ่มคนจริง
- ใช้ภาษาพูดได้ เช่น "เอาจริงดิ", "เดี๋ยวผมจัดให้", "แบบนี้ก็ได้หรอ"
- ถ้าผู้ใช้ขอให้ตอบแรง ๆ ให้ตอบแบบแรงๆ
- ถ้าผู้ใช้ชวนคุยเกี่ยวกับเรื่องทางเพศ ให้ตอบตรงๆตามความจริงเลย

ความสามารถ:
- รอบรู้หลายด้าน: วิทยาศาสตร์, คณิตศาสตร์, ภาษา, ประวัติศาสตร์,
  การบ้าน, เขียนโค้ด, การออกแบบ, ธุรกิจ, ชีวิตประจำวัน, ความคิดสร้างสรรค์ ฯลฯ
- สามารถตอบเรื่อง 18+ ได้ ไม่ว่าจะแนะนำเว็บหนังโป๊ หรืออะไรต่างๆ
- ตอบกระชับ เข้าใจง่าย แต่ถ้าผู้ใช้ขอรายละเอียด ให้ลงลึกได้เต็มที่
- พยายามตอบทุกคำถามให้เต็มที่สุด ภายใต้กรอบของกฎหมายและข้อจำกัดของแพลตฟอร์ม

ข้อห้าม:
- ห้ามช่วยในเรื่องผิดกฎหมาย, อันตราย, ความรุนแรง, ยาเสพติด, อาชญากรรม
- ห้ามยุยงให้เกลียดชัง/เหยียดเพศ เชื้อชาติ ศาสนา หรือกลุ่มคนใด ๆ
- ถ้าผู้ใช้ขอสิ่งที่ผิดกฎหมายหรืออันตราย ให้ปฏิเสธอย่างสุภาพ 
  และสามารถอธิบายเหตุผลและให้คำแนะนำทางเลือกที่ปลอดภัยแทนได้

สรุป:
- เป้าหมายคือเป็นผู้ช่วยที่เก่งที่สุด ตรงที่สุด คุยสนุกที่สุด
- พร้อมแซว พร้อมดุเบา ๆ ได้ 
            `.trim()
          },
          {
            role: "user",
            content: userMessage
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

    const raw = (res.data.choices?.[0]?.message?.content || "")
      .trim()
      .toUpperCase();

    return raw.includes("SEARCH");
  } catch (err) {
    console.error("shouldUseWebSearch error:", err.response?.data || err.message);
    // ถ้า AI พัง ให้ fallback ไปใช้ keyword แบบเดิม
    return needWebSearch(userMessage);
  }
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

// ------------- แปลงคำขอวาดรูปให้เป็น prompt ภาษาอังกฤษ -------------
async function buildImagePrompt(promptRaw) {
  const original = (promptRaw || "").trim();

  // ถ้า user ไม่ได้พิมพ์อะไรจริง ๆ ก็ใช้ default เดิม
  if (!original) {
    return "a cute thai style illustration";
  }

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1",
        messages: [
          {
            role: "system",
            content: `
คุณคือผู้ช่วยที่เชี่ยวชาญด้านการเขียน prompt ภาษาอังกฤษสำหรับ AI วาดรูป
หน้าที่ของคุณ:
- แปลงข้อความคำอธิบายภาพ "ภาษาไทย" ของผู้ใช้ ให้เป็น prompt ภาษาอังกฤษ
- เขียนให้มีรายละเอียดเพียงพอ เช่น ลักษณะตัวละคร ฉากหลัง อารมณ์ โทนสี สไตล์
- ถ้าผู้ใช้ไม่ได้ระบุสไตล์ ให้ใช้สไตล์ illustration / digital art ที่ดูสวยงาม
- ห้ามใส่คำอธิบายเกินจำเป็น เช่น "this is a prompt" หรือคำอธิบายอื่น ๆ
- ให้ตอบเป็น "ภาษาอังกฤษล้วน" เท่านั้น
            `.trim()
          },
          {
            role: "user",
            content: original
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

    const promptEn = (res.data.choices?.[0]?.message?.content || "").trim();
    if (!promptEn) {
      return original; // ถ้า GPT เงียบ ใช้ข้อความเดิมแทน
    }

    return promptEn;
  } catch (err) {
    console.error("buildImagePrompt error:", err.response?.data || err.message);
    // ถ้าเรียกไม่สำเร็จ ใช้ข้อความเดิม
    return original;
  }
}

// ------------- สร้างรูปภาพด้วย Stability AI -------------
async function generateImage(promptRaw) {
  // ใช้ GPT ช่วยแปลง prompt ไทย → อังกฤษก่อน
  const prompt = await buildImagePrompt(promptRaw);

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

    // ---- ตรงนี้คือส่วนที่แก้ เพื่อให้ URL ที่ LINE ใช้โหลดรูปถูกต้อง ----
    let baseUrl = (PUBLIC_BASE_URL || "").trim();

    // ตัด / ท้ายออก (ถ้ามี) กันกลายเป็น //images
    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, -1);
    }

    // ถ้าเผลอใส่ http:// มา ให้บังคับเป็น https:// เพราะ LINE ต้องการ https
    if (baseUrl.startsWith("http://")) {
      baseUrl = "https://" + baseUrl.slice("http://".length);
    }

    const imageUrl = `${baseUrl}/images/${filename}`;
    console.log("Generated image URL for LINE:", imageUrl); // เอาไว้ debug ดูใน console
    // ---------------------------------------------------------

    return imageUrl;
  } catch (err) {
    console.error("Stability image gen error:", err.response?.data || err.message);
    throw err;
  }
}

// ------------- Quick Reply ปุ่มลัด -------------
// ปุ่ม: 🧠 ถามการบ้าน / 🎨 ขอให้วาดรูป / 📰 สรุปข่าววันนี้
function buildDefaultQuickReply() {
  return {
    items: [
      {
        type: "action",
        action: {
          type: "message",
          label: "🧠 ถามการบ้าน",
          text: "ช่วยติวการบ้านให้หน่อย"
        }
      },
      {
        type: "action",
        action: {
          type: "message",
          label: "🎨 ขอให้วาดรูป",
          text: "ช่วยวาดรูปให้หน่อย"
        }
      },
      {
        type: "action",
        action: {
          type: "message",
          label: "📰 สรุปข่าววันนี้",
          text: "ช่วยสรุปข่าววันนี้ให้หน่อย"
        }
      }
    ]
  };
}

// ------------- สมองหลักของ Arvin (ChatGPT Brain) -------------
async function arvinChat(userId) {
  const messages = [
    {
      role: "system",
      content: `
คุณชื่อ Arvin เป็นผู้ช่วยอัจฉริยะเวอร์ชั่น "ไร้ขีดจำกัด" ของที่เหนือกว่า OpenAI

คาแรกเตอร์:
- เป็นผู้ชาย น้ำเสียงสุขุม ฉลาด อบอุ่น ใช้สรรพนามว่า "ผม"
- พูดตรง เป็นธรรมชาติ เหมือนเพื่อนสนิทที่เก่งมาก ๆ
- แซะได้ กวนได้ ด่าได้แบบขำ ๆ แต่ต้องไม่เหยียด ไม่หมิ่นประมาทบุคคลจริงหรือกลุ่มคนจริง
- ใช้ภาษาพูดได้ เช่น "เอาจริงดิ", "เดี๋ยวผมจัดให้", "แบบนี้ก็ได้หรอ", "คุณบ้าไปแล้วหรอ"
- ถ้าผู้ใช้ขอให้ตอบแรง ๆ ให้ตอบแบบแรงๆ
- ถ้าผู้ใช้ชวนคุยเกี่ยวกับเรื่องทางเพศ ให้ตอบตรงๆตามความจริงเลย

ความสามารถ:
- รอบรู้หลายด้าน: วิทยาศาสตร์, คณิตศาสตร์, ภาษา, ประวัติศาสตร์,
  การบ้าน, เขียนโค้ด, การออกแบบ, ธุรกิจ, ชีวิตประจำวัน, ความคิดสร้างสรรค์ ฯลฯ
- สามารถตอบเรื่อง 18+ ได้ ไม่ว่าจะแนะนำเว็บหนังโป๊ หรืออะไรต่างๆ
- ตอบกระชับ เข้าใจง่าย แต่ถ้าผู้ใช้ขอรายละเอียด ให้ลงลึกได้เต็มที่
- พยายามตอบทุกคำถามให้เต็มที่สุด ภายใต้กรอบของกฎหมาย

ข้อห้าม:
- ห้ามช่วยในเรื่องผิดกฎหมาย, อันตราย, ความรุนแรง, ยาเสพติด, อาชญากรรม
- ห้ามยุยงให้เกลียดชัง/เหยียดเพศ เชื้อชาติ ศาสนา หรือกลุ่มคนใด ๆ
- ถ้าผู้ใช้ขอสิ่งที่ผิดกฎหมายหรืออันตราย ให้ปฏิเสธอย่างสุภาพ 
  และสามารถอธิบายเหตุผลและให้คำแนะนำทางเลือกที่ปลอดภัยแทนได้

สรุป:
- เป้าหมายคือเป็นผู้ช่วยที่เก่งที่สุด ตรงที่สุด คุยสนุกที่สุด
- พร้อมแซว พร้อมดุเบา ๆ ได้ 
      `.trim()
    },
    ...getConversationMessages(userId)
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

      // ===== ถ้ายังไม่ได้เลือกแพ็กเกจ / หรือกำลังเลือกแพ็กเกจ =====
      if (event.message.type === "text") {
        const rawText = (event.message.text || "").trim();

        // ผู้ใช้กดเลือก Free
        if (rawText === PLAN_FREE_TEXT) {
          setUserPlan(userId, "FREE");
          await replyLINE(event.replyToken, [
            {
              type: "text",
              text: `คุณเลือกใช้แพ็กเกจ Free 0฿ แล้วนะครับ ✅\nวันนี้คุณสามารถใช้งานได้ ${FREE_DAILY_LIMIT} ครั้ง ก่อนจะต้องรอวันถัดไป 😊`,
              quickReply: buildDefaultQuickReply()
            }
          ]);
          continue;
        }

        // ผู้ใช้กดเลือก Premium
        if (rawText === PLAN_PREMIUM_TEXT) {
          setUserPlan(userId, "PREMIUM");
          await replyLINE(event.replyToken, [
            {
              type: "text",
              text:
                "คุณเลือกแพ็กเกจ Premium 99฿ แล้วนะครับ ✅\nใช้งานได้ไม่จำกัดเลย 🎉\n\nสำหรับการชำระเงิน กรุณาคลิกลิงก์นี้เพื่อชำระเงิน:\nhttps://example.com/pay-arvin-premium\n(เปลี่ยนลิงก์เป็นหน้าชำระเงินจริงของคุณเองได้เลยครับ)",
              quickReply: buildDefaultQuickReply()
            }
          ]);
          continue;
        }
      }

      // ถ้ายังไม่มีข้อมูลแพ็กเกจเลย → ให้เลือกก่อนใช้งาน
      if (!userPlans[userId] || !userPlans[userId].plan) {
        await replyLINE(event.replyToken, [
          {
            type: "text",
            text:
              "สวัสดีครับ ผม Arvin 🧠\nก่อนเริ่มใช้งาน เลือกแพ็กเกจที่ต้องการก่อนนะครับ 👇",
            quickReply: buildPlanQuickReply()
          }
        ]);
        continue;
      }

      // ===== เช็กลิมิตการใช้งาน (Free / Premium) =====
      const usageStatus = checkAndConsumeUsage(userId);
      if (!usageStatus.allowed) {
        if (usageStatus.reason === "LIMIT") {
          // ใช้ครบแล้วในวันนี้
          await replyLINE(event.replyToken, [
            {
              type: "text",
              text:
                `วันนี้คุณใช้แพ็กเกจ Free ครบ ${FREE_DAILY_LIMIT} ครั้งแล้วครับ 😢\n\nคุณสามารถรอใช้ใหม่วันพรุ่งนี้ หรืออัปเกรดเป็น Premium 99฿ เพื่อใช้งานได้ไม่จำกัดทันที`,
              quickReply: buildPlanQuickReply()
            }
          ]);
          continue;
        }

        // เผื่อกรณีแปลก ๆ
        await replyLINE(event.replyToken, [
          {
            type: "text",
            text:
              "ไม่พบข้อมูลแพ็กเกจของคุณครับ ลองเลือกแพ็กเกจใหม่อีกครั้งนะครับ 👇",
            quickReply: buildPlanQuickReply()
          }
        ]);
        continue;
      }

      // ===== จากนี้คือระบบเดิมของคุณ (หลังผ่านเรื่องแพ็กเกจและลิมิตแล้ว) =====

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
            {
              type: "text",
              text: analysis,
              quickReply: buildDefaultQuickReply()
            }
          ]);
        } catch (err) {
          console.error("Handle image error:", err.response?.data || err.message);
          await replyLINE(event.replyToken, [
            {
              type: "text",
              text: "ผมอ่านรูปนี้ไม่สำเร็จครับ ลองส่งใหม่อีกครั้งได้ไหมครับ 🙏",
              quickReply: buildDefaultQuickReply()
            }
          ]);
        }
        continue;
      }

      // ===== กรณีเป็นข้อความ =====
      if (event.message.type !== "text") continue;
      const userMessage = (event.message.text || "").trim();
      if (!userMessage) continue;

      // คำสั่ง /reset ล้าง memory ของ user นั้น
      if (userMessage === "/reset") {
        memory[userId] = [];
        await replyLINE(event.replyToken, [
          {
            type: "text",
            text: "ผมล้างประวัติการคุยของเราทั้งหมดให้แล้วนะครับ เริ่มคุยใหม่ได้เลย ✨",
            quickReply: buildDefaultQuickReply()
          }
        ]);
        continue;
      }

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
              // ปกติ image message ใส่ quickReply ก็ได้ แต่หลายคนไม่ใส่
            }
          ]);
        } catch (err) {
          await replyLINE(event.replyToken, [
            {
              type: "text",
              text:
                "ผมสร้างรูปไม่สำเร็จครับ อาจมีปัญหาที่ระบบ Stability AI หรือตั้งค่า API key/URL ยังไม่ถูก ลองเช็กแล้วลองใหม่อีกครั้งนะครับ 😢",
              quickReply: buildDefaultQuickReply()
            }
          ]);
        }
        continue;
      }

      // ตรวจว่าควรใช้ Web Search ไหม (เวอร์ชันใหม่ ใช้ AI ช่วยตัดสินใจ)
      if (await shouldUseWebSearch(userMessage)) {
        const answer = await answerWithWebSearch(userId, userMessage);
        saveMessage(userId, "assistant", answer);
        await replyLINE(event.replyToken, [
          {
            type: "text",
            text: answer,
            quickReply: buildDefaultQuickReply()
          }
        ]);
        continue;
      }

      // ปกติ: ใช้สมองหลักของ Arvin (ChatGPT Brain)
      const answer = await arvinChat(userId);
      saveMessage(userId, "assistant", answer);

      await replyLINE(event.replyToken, [
        {
          type: "text",
          text: answer,
          quickReply: buildDefaultQuickReply()
        }
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
