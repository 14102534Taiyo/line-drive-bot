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
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 30);
const BANGKOK_UTC_OFFSET_HOURS = 7;

async function uploadToDrive(fileName, mimeType, contentStream) {
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
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

async function handleFileMessage(message) {
  const isFile = message.type === 'file';
  const fileName = isFile ? message.fileName : `image_${message.id}.${extensionFor('image')}`;
  const mimeType = isFile
    ? 'application/octet-stream'
    : 'image/jpeg';

  const contentStream = await lineClient.getMessageContent(message.id);
  const passthrough = new stream.PassThrough();
  contentStream.pipe(passthrough);

  const uploaded = await uploadToDrive(fileName, mimeType, passthrough);
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
  const appointment = parseAppointment(event.message.text);
  if (!appointment) return;

  if (appointment.eventTimeMs <= Date.now()) {
    await lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: 'เวลานัดหมายต้องเป็นเวลาในอนาคตนะครับ',
    });
    return;
  }

  const groupId = event.source.groupId || event.source.userId;
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[groupId, new Date(appointment.eventTimeMs).toISOString(), appointment.label, 'FALSE']],
    },
  });

  await lineClient.replyMessage(event.replyToken, {
    type: 'text',
    text: `✅ บันทึกนัดหมายแล้ว: ${appointment.label}\nกำหนดการ: ${formatBangkokDateTime(appointment.eventTimeMs)} น.\nจะเตือนล่วงหน้า ${REMINDER_MINUTES_BEFORE} นาทีก่อนถึงเวลา`,
  });
}

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { message } = event;
  if (message.type === 'image' || message.type === 'file') {
    await handleFileMessage(message);
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));

setInterval(() => {
  checkReminders().catch((err) => console.error('Reminder check failed:', err));
}, 60 * 1000);
