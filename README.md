# Nintendo Museum Ticket Watcher (Cloudflare Worker + Telegram)

บอทนี้รันบน Cloudflare Workers (แพ็กเกจฟรี) โดยใช้ Cron Trigger ตรวจปฏิทินทุก 15 นาที ที่นาที 00, 15, 30 และ 45 ตรงเวลา ไม่ดีเลย์แบบ GitHub Actions

บอทจะแจ้งเตือนเข้า Telegram เมื่อ

- วันใน ต.ค. / พ.ย. / ธ.ค. เปลี่ยนเป็นมีบัตรว่าง (`open_status=1` และ `sale_status=1`)
- ปฏิทิน ธ.ค. เปลี่ยนจาก null เป็นเริ่มมีข้อมูล
- `sale_status` เป็นค่าที่ไม่รู้จัก
- ดึงข้อมูลไม่ได้ 3 รอบติดกัน และเมื่อกลับมาดึงได้

```
nm-worker/
├── src/index.js     โค้ด Worker
├── wrangler.toml    config (ชื่อ worker, cron, KV)
└── README.md
```

---

## 1. สร้าง Telegram bot (เหมือนกันทั้ง Windows และ Mac)

1. เปิด Telegram คุยกับ **@BotFather** แล้วพิมพ์ `/newbot` ตั้งชื่อตามขั้นตอน จะได้ **token** หน้าตาประมาณ `123456789:AAH...`
2. เปิดแชตกับบอทที่สร้างแล้วกด **Start**
3. เปิด browser ไปที่ `https://api.telegram.org/bot<TOKEN>/getUpdates` (แทน `<TOKEN>` ด้วย token ของตัวเอง)
4. หาค่า `"chat":{"id":...}` ตัวเลขนี้คือ **chat id**
   - ถ้าต้องการส่งเข้ากลุ่ม ให้เพิ่มบอทเข้ากลุ่ม พิมพ์ข้อความในกลุ่ม 1 ครั้ง แล้วเปิด URL เดิมอีกรอบ chat id ของกลุ่มจะเป็นเลขติดลบ เช่น `-100...`

ต้องมีบัญชี **Cloudflare** ด้วย สมัครฟรีที่ https://dash.cloudflare.com/sign-up ไม่ต้องมีโดเมน

---

## 2. ติดตั้ง Node.js และแตกไฟล์

### 🍎 Mac

1. ติดตั้ง Node.js เลือกวิธีใดวิธีหนึ่ง
   - ดาวน์โหลดตัวติดตั้ง **LTS** จาก https://nodejs.org แล้วติดตั้งตามปกติ
   - หรือถ้ามี Homebrew: `brew install node`
2. ดับเบิลคลิก `nm-worker.zip` เพื่อแตกไฟล์ (สมมติว่าอยู่ใน Downloads)
3. เปิด **Terminal** (กด `⌘ + Space` แล้วพิมพ์ Terminal) แล้วรัน

```bash
node --version          # ต้องได้ v20 ขึ้นไป
cd ~/Downloads/nm-worker
```

### 🪟 Windows

1. ติดตั้ง Node.js เลือกวิธีใดวิธีหนึ่ง
   - ดาวน์โหลดตัวติดตั้ง **LTS** (.msi) จาก https://nodejs.org แล้วติดตั้งตามปกติ
   - หรือเปิด PowerShell แล้วพิมพ์ `winget install OpenJS.NodeJS.LTS`
2. คลิกขวาที่ `nm-worker.zip` แล้วเลือก **Extract All…** (สมมติว่าแตกไว้ใน Downloads)
3. **ปิด PowerShell เดิมแล้วเปิดใหม่** (ไม่อย่างนั้นจะยังไม่เห็นคำสั่ง `node`) จากนั้นรัน

```powershell
node --version          # ต้องได้ v20 ขึ้นไป
cd $HOME\Downloads\nm-worker\nm-worker
```

> ถ้า Extract All สร้างโฟลเดอร์ซ้อนกันสองชั้น ให้ `cd` เข้าไปจนถึงโฟลเดอร์ที่มีไฟล์ `wrangler.toml` อยู่ข้างใน ตรวจได้ด้วยคำสั่ง `dir`

