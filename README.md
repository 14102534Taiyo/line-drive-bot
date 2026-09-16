# LINE Drive Bot

บอท LINE ที่เก็บรูปภาพและไฟล์ PDF ที่ถูกส่งในกลุ่ม แล้วอัปโหลดขึ้น Google Drive อัตโนมัติ

## ภาพรวมระบบ
กลุ่ม LINE → Webhook (โฮสต์บน Render) → ดึงไฟล์จาก LINE API → อัปโหลดขึ้น Google Drive (ผ่าน Service Account)

---

## ขั้นตอนที่ 1: สร้าง LINE Messaging API Channel

1. ไปที่ https://developers.line.biz/console/ แล้ว login ด้วยบัญชี LINE
2. สร้าง **Provider** ใหม่ (ตั้งชื่ออะไรก็ได้)
3. ในหน้า Provider กด **Create a new channel** เลือก **Messaging API**
4. กรอกข้อมูล channel (ชื่อ, หมวดหมู่, คำอธิบาย) แล้วสร้าง
5. เข้าไปที่ channel ที่สร้าง แท็บ **Messaging API**:
   - เลื่อนลงไปกด **Issue** ที่ Channel access token (long-lived) → คัดลอกเก็บไว้ (`LINE_CHANNEL_ACCESS_TOKEN`)
   - แท็บ **Basic settings** → คัดลอก **Channel secret** เก็บไว้ (`LINE_CHANNEL_SECRET`)
6. แท็บ **Messaging API** → **Auto-reply messages** และ **Greeting messages** → กดปิด (Disabled) เพื่อไม่ให้รบกวนกลุ่ม
7. ยังไม่ต้องใส่ Webhook URL ตอนนี้ (จะกลับมาใส่หลัง deploy เสร็จ)

## ขั้นตอนที่ 2: อนุญาตให้บอทเข้ากลุ่มแชทได้

1. ไปที่ https://manager.line.biz/ เลือก Official Account ของ channel นี้
2. เมนู **การตั้งค่า** (Settings) → **การตอบกลับ** (Response settings)
3. เปิด **"อนุญาตให้เข้าร่วมกลุ่มแชท"** (Allow bot to join group chats) เป็น **เปิด**

## ขั้นตอนที่ 3: สร้าง Google Service Account สำหรับ Drive

1. ไปที่ https://console.cloud.google.com/ สร้างโปรเจกต์ใหม่ (หรือใช้โปรเจกต์เดิม)
2. เมนู **APIs & Services > Library** ค้นหา **Google Drive API** แล้วกด **Enable**
3. เมนู **APIs & Services > Credentials** → **Create Credentials > Service account**
   - ตั้งชื่อ เช่น `line-drive-bot`
   - กด Done (ไม่ต้องตั้งค่า role เพิ่ม)
4. คลิกเข้าไปที่ service account ที่สร้าง → แท็บ **Keys** → **Add Key > Create new key** → เลือก **JSON** → ระบบจะดาวน์โหลดไฟล์ JSON มาให้
5. เปิดไฟล์ JSON นั้น จะเห็น:
   - `client_email` → เก็บไว้ (`GOOGLE_CLIENT_EMAIL`)
   - `private_key` → เก็บไว้ทั้งหมดรวม `-----BEGIN PRIVATE KEY-----...-----END PRIVATE KEY-----` (`GOOGLE_PRIVATE_KEY`)
6. ไปที่ Google Drive สร้างโฟลเดอร์ที่ต้องการเก็บไฟล์ เช่น "LINE Group Files"
7. คลิกขวาโฟลเดอร์ → **แชร์ (Share)** → เพิ่มอีเมลจาก `client_email` ในขั้นตอน 5 เป็น **ผู้แก้ไข (Editor)**
8. เปิดโฟลเดอร์นั้น ดู URL เช่น `https://drive.google.com/drive/folders/1AbCdEfGhIJKLmNoPQRstuVWxyz`
   → ส่วนท้าย `1AbCdEfGhIJKLmNoPQRstuVWxyz` คือ `GOOGLE_DRIVE_FOLDER_ID`

