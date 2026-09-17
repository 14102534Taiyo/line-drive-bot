require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');
const fs = require('fs');

const PORT = 53682;
const redirectUri = `http://localhost:${PORT}/oauth2callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  redirectUri
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
});

console.log('\nเปิดลิงก์นี้ในเบราว์เซอร์แล้ว login ด้วยบัญชี Google ที่จะใช้เก็บไฟล์:\n');
console.log(authUrl);
console.log('\nรอการ login... (สคริปต์นี้จะทำงานต่อเองหลัง login เสร็จ)\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) return;

  const code = new URL(req.url, redirectUri).searchParams.get('code');
  res.end('Login สำเร็จ ปิดแท็บนี้ได้เลย กลับไปที่ terminal');
  server.close();

  const { tokens } = await oauth2Client.getToken(code);

  let env = fs.readFileSync('.env', 'utf8');
  env = env.replace(/^GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m, 'GOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
  fs.writeFileSync('.env', env);

  console.log('บันทึก GOOGLE_OAUTH_REFRESH_TOKEN ลง .env สำเร็จแล้ว');
  process.exit(0);
});

server.listen(PORT);