> ถ้ารัน `npx` แล้วเจอ error *"running scripts is disabled on this system"* ให้รันคำสั่งนี้ครั้งเดียว แล้วตอบ `Y`
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```
> หรือพิมพ์ `npx.cmd` แทน `npx` ในทุกคำสั่งก็ได้

---

## 3. Deploy

คำสั่งด้านล่างใช้ได้ทั้ง **Terminal (Mac)** และ **PowerShell (Windows)** ยกเว้นจุดที่แยกไว้

### 3.1 Login Cloudflare

```bash
npx wrangler login
```

ถ้าถามว่าจะติดตั้ง wrangler หรือไม่ ให้ตอบ `y` จากนั้น browser จะเปิดหน้าให้กด **Allow**

### 3.2 สร้าง KV สำหรับเก็บ state

```bash
npx wrangler kv namespace create STATE
```

คำสั่งนี้จะแสดง `id = "xxxxxxxx..."` ออกมา ให้ copy ค่านั้นไปใส่แทน `ใส่_ID_จาก_wrangler_kv_namespace_create` ในไฟล์ `wrangler.toml`

| | วิธีเปิดแก้ `wrangler.toml` |
|---|---|
| 🍎 Mac | `nano wrangler.toml` แก้แล้วกด `Ctrl+O` → `Enter` → `Ctrl+X` หรือเปิดด้วย VS Code (**อย่าใช้ TextEdit** เพราะจะเปลี่ยนเครื่องหมาย `"` เป็นอัญประกาศโค้ง ทำให้ไฟล์เสีย) |
| 🪟 Windows | `notepad wrangler.toml` แก้แล้วกด `Ctrl+S` หรือเปิดด้วย VS Code |

หลังแก้แล้ว บรรทัดนั้นควรมีหน้าตาแบบนี้

```toml
id = "a1b2c3d4e5f6..."
```

### 3.3 Deploy

```bash
npx wrangler deploy
```

เมื่อ deploy เสร็จจะได้ URL ประมาณ `https://nintendo-museum-watch.<ชื่อของคุณ>.workers.dev` ให้จดไว้ใช้ทดสอบ

> deploy ครั้งแรก wrangler อาจถามให้ตั้งชื่อ subdomain ของ `workers.dev` ตั้งเป็นอะไรก็ได้

### 3.4 ใส่ Secrets

