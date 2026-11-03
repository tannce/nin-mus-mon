/**
 * core.js — logic ทั้งหมดของบอท (ไม่ผูกกับ Cloudflare API จึงทดสอบบน Node ได้)
 *
 * Status code (ยืนยันจากข้อมูลจริง):
 *   open_status: 1 = เปิดทำการ, 2 = วันหยุด/ปิดชั่วคราว, null = Preparing (ยังไม่เปิดขาย)
 *   sale_status: 1 = มีบัตรว่าง, 2 = เต็ม (Sold Out)
 *   apply_type : 3 = ขายทั่วไป (On Sale), 2 = Drawing (ช่วงนี้ sale_status = 1 ทุกวัน แต่ไม่ใช่บัตรว่าง)
 *                ค่าอื่นถือว่ายังไม่เปิดขายทั่วไปเช่นกัน
 *
 * เดือนที่เฝ้าคำนวณอัตโนมัติ: เดือนปัจจุบันตามเวลาญี่ปุ่น + ล่วงหน้า MONTHS_AHEAD เดือน
 *
 * การส่ง Telegram มีแค่ 2 แบบ (ตรวจทุกรอบตาม cron แต่ส่งเฉพาะเมื่อมีการเปลี่ยนแปลง):
 *   🟢 มีวันว่างใหม่ — วันที่เพิ่งว่างในรอบนี้ + รายการวันที่ยังว่างอยู่ก่อนแล้ว (มีเสียงแจ้งเตือน)
 *   🔴 หายไป  — วันที่เคยว่างแล้วกลับเป็นเต็ม/ปิด พร้อมบอกว่าว่างอยู่นานแค่ไหน
 *               (ส่งแบบเงียบเป็นค่าเริ่มต้น ปรับได้ที่ SILENT_ON_GONE)
 *
 * คำสั่งใน Telegram: /check = ดูวันว่าง ณ ตอนนี้ (ดึงข้อมูลสด)
 */

export const BASE = "https://museum-tickets.nintendo.com";
export const CAL_PAGE = `${BASE}/en/calendar`;
const API = `${BASE}/en/api/calendar`;

export const MONTHS_AHEAD = 2;                   // เฝ้าเดือนปัจจุบัน (ตามเวลาญี่ปุ่น) + ล่วงหน้าอีกกี่เดือน
const SALE_APPLY_TYPE = 3;                       // apply_type ของเดือนที่เปิดขายทั่วไป (On Sale)
const APPLY_LABEL = { 2: "Drawing (ช่วงลงทะเบียนจับฉลาก)" };   // ยืนยันจากข้อมูลจริง ม.ค. 2027

const OPEN = 1;                                  // open_status
const AVAILABLE = 1;
const SOLD_OUT = 2;
const SILENT_ON_GONE = true;                     // true = ข้อความ "หายไป" ส่งแบบเงียบ (ไม่มีเสียง/ไม่สั่น)
const ALERT_ON_FAILURE = false;                  // true = แจ้งเมื่อดึงข้อมูลไม่ได้ FAIL_ALERT_AFTER รอบติด และเมื่อกลับมาได้
export const FAIL_ALERT_AFTER = 3;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const CSRF_PATTERNS = [
  /<meta[^>]+name=["']csrf-token["'][^>]*content=["']([^"']+)/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i,
];
const WEEKDAY_TH = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];   // getUTCDay(): 0 = อาทิตย์

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

class SessionError extends Error {}

// ------------------------------------------------------------------ HTTP
function parseSetCookies(headers) {
  let list;
  if (typeof headers.getSetCookie === "function") {
    list = headers.getSetCookie();
  } else {
    const raw = headers.get("set-cookie");
    list = raw ? raw.split(/,(?=\s*[^;=\s]+=)/) : [];
  }
  const jar = {};
  for (const c of list) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
}

async function newSession() {
  const r = await fetch(CAL_PAGE, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!r.ok) throw new SessionError(`calendar page HTTP ${r.status}`);
  const html = await r.text();
  const m = CSRF_PATTERNS.map((p) => html.match(p)).find(Boolean);
  if (!m) throw new SessionError("ไม่พบ csrf-token ในหน้า calendar");

  const jar = parseSetCookies(r.headers);
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "application/json, text/plain, */*",
    "X-CSRF-TOKEN": m[1],
    "X-Requested-With": "XMLHttpRequest",
    "Referer": CAL_PAGE,
  };
  if (jar["XSRF-TOKEN"]) headers["X-XSRF-TOKEN"] = decodeURIComponent(jar["XSRF-TOKEN"]);
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

async function fetchMonth(headers, year, month) {
  const url = `${API}?target_year=${year}&target_month=${month}`;
  const r = await fetch(url, { headers, redirect: "manual" });
  const ctype = r.headers.get("content-type") || "";
  if (r.status !== 200 || !ctype.includes("json")) {
    throw new SessionError(`${year}-${String(month).padStart(2, "0")}: HTTP ${r.status} (${ctype || "no content-type"})`);
  }
  const body = await r.json();
  const cal = body?.data?.calendar;
  if (!cal || typeof cal !== "object" || Array.isArray(cal)) return {};   // null หรือ [] = ยังไม่มีข้อมูล
  const out = {};
  for (const [k, v] of Object.entries(cal)) {
    if (v && typeof v === "object") out[k] = v;                           // ตัดวันที่เป็น null ออก
  }
  return out;
}

export async function fetchAll(months) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const headers = await newSession();
      const out = {};
      for (const [y, m] of months) {
        out[`${y}-${String(m).padStart(2, "0")}`] = await fetchMonth(headers, y, m);
        await sleep(rand(500, 1500));
      }
      return out;
    } catch (e) {
      if (!(e instanceof SessionError) || attempt === 2) throw e;
      await sleep(3000);
    }
  }
}

