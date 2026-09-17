# LINE Drive Bot

บอท LINE ที่เก็บรูปภาพและไฟล์ PDF ที่ถูกส่งในกลุ่มขึ้น Google Drive อัตโนมัติ และจดนัดหมายพร้อมเตือนล่วงหน้าในกลุ่ม

## ภาพรวมระบบ
กลุ่ม LINE → Webhook (โฮสต์บน Render) → ดึงไฟล์จาก LINE API → อัปโหลดขึ้น Google Drive (ผ่าน OAuth ของบัญชีผู้ใช้ เพราะ Service Account ไม่มี storage quota ของตัวเอง)

นัดหมายจะถูกบันทึกลง Google Sheet (ผ่าน Service Account) แล้วมี scheduler เช็คทุก 1 นาทีเพื่อส่งข้อความเตือนก่อนถึงเวลานัด

**คำสั่งจดนัดหมายในกลุ่ม:**
```
/นัด 17092026 14.00 สอบ CFO
```
รูปแบบ: `/นัด วันเดือนปี(ไม่มีขีด) ชั่วโมง.นาที ข้อความ` — บอทเตือนล่วงหน้า `REMINDER_MINUTES_BEFORE` นาที (ค่าเริ่มต้น 30)

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

## ขั้นตอนที่ 3: ตั้งค่า Google Cloud (Sheets + Drive)

### 3.1 สร้างโปรเจกต์และเปิด API
1. ไปที่ https://console.cloud.google.com/ สร้างโปรเจกต์ใหม่ (หรือใช้โปรเจกต์เดิม)
2. เมนู **APIs & Services > Library** เปิดใช้งานทั้ง **Google Drive API** และ **Google Sheets API**

### 3.2 Service Account (สำหรับ Google Sheet เก็บนัดหมาย)
1. เมนู **APIs & Services > Credentials** → **Create Credentials > Service account**
   - ตั้งชื่อ เช่น `line-drive-bot` → Done
2. คลิกเข้าไปที่ service account → แท็บ **Keys** → **Add Key > Create new key** → เลือก **JSON**
3. เปิดไฟล์ JSON ที่ดาวน์โหลดมา:
   - `client_email` → `GOOGLE_CLIENT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (เก็บทั้งก้อนรวม BEGIN/END)
4. สร้าง Google Sheet ใหม่ที่ sheets.google.com → ตั้งชื่อแท็บว่า `Sheet1` (หรือถ้าเป็นภาษาไทยจะเป็น `ชีต1` — ต้องแก้ค่า `SHEET_NAME` ใน `index.js` ให้ตรงกับชื่อแท็บจริง)
5. กด **Share** → ใส่อีเมล `client_email` จากข้อ 3 → สิทธิ์ **Editor**
6. คัดลอก Sheet ID จาก URL (`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`) → `GOOGLE_SHEET_ID`

### 3.3 OAuth Client (สำหรับอัปโหลดไฟล์ขึ้น Drive ส่วนตัว)
Service Account ไม่มี storage quota เป็นของตัวเอง จึงอัปโหลดไฟล์ใหม่เข้า Drive บัญชีบุคคลทั่วไปไม่ได้ ต้องใช้ OAuth แทน:

1. เมนู **APIs & Services > OAuth consent screen** (Google Auth Platform):
   - User type: **External**
   - กรอก App name, support email, developer email
   - แท็บ **Data Access** → Add scope `.../auth/drive`
   - แท็บ **Audience** → เพิ่มอีเมลของคุณเป็น **Test user**
2. เมนู **Credentials** → **Create Credentials > OAuth client ID** → Application type: **Desktop app** → Create
   - เก็บ **Client ID** และ **Client secret** → `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
3. รันสคริปต์ขอ refresh token ครั้งเดียวในเครื่อง (ต้อง login ผ่านเบราว์เซอร์):
   ```
   node get-google-token.js
   ```
   เปิดลิงก์ที่ขึ้นมา login ด้วยบัญชี Google ที่จะใช้เก็บไฟล์ → กด Allow → สคริปต์จะบันทึก `GOOGLE_OAUTH_REFRESH_TOKEN` ลง `.env` ให้อัตโนมัติ
4. สร้างโฟลเดอร์ใน Google Drive ของบัญชีนั้น เช่น "LINE Group Files" → คัดลอก Folder ID จาก URL → `GOOGLE_DRIVE_FOLDER_ID`

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
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_DRIVE_FOLDER_ID`
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `GOOGLE_OAUTH_REFRESH_TOKEN`
   - `REMINDER_MINUTES_BEFORE`
5. กด **Create Web Service** รอ deploy เสร็จ จะได้ URL ถาวร เช่น `https://line-drive-bot.onrender.com`
6. กลับไปที่ LINE Developers Console → เปลี่ยน **Webhook URL** เป็น `https://line-drive-bot.onrender.com/webhook` → กด **Verify**

## ขั้นตอนที่ 7: ใช้งานจริง

เชิญบอทเข้ากลุ่ม LINE ที่ต้องการเก็บไฟล์ → ทุกครั้งที่มีคนส่งรูปภาพหรือไฟล์ PDF ในกลุ่ม ไฟล์จะถูกอัปโหลดเข้าโฟลเดอร์ Google Drive ที่ตั้งไว้โดยอัตโนมัติ

### หมายเหตุ
- ไฟล์ประเภท `file` (เช่น PDF) LINE รองรับเฉพาะที่ส่งจากแอปมือถือเท่านั้น ส่งจาก LINE บน PC จะไม่ใช่ประเภทนี้
- แผน Free ของ Render จะ sleep เมื่อไม่มีการใช้งาน ทำให้ webhook แรกหลัง sleep อาจช้าไปสักครู่ (cold start) — ถ้าต้องการให้ทำงานทันทีตลอดเวลาต้องอัปเป็นแผนเสียเงิน
