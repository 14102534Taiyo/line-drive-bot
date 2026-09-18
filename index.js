require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const stream = require('stream');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.Client(lineConfig);

const sheetsAuth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const driveAuth = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET
);
driveAuth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: driveAuth });
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
const SHEET_NAME = 'ชีต1';
const SHEET_RANGE = `${SHEET_NAME}!A:D`;
const DRIVE_CONFIG_SHEET = 'DriveConfig';
const DRIVE_CONFIG_RANGE = `${DRIVE_CONFIG_SHEET}!A:C`;
const CHAT_LOG_SHEET = 'ChatLog';
const CHAT_LOG_RANGE = `${CHAT_LOG_SHEET}!A:E`;
const GEMINI_MODEL = 'gemini-flash-latest';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 30);
const BANGKOK_UTC_OFFSET_HOURS = 7;

async function ensureChatLogSheet() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === CHAT_LOG_SHEET);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: CHAT_LOG_SHEET } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${CHAT_LOG_SHEET}!A1:E1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['groupId', 'timestamp', 'senderName', 'messageType', 'text']] },
  });
  console.log('Created ChatLog sheet tab');
}

const senderNameCache = new Map();

async function getSenderName(source) {
  const key = `${source.groupId || 'user'}:${source.userId}`;
  if (senderNameCache.has(key)) return senderNameCache.get(key);

  let name = source.userId;
  try {
    const profile = source.groupId
      ? await lineClient.getGroupMemberProfile(source.groupId, source.userId)
      : await lineClient.getProfile(source.userId);
    name = profile.displayName;
  } catch {
    // ดึงชื่อไม่ได้ ใช้ userId แทน
  }
  senderNameCache.set(key, name);
  return name;
}

function describeMessage(message) {
  switch (message.type) {
    case 'text':
      return message.text;
    case 'image':
      return '[รูปภาพ]';
    case 'file':
      return `[ไฟล์: ${message.fileName}]`;
    case 'sticker':
      return '[สติกเกอร์]';
    case 'video':
      return '[วิดีโอ]';
    case 'audio':
      return '[ข้อความเสียง]';
    case 'location':
      return `[ตำแหน่ง: ${message.title || ''}]`;
    default:
      return `[${message.type}]`;
  }
}

let chatLogBuffer = [];

async function logChatMessage(event) {
  const groupId = event.source.groupId || event.source.userId;
  const senderName = await getSenderName(event.source);
  chatLogBuffer.push([groupId, new Date().toISOString(), senderName, event.message.type, describeMessage(event.message)]);
}

async function flushChatLogBuffer() {
  if (chatLogBuffer.length === 0) return;
  const rows = chatLogBuffer;
  chatLogBuffer = [];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: CHAT_LOG_RANGE,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function summarizeChat(transcript) {
  const todayStr = formatBangkokDateTime(Date.now()).split(' ')[0];
  const prompt = `วันนี้คือวันที่ ${todayStr} (เวลาไทย) สรุปบทสนทนากลุ่ม LINE ต่อไปนี้เป็นภาษาไทย โดยแยกเป็นหัวข้อตามประเด็นที่คุยกัน (ใช้หัวข้อสั้นๆ นำหน้าแต่ละประเด็น ตามด้วย bullet สรุปใจความสำคัญ) ถ้ามีการพูดถึงวันเวลานัดหมายหรือกำหนดการแบบสัมพัทธ์ (เช่น "พรุ่งนี้", "มะรืนนี้", "จันทร์หน้า") ให้แปลงเป็นวันที่จริงกำกับไว้ในสรุปด้วย กระชับ ไม่ต้องทักทายหรือลงท้าย:\n\n${transcript}`;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      return data.candidates[0].content.parts[0].text;
    }

    const retriable = res.status === 503 || res.status === 429;
    if (!retriable || attempt === maxAttempts) {
      throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    }
    await sleep(2000 * attempt);
  }
}

async function ensureDriveConfigSheet() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === DRIVE_CONFIG_SHEET);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: DRIVE_CONFIG_SHEET } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${DRIVE_CONFIG_SHEET}!A1:C1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['groupId', 'refreshToken', 'folderId']] },
  });
  console.log('Created DriveConfig sheet tab');
}

function createWebOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
    process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET,
    `${process.env.BASE_URL}/oauth2callback`
  );
}

function buildSetupUrl(groupId) {
  return `${process.env.BASE_URL}/setup?groupId=${encodeURIComponent(groupId)}`;
}

