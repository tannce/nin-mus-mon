/**
 * Nintendo Museum ticket watcher -> Telegram
 * Cloudflare Worker + Cron Trigger (ทุกนาที) + Durable Object (เก็บ state)
 * แจ้งเตือนเฉพาะ 🟢 ว่าง และ 🔴 หายไป (รายละเอียดใน core.js)
 *
 * ใช้ Durable Object แทน KV เพราะ
 *   - KV เป็น eventually consistent: รันทุกนาทีอาจอ่าน state เก่า -> แจ้ง "ว่าง"/"หายไป" ซ้ำ
 *   - Durable Object รันทีละรอบตามลำดับ (ไม่ทับกัน) และอ่านค่าล่าสุดเสมอ
 *
 * Bindings: WATCHER (Durable Object), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RUN_KEY (secrets)
 *
 * Telegram webhook: POST /telegram (ตรวจ header X-Telegram-Bot-Api-Secret-Token = RUN_KEY)
 *   /check   ดูวันว่าง ณ ตอนนี้
 *   /help    วิธีใช้
 *   ตอบเฉพาะแชตที่ตรงกับ TELEGRAM_CHAT_ID
 *
 * HTTP endpoints (ต้องมี ?key=RUN_KEY):
 *   /run              รันตรวจทันที เหมือนรอบของ cron (ส่งเฉพาะเมื่อมีวันว่าง/หายไป)
 *   /run?dry=1        ดึงข้อมูลจริงแล้วแสดงสถานะปัจจุบัน ไม่ส่ง Telegram ไม่บันทึก state
 *   /test             ส่งข้อความทดสอบเข้า Telegram
 *   /reset            ล้าง state (รอบถัดไปจะแจ้ง "ว่าง" ทุกวันที่ว่างอยู่ตอนนั้น)
 */
import { DurableObject } from "cloudflare:workers";
import { runCheck, checkNow, notify, telegramReady } from "./core.js";

export class Watcher extends DurableObject {
  async run(opts) {
    if (this.running) return "skip: รอบก่อนหน้ายังทำงานไม่เสร็จ";
    this.running = true;
    try {
      return await runCheck(this.env, this.ctx.storage, opts);
    } finally {
      this.running = false;
    }
  }

  async check() {
    return await checkNow(this.ctx.storage);
  }

  async reset() {
    await this.ctx.storage.deleteAll();
    return "ล้าง state แล้ว";
  }
}

const watcher = (env) => env.WATCHER.get(env.WATCHER.idFromName("main"));

const HELP_TEXT =
  "🎮 บอทเฝ้าบัตร Nintendo Museum\n\n" +
  "บอทตรวจปฏิทินทุกนาที และแจ้งเมื่อมีวันว่างใหม่ 🟢 หรือวันที่ว่างหายไป 🔴\n\n" +
  "คำสั่ง:\n/check — ดูวันว่าง ณ ตอนนี้";

async function handleTelegram(request, env) {
  // ยืนยันว่า request มาจาก Telegram จริง (secret_token ที่ตั้งตอน setWebhook)
  if (!env.RUN_KEY || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.RUN_KEY) {
    // ตอบ 401 (ไม่ใช่ 404) เพื่อให้ getWebhookInfo แยกออกว่าเป็นเพราะ secret_token ไม่ตรง
    console.warn("telegram webhook: secret_token ไม่ตรงกับ RUN_KEY (setWebhook ใหม่ด้วย secret_token=<RUN_KEY>)");
    return new Response("Unauthorized", { status: 401 });
  }
  const update = await request.json().catch(() => ({}));
  const msg = update.message;
  // ตอบเฉพาะแชตของเรา คนอื่นที่เจอบอทจะสั่งอะไรไม่ได้
  if (!msg?.text || String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok");

  const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();   // รองรับ /check@ชื่อบอท ในกลุ่ม
  try {
    if (cmd === "/check") await notify(env, await watcher(env).check());
    else if (cmd === "/start" || cmd === "/help") await notify(env, HELP_TEXT);
  } catch (e) {
    console.error(`telegram command ${cmd} failed: ${e.message}`);
  }
  // ตอบ 200 เสมอ ไม่อย่างนั้น Telegram จะส่ง update เดิมซ้ำไปเรื่อย ๆ
  return new Response("ok");
}

export default {
  async scheduled(event, env) {
    console.log(await watcher(env).run({ now: event.scheduledTime }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env);
    if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) {
      return new Response("Not found", { status: 404 });
    }
    const reply = (t) => new Response(t, { headers: { "Content-Type": "text/plain; charset=utf-8" } });

    switch (url.pathname) {
      case "/test":
        if (!telegramReady(env)) return reply("ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
        await notify(env, "✅ ทดสอบบอท Nintendo Museum");
        return reply("ส่งข้อความทดสอบแล้ว");
      case "/run": {
        return reply(await watcher(env).run({ dry: url.searchParams.has("dry") }));
      }
      case "/reset":
        return reply(await watcher(env).reset());
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};