## ขั้นตอนที่ 4: ทดสอบ local ก่อน deploy (แนะนำ)

1. คัดลอก `.env.example` เป็น `.env` แล้วกรอกค่าที่เก็บไว้ทั้งหมดจากขั้นตอน 1 และ 3
2. รันเซิร์ฟเวอร์:
   ```
   npm start
   ```
3. เปิด terminal อีกอันรัน ngrok เพื่อเปิด public URL ชั่วคราว:
   ```
   ngrok http 3000
   ```
   (ถ้ายังไม่มี ngrok ดาวน์โหลดที่ https://ngrok.com/download)
4. คัดลอก URL ที่ ngrok ให้มา เช่น `https://xxxx.ngrok-free.app` แล้วไปใส่ใน LINE Developers Console → channel → Messaging API → **Webhook URL** เป็น `https://xxxx.ngrok-free.app/webhook` → กด **Verify** ให้ขึ้นเครื่องหมายถูก → เปิด **Use webhook**
5. เชิญบอทเข้ากลุ่มทดสอบ แล้วลองส่งรูปภาพหรือไฟล์ PDF ดู ถ้าสำเร็จจะเห็น log `Uploaded "..." -> https://drive.google.com/...` และไฟล์จะไปโผล่ในโฟลเดอร์ Google Drive

## ขั้นตอนที่ 5: Push ขึ้น GitHub

```
git add index.js package.json package-lock.json .gitignore README.md .env.example
git commit -m "Add LINE Drive bot"
```
จากนั้นสร้าง repo ใหม่บน GitHub แล้ว push ตามคำสั่งที่ GitHub แสดงให้ (`git remote add origin ...`, `git push -u origin main`)

**ห้าม commit ไฟล์ `.env` หรือ service account JSON ขึ้น GitHub เด็ดขาด** (ไฟล์ `.gitignore` กันไว้ให้แล้ว)

## ขั้นตอนที่ 6: Deploy บน Render

1. ไปที่ https://render.com/ สมัคร/login ด้วยบัญชี GitHub
2. **New > Web Service** → เลือก repo `line-drive-bot` ที่เพิ่ง push
3. ตั้งค่า:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. เลื่อนไปที่ **Environment Variables** ใส่ค่าทั้งหมดจาก `.env`:
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `GOOGLE_CLIENT_EMAIL`
   - `GOOGLE_PRIVATE_KEY` (ใส่ทั้งก้อนรวม BEGIN/END, Render รองรับ newline ในค่าตัวแปรได้)
   - `GOOGLE_DRIVE_FOLDER_ID`
5. กด **Create Web Service** รอ deploy เสร็จ จะได้ URL ถาวร เช่น `https://line-drive-bot.onrender.com`
6. กลับไปที่ LINE Developers Console → เปลี่ยน **Webhook URL** เป็น `https://line-drive-bot.onrender.com/webhook` → กด **Verify**

## ขั้นตอนที่ 7: ใช้งานจริง

เชิญบอทเข้ากลุ่ม LINE ที่ต้องการเก็บไฟล์ → ทุกครั้งที่มีคนส่งรูปภาพหรือไฟล์ PDF ในกลุ่ม ไฟล์จะถูกอัปโหลดเข้าโฟลเดอร์ Google Drive ที่ตั้งไว้โดยอัตโนมัติ

### หมายเหตุ
- ไฟล์ประเภท `file` (เช่น PDF) LINE รองรับเฉพาะที่ส่งจากแอปมือถือเท่านั้น ส่งจาก LINE บน PC จะไม่ใช่ประเภทนี้
- แผน Free ของ Render จะ sleep เมื่อไม่มีการใช้งาน ทำให้ webhook แรกหลัง sleep อาจช้าไปสักครู่ (cold start) — ถ้าต้องการให้ทำงานทันทีตลอดเวลาต้องอัปเป็นแผนเสียเงิน