async function getDriveConfig(groupId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: DRIVE_CONFIG_RANGE,
  });
  const rows = res.data.values || [];
  const row = rows.find((r) => r[0] === groupId);
  return row ? { refreshToken: row[1], folderId: row[2] } : null;
}

async function setDriveConfig(groupId, refreshToken, folderId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: DRIVE_CONFIG_RANGE,
  });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex((r) => r[0] === groupId);

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: DRIVE_CONFIG_RANGE,
      valueInputOption: 'RAW',
      requestBody: { values: [[groupId, refreshToken, folderId]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${DRIVE_CONFIG_SHEET}!A${rowIndex + 1}:C${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[groupId, refreshToken, folderId]] },
    });
  }
}

const groupFolderCache = new Map();
const driveClientCache = new Map();

async function getDriveClientForSource(source) {
  const key = source.groupId || source.userId;
  if (driveClientCache.has(key)) return driveClientCache.get(key);

  const config = await getDriveConfig(key);
  let result;
  if (config) {
    const userAuth = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
      process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET
    );
    userAuth.setCredentials({ refresh_token: config.refreshToken });
    result = { drive: google.drive({ version: 'v3', auth: userAuth }), folderId: config.folderId };
  } else {
    result = { drive, folderId: await getOrCreateGroupFolder(source) };
  }

  driveClientCache.set(key, result);
  return result;
}

