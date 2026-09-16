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

const driveAuth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/drive']
);
const drive = google.drive({ version: 'v3', auth: driveAuth });

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

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { message } = event;
  if (message.type !== 'image' && message.type !== 'file') return;

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