รันทีละคำสั่ง แต่ละคำสั่งจะให้วางค่าแล้วกด Enter

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RUN_KEY
```

`RUN_KEY` คือรหัสสุ่มสำหรับเรียก endpoint ทดสอบ สร้างได้ด้วยคำสั่งนี้

| | คำสั่งสุ่ม RUN_KEY |
|---|---|
| 🍎 Mac | `openssl rand -hex 16` |
| 🪟 Windows | `[guid]::NewGuid().ToString("N")` |

> **การวางข้อความ:** บน Mac กด `⌘ + V` ส่วนใน PowerShell กด `Ctrl + V` หรือคลิกขวา ขณะวาง secret หน้าจอจะไม่แสดงตัวอักษรออกมา ซึ่งเป็นเรื่องปกติ

ถ้า deploy ก่อนใส่ secret บอทจะข้ามรอบนั้นไปโดยไม่บันทึก state ข้อความรอบแรกจึงไม่หาย

---

## 4. ทดสอบ

เปิด URL เหล่านี้ใน browser (แทน `<URL>` และ `<RUN_KEY>` ด้วยค่าจริง)

| URL | ผลลัพธ์ |
|---|---|
| `<URL>/run?key=<RUN_KEY>&dry=1` | ดึงข้อมูลจริงแล้วแสดงผลบนหน้าเว็บ ไม่ส่ง Telegram และไม่บันทึก state |
| `<URL>/test?key=<RUN_KEY>` | ส่งข้อความทดสอบเข้า Telegram |
| `<URL>/run?key=<RUN_KEY>` | รันจริงทันที เหมือนรอบของ cron |

1. ให้ทดสอบ **`dry=1` ก่อน** ถ้าเห็นสรุปจำนวนวันว่าง/เต็ม/ปิด แปลว่าใช้ได้ แต่ถ้าเห็น `fetch failed ... HTTP 403` หรือ `ไม่พบ csrf-token` แปลว่าเว็บ Nintendo ไม่รับ request จาก Cloudflare ให้เปลี่ยนไปใช้เวอร์ชัน Python บน VPS หรือเครื่องที่บ้านแทน
2. เปิด `/test` แล้ว Telegram ควรได้ "✅ ทดสอบบอท Nintendo Museum"
3. เปิด `/run` หรือรอรอบ cron ถัดไป (ไม่เกิน 15 นาที) แล้วจะได้ข้อความ **"🤖 เริ่มเฝ้าบัตรแล้ว"** พร้อมสรุปของแต่ละเดือน

---

## 5. ดูแลระบบ

### ดู log

```bash
npx wrangler tail
```

หรือเปิด Dashboard → **Workers & Pages** → `nintendo-museum-watch` → **Logs**

### เปลี่ยนความถี่

แก้ `crons` ใน `wrangler.toml` แล้วรัน `npx wrangler deploy` อีกครั้ง

```toml
crons = ["0,15,30,45 * * * *"]   # ทุก 15 นาที (ค่าปัจจุบัน)
crons = ["*/5 * * * *"]          # ทุก 5 นาที
```

Cron ของ Cloudflare ใช้เวลา UTC แต่การตั้งเป็นนาทีแบบนี้ให้ผลตรงกับเวลาไทยเหมือนกัน

### เพิ่ม/เปลี่ยนเดือนที่เฝ้า

แก้ `WATCH_MONTHS` และ `RELEASE_MONTHS` ด้านบนของ `src/index.js` แล้วรัน `npx wrangler deploy`

### เริ่มนับใหม่ (ให้แจ้งวันว่างทั้งหมดอีกรอบ)

```bash
npx wrangler kv key delete state --binding STATE --remote
```

### หยุดบอทถาวร

```bash
npx wrangler delete
```

---

## แก้ปัญหาที่พบบ่อย

| อาการ | วิธีแก้ |
|---|---|
| `node` / `npx` is not recognized (Windows) | ปิด PowerShell แล้วเปิดใหม่หลังติดตั้ง Node.js ถ้ายังไม่หายให้ restart เครื่อง |
| `command not found: npx` (Mac) | ติดตั้ง Node.js แล้วเปิด Terminal ใหม่ |
| running scripts is disabled (Windows) | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` หรือใช้ `npx.cmd` |
| deploy แล้ว error เรื่อง KV namespace | ตรวจว่าใส่ `id` ใน `wrangler.toml` ถูกต้อง และเครื่องหมาย `"` เป็นแบบตรง ไม่ใช่อัญประกาศโค้ง |
| เปิด `/run` แล้วได้ `Not found` | ค่า `key=` ไม่ตรงกับ `RUN_KEY` หรือยังไม่ได้ใส่ secret `RUN_KEY` |
| ไม่ได้ข้อความ Telegram | ตรวจว่ากด Start กับบอทแล้ว และ chat id ถูกต้อง (ของกลุ่มต้องมี `-` นำหน้า) |
| `/run?dry=1` ขึ้น `HTTP 403` / `ไม่พบ csrf-token` | เว็บ Nintendo ไม่รับ request จาก Cloudflare ให้ย้ายไปรันเวอร์ชัน Python บน VPS หรือเครื่องที่บ้าน |

## โควตาแพ็กเกจฟรี

- รันวันละ 96 รอบ แต่ละรอบมี subrequest 4–5 ครั้ง (หน้า calendar 1 + API 3 + Telegram) ต่ำกว่าลิมิตมาก
- เขียน KV เฉพาะเมื่อสถานะเปลี่ยน และหยุดเขียนระหว่างที่ล่มนานหลังครบ 3 รอบ ใช้ write quota น้อยมาก