async function getOrCreateGroupFolder(source) {
  const groupId = source.groupId || source.userId;
  if (groupFolderCache.has(groupId)) return groupFolderCache.get(groupId);

  let folderName = groupId;
  if (source.groupId) {
    try {
      const summary = await lineClient.getGroupSummary(source.groupId);
      folderName = summary.groupName;
    } catch {
      // ไม่มีสิทธิ์ดึงชื่อกลุ่ม ใช้ groupId แทน
    }
  }

  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const existing = await drive.files.list({
    q: `'${parentId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
  });

  let folderId;
  if (existing.data.files.length > 0) {
    folderId = existing.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    });
    folderId = created.data.id;
  }

  groupFolderCache.set(groupId, folderId);
  return folderId;
}

async function uploadToDrive(driveClient, fileName, mimeType, contentStream, folderId) {
  const res = await driveClient.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: contentStream,
    },
    fields: 'id, webViewLink',
  });
  return res.data;
}

function extensionFor(messageType) {
  return messageType === 'image' ? 'jpg' : 'pdf';
}

async function handleFileMessage(message, source) {
  const isFile = message.type === 'file';
  const fileName = isFile ? message.fileName : `image_${message.id}.${extensionFor('image')}`;
  const mimeType = isFile
    ? 'application/octet-stream'
    : 'image/jpeg';

  const { drive: driveClient, folderId } = await getDriveClientForSource(source);

  const contentStream = await lineClient.getMessageContent(message.id);
  const passthrough = new stream.PassThrough();
  contentStream.pipe(passthrough);

  const uploaded = await uploadToDrive(driveClient, fileName, mimeType, passthrough, folderId);
  console.log(`Uploaded "${fileName}" -> ${uploaded.webViewLink}`);
}

const APPOINTMENT_COMMAND = /^\/นัด\s+(\d{2})(\d{2})(\d{4})\s+(\d{1,2})\.(\d{2})\s+(.+)$/;

function formatBangkokDateTime(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

function parseAppointment(text) {
  const match = text.trim().match(APPOINTMENT_COMMAND);
  if (!match) return null;
  const [, day, month, year, hour, minute, label] = match;
  const eventTimeMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - BANGKOK_UTC_OFFSET_HOURS,
    Number(minute)
  );
  return { eventTimeMs, label };
}

async function handleTextMessage(event) {
  const text = event.message.text.trim();
  const groupOrUserId = event.source.groupId || event.source.userId;

  if (text === '/setup') {
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: `เชื่อมต่อ Google Drive ของคุณเองได้ที่ลิงก์นี้ (login ด้วย Google แล้วกด Allow):\n${buildSetupUrl(groupOrUserId)}`,
    });
    return;
  }

  const appointment = parseAppointment(text);
  if (!appointment) return;

  if (appointment.eventTimeMs <= Date.now()) {
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: 'เวลานัดหมายต้องเป็นเวลาในอนาคตนะครับ',
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[groupOrUserId, new Date(appointment.eventTimeMs).toISOString(), appointment.label, 'FALSE']],
    },
  });

  await lineClient.replyMessage(event.replyToken, {
    type: 'text',
    text: `✅ บันทึกนัดหมายแล้ว: ${appointment.label}\nกำหนดการ: ${formatBangkokDateTime(appointment.eventTimeMs)} น.\nจะเตือนล่วงหน้า ${REMINDER_MINUTES_BEFORE} นาทีก่อนถึงเวลา`,
  });
}

async function handleEvent(event) {
  if (event.type !== 'message') return;
  await logChatMessage(event).catch((err) => console.error('logChatMessage failed:', err));

  const { message } = event;
  if (message.type === 'image' || message.type === 'file') {
    await handleFileMessage(message, event.source);
  } else if (message.type === 'text') {
    await handleTextMessage(event);
  }
}

async function checkReminders() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: SHEET_RANGE,
  });
  const rows = res.data.values || [];
  const now = Date.now();
  const reminderWindowMs = REMINDER_MINUTES_BEFORE * 60 * 1000;

  for (let i = 0; i < rows.length; i++) {
    const [groupId, eventTimeIso, label, reminded] = rows[i];
    if (!eventTimeIso || reminded === 'TRUE') continue;

    const eventTimeMs = new Date(eventTimeIso).getTime();
    if (now >= eventTimeMs - reminderWindowMs) {
      await lineClient.pushMessage(groupId, {
        type: 'text',
        text: `⏰ เตือนความจำ: ${label}\nกำหนดการ: ${formatBangkokDateTime(eventTimeMs)} น.`,
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!D${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['TRUE']] },
      });
      console.log(`Reminded "${label}" in group ${groupId}`);
    }
  }
}

const app = express();

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get('/', (_req, res) => res.send('LINE Drive Bot is running'));

app.get('/setup', (req, res) => {
  const { groupId } = req.query;
  if (!groupId) return res.status(400).send('missing groupId');

  const url = createWebOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive'],
    state: groupId,
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code, state: groupId } = req.query;
  if (!code || !groupId) return res.status(400).send('missing code or state');

  try {
    const { tokens } = await createWebOAuthClient().getToken(code);

    const userAuth = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_WEB_CLIENT_ID,
      process.env.GOOGLE_OAUTH_WEB_CLIENT_SECRET
    );
    userAuth.setCredentials({ refresh_token: tokens.refresh_token });
    const userDrive = google.drive({ version: 'v3', auth: userAuth });

    const folder = await userDrive.files.create({
      requestBody: { name: 'LINE Bot Files', mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });

    await setDriveConfig(groupId, tokens.refresh_token, folder.data.id);
    driveClientCache.set(groupId, { drive: userDrive, folderId: folder.data.id });

    await lineClient.pushMessage(groupId, {
      type: 'text',
      text: '✅ เชื่อมต่อ Google Drive ของคุณสำเร็จ ไฟล์ในแชทนี้จากนี้ไปจะถูกเก็บใน Drive ของคุณเอง',
    });

    res.send('เชื่อมต่อสำเร็จ ปิดหน้านี้แล้วกลับไปที่ LINE ได้เลยครับ');
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.status(500).send('เชื่อมต่อไม่สำเร็จ ลองพิมพ์ /setup ใหม่อีกครั้ง');
  }
});

app.get('/cron/daily-summary', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) return res.sendStatus(401);

  try {
    await flushChatLogBuffer();

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: CHAT_LOG_RANGE,
    });
    const rows = (result.data.values || []).slice(1);

    const byGroup = new Map();
    for (const [groupId, , senderName, , text] of rows) {
      if (!byGroup.has(groupId)) byGroup.set(groupId, []);
      byGroup.get(groupId).push(`${senderName}: ${text}`);
    }

    const results = [];
    for (const [groupId, lines] of byGroup) {
      try {
        const summary = await summarizeChat(lines.join('\n'));
        await lineClient.pushMessage(groupId, { type: 'text', text: `📋 สรุปแชทวันนี้\n\n${summary}` });
        results.push({ groupId, status: 'ok' });
      } catch (err) {
        console.error(`Failed to summarize group ${groupId}:`, err);
        results.push({ groupId, status: 'error', message: err.message });
      }
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${CHAT_LOG_SHEET}!A2:E100000`,
    });

    res.json({ groupsProcessed: byGroup.size, results });
  } catch (err) {
    console.error('daily-summary failed:', err);
    res.sendStatus(500);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));

ensureDriveConfigSheet().catch((err) => console.error('Failed to ensure DriveConfig sheet:', err));
ensureChatLogSheet().catch((err) => console.error('Failed to ensure ChatLog sheet:', err));

setInterval(() => {
  checkReminders().catch((err) => console.error('Reminder check failed:', err));
}, 60 * 1000);

setInterval(() => {
  flushChatLogBuffer().catch((err) => console.error('flushChatLogBuffer failed:', err));
}, 30 * 1000);