// ------------------------------------------------------------------ เวลา / รูปแบบ
const pad = (n) => String(n).padStart(2, "0");
const shift = (ts, h) => new Date(ts + h * 3600 * 1000);

/** เวลาไทย HH:MM */
export function hmTH(ts) {
  const d = shift(ts, 7);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** เวลาไทย DD/MM HH:MM */
export function dtTH(ts) {
  const d = shift(ts, 7);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${hmTH(ts)}`;
}

/** วันที่ปัจจุบันในญี่ปุ่น YYYY-MM-DD */
export function todayJST(ts) {
  return shift(ts, 9).toISOString().slice(0, 10);
}

/** เดือนที่ต้องเฝ้า: เดือนปัจจุบันตามเวลาญี่ปุ่น + ล่วงหน้า MONTHS_AHEAD เดือน เช่น ต.ค. 2026 -> [ต.ค., พ.ย., ธ.ค.] */
export function watchMonths(ts) {
  const d = shift(ts, 9);
  const out = [];
  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1));
    out.push([t.getUTCFullYear(), t.getUTCMonth() + 1]);
  }
  return out;
}

function fmtDate(date) {
  return `${date} (${WEEKDAY_TH[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
}

// ------------------------------------------------------------------ วิเคราะห์ปฏิทิน
export function category(d) {
  if (d.open_status == null) return "N";                 // Preparing: ทุก field เป็น null ก่อนเปิดขาย
  if (d.open_status !== OPEN || d.is_temporary_closure) return "C";
  if (d.apply_type !== SALE_APPLY_TYPE) return `D:${d.apply_type}`;   // ยังไม่ใช่ช่วงขายทั่วไป เช่น Drawing
  if (d.sale_status === AVAILABLE) return "A";
  if (d.sale_status === SOLD_OUT) return "S";
  return `U:apply=${d.apply_type}/sale=${d.sale_status}`;
}

/** ชื่อช่วงของเดือนที่ยังไม่เปิดขายทั่วไป เช่น "Drawing (ช่วงลงทะเบียนจับฉลาก)" หรือ "ยังไม่เปิดขายทั่วไป (apply_type=4)" */
function phaseLabel(applyTypes) {
  return [...applyTypes].map((t) => APPLY_LABEL[t] ?? `ยังไม่เปิดขายทั่วไป (apply_type=${t})`).join(", ");
}

/**
 * เทียบปฏิทินรอบนี้กับ state เดิม
 * today = วันนี้ (JST) — ข้ามวันที่ <= today เพราะบัตรขายถึงแค่วันก่อนวันเข้าชม
 */
export function evaluate(cals, months, prevDays, prevReleased, today) {
  const firstRun = Object.keys(prevDays).length === 0 && Object.keys(prevReleased).length === 0;
  const days = {}, released = {};
  const newAvail = [], goneAvail = [], unknownNew = [], releasedNow = [], monthLines = [];

  for (const [y, m] of months) {
    const key = `${y}-${pad(m)}`;
    const cal = cals[key] || {};
    const c = { A: 0, S: 0, C: 0, U: 0, N: 0, D: 0 };
    const applyTypes = new Set();                // apply_type ของวันที่อยู่ในสถานะ D

    for (const date of Object.keys(cal).sort()) {
      if (date <= today) continue;
      const cat = category(cal[date]);
      c[cat[0]]++;
      if (cat.startsWith("D")) applyTypes.add(cat.slice(2));
      days[date] = cat;
      const prev = prevDays[date];
      if (cat === "A" && prev !== "A") newAvail.push(date);
      if (cat !== "A" && prev === "A") goneAvail.push(date);
      if (cat.startsWith("U") && prev !== cat) unknownNew.push(`❓ ${fmtDate(date)} ${cat.slice(2)}`);
    }

    const countText = `ว่าง ${c.A} / เต็ม ${c.S} / ปิด ${c.C}` +
      (c.U ? ` / ไม่รู้จัก ${c.U}` : "") + (c.N ? ` / Preparing ${c.N}` : "") +
      (c.D ? ` / ${phaseLabel(applyTypes)} ${c.D}` : "");
    const counted = c.A + c.S + c.C + c.U + c.N + c.D;

    // "เปิดขายแล้ว" = มีอย่างน้อย 1 วันที่เปิดทำการและเป็นช่วงขายทั่วไป
    // (ตอน Preparing ทุก field เป็น null, ตอน Drawing apply_type ไม่ใช่ 3)
    released[key] = Object.values(cal).some((d) => d.open_status === OPEN && d.apply_type === SALE_APPLY_TYPE);
    // แจ้งเฉพาะเดือนที่เคยบันทึกไว้แล้วว่ายังไม่เปิด -> เดือนที่เพิ่งเข้ามาในช่วงเฝ้า (เช่นตอนขึ้นเดือนใหม่)
    // จะถูกบันทึกเป็นค่าเริ่มต้นโดยไม่แจ้ง
    if (released[key] && key in prevReleased && !prevReleased[key] && !firstRun) {
      releasedNow.push(`📅 ${key} เปิดขายแล้ว! (${countText} วัน)`);
    }

    monthLines.push(
      Object.keys(cal).length === 0 ? `${key}: ยังไม่มีข้อมูล (null)`
        : counted > 0 && c.N === counted ? `${key}: ⏳ Preparing (ยังไม่เปิดขาย)`
          : counted > 0 && c.D + c.C === counted && c.D > 0
            ? `${key}: 🎟️ ${phaseLabel(applyTypes)}`
            : `${key}: ${countText}`);
  }

  return { firstRun, days, released, newAvail, goneAvail, unknownNew, releasedNow, monthLines };
}

// ------------------------------------------------------------------ สร้างข้อความ
const availList = (days) => Object.keys(days).filter((d) => days[d] === "A").sort();

function duration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} นาที`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

/**
 * newAvail: วันที่เพิ่งว่าง, goneAvail: วันที่เพิ่งหายไป
 * since: { date: เวลาที่เริ่มเห็นว่าง } (ของรอบก่อน — ใช้คำนวณว่าว่างอยู่นานแค่ไหน)
 * คืน { text, silent } หรือ null ถ้าไม่มีอะไรเปลี่ยน
 */
export function buildMessage({ now, newAvail, goneAvail, since, days }) {
  if (!newAvail.length && !goneAvail.length) return null;
  const parts = [];

  if (newAvail.length) {
    parts.push("🟢 มีวันว่างใหม่:\n" + newAvail.map((d) => `• ${fmtDate(d)}`).join("\n"));
  }
  if (goneAvail.length) {
    parts.push("🔴 หายไป:\n" + goneAvail.map((d) => {
      const from = since[d];
      return `• ${fmtDate(d)}` + (from ? ` (ว่างอยู่ ${duration(now - from)} · ${hmTH(from)}–${hmTH(now)})` : "");
    }).join("\n"));
  }

  // แนบวันที่ว่างอยู่ก่อนแล้ว (ไม่ซ้ำกับวันที่เพิ่งว่าง) ให้เห็นภาพรวมทุกครั้ง
  const others = availList(days).filter((d) => !newAvail.includes(d));
  if (others.length) parts.push("ยังว่างอยู่:\n" + others.map((d) => `• ${fmtDate(d)}`).join("\n"));
  else if (!newAvail.length) parts.push("ตอนนี้ไม่มีวันว่าง");

  if (availList(days).length) parts.push(`👉 ${CAL_PAGE}`);
  return {
    text: `🎮 Nintendo Museum · ${dtTH(now)}\n\n` + parts.join("\n\n"),
    silent: newAvail.length === 0 && SILENT_ON_GONE,
  };
}

/** ข้อความสถานะ สำหรับคำสั่ง /check ใน Telegram และ /run?dry=1 */
export function statusText(now, days, monthLines, note = "") {
  const list = availList(days);
  const parts = [
    list.length ? "🟢 วันว่างตอนนี้:\n" + list.map((d) => `• ${fmtDate(d)}`).join("\n") : "❌ ตอนนี้ไม่มีวันว่าง",
  ];
  if (monthLines?.length) parts.push("รายเดือน:\n" + monthLines.join("\n"));
  if (note) parts.push(note);
  if (list.length) parts.push(`👉 ${CAL_PAGE}`);
  return `🎮 Nintendo Museum · ${dtTH(now)}\n\n` + parts.join("\n\n");
}

/**
 * ตรวจสถานะสด ๆ สำหรับคำสั่ง /check (ไม่แก้ state จึงไม่กระทบการแจ้ง "มีวันว่างใหม่"/"หายไป")
 * ถ้าดึงข้อมูลไม่ได้ จะตอบจากข้อมูลล่าสุดที่บันทึกไว้แทน
 */
export async function checkNow(storage, now = Date.now()) {
  try {
    const months = watchMonths(now);
    const r = evaluate(await fetchAll(months), months, {}, {}, todayJST(now));
    return statusText(now, r.days, r.monthLines);
  } catch (e) {
    const st = (await storage.get("state")) || {};
    return statusText(now, st.days || {}, null,
      `⚠️ ดึงข้อมูลสดไม่ได้ (${e.message})\nรายการด้านบนมาจากข้อมูลล่าสุดที่บอทบันทึกไว้`);
  }
}

// ------------------------------------------------------------------ Telegram
export function telegramReady(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

export async function notify(env, text, { dry = false, silent = false } = {}) {
  text = text.slice(0, 4000);                       // Telegram จำกัด 4096 ตัวอักษร
  if (dry || !telegramReady(env)) {
    console.log(text);
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      disable_notification: silent,
    }),
  });
  if (!r.ok) console.error(`Telegram send failed: ${r.status} ${await r.text()}`);
}

// ------------------------------------------------------------------ 1 รอบการตรวจ
/**
 * storage: อะไรก็ได้ที่มี async get(key) / put(key, value)
 *          (บน Cloudflare คือ Durable Object storage ซึ่ง consistent และไม่จำกัด write แบบ KV)
 * opts.now: เวลาของรอบนี้ (ms) — จาก cron ใช้ event.scheduledTime
 * opts.dry: ดึงข้อมูลจริงแต่ไม่ส่ง Telegram ไม่บันทึก state และคืนข้อความสถานะ
 */
export async function runCheck(env, storage, { dry = false, now = Date.now() } = {}) {
  if (!dry && !telegramReady(env)) {
    return "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID ยังไม่ได้ตั้งค่า: ข้ามรอบนี้";
  }

  const st = (await storage.get("state")) || {};
  const prevDays = st.days || {};
  const prevSince = st.since || {};
  const failCount = st.failCount || 0;

  let cals, months;
  try {
    months = watchMonths(now);
    cals = await fetchAll(months);
  } catch (e) {
    const fc = failCount + 1;
    console.error(`fetch failed (${fc}): ${e.message}`);
    if (dry) return `ดึงข้อมูลไม่ได้: ${e.message}`;
    if (ALERT_ON_FAILURE && fc === FAIL_ALERT_AFTER) {
      await notify(env, `⚠️ Nintendo Museum · ${dtTH(now)}\nดึงข้อมูลไม่ได้ ${FAIL_ALERT_AFTER} รอบติดกัน\n${e.message}`);
    }
    if (fc <= FAIL_ALERT_AFTER + 1) await storage.put("state", { ...st, failCount: fc });
    return `fetch failed (${fc})`;
  }

  const r = evaluate(cals, months, prevDays, {}, todayJST(now));
  if (dry) return statusText(now, r.days, r.monthLines);

  if (ALERT_ON_FAILURE && failCount >= FAIL_ALERT_AFTER) {
    await notify(env, `✅ Nintendo Museum · ${dtTH(now)}\nกลับมาดึงข้อมูลได้แล้ว`);
  }

  const msg = buildMessage({ now, newAvail: r.newAvail, goneAvail: r.goneAvail, since: prevSince, days: r.days });
  if (msg) await notify(env, msg.text, { silent: msg.silent });

  // เวลาที่เริ่มว่าง: เก็บเฉพาะวันที่ยังว่างอยู่ (วันเดิมใช้ค่าเดิม วันใหม่ใช้เวลารอบนี้)
  const since = {};
  for (const d of availList(r.days)) since[d] = prevSince[d] ?? (r.newAvail.includes(d) ? now : null);

  const next = { days: r.days, since, failCount: 0 };
  if (JSON.stringify(next) !== JSON.stringify(st)) await storage.put("state", next);   // เขียนเฉพาะเมื่อเปลี่ยน
  return msg ? msg.text : "no change";
}
