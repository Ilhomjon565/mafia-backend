// ==================== WATCHDOG (alohida service) ====================
// mafia-backend /health ni muntazam tekshiradi. Agar process OSILIB qolsa
// (javob bermasa) — pm2 buni sezmaydi (faqat crash'ni sezadi), shuning uchun
// biz uni avtomatik restart qilamiz. Bu process juda yengil (~10MB).

const http = require('http');
const { exec } = require('child_process');

const URL = process.env.WATCH_URL || 'http://localhost:4100/health';
const APP = process.env.WATCH_APP || 'mafia-backend';
const INTERVAL_MS = parseInt(process.env.WATCH_INTERVAL || '15000');
const TIMEOUT_MS = parseInt(process.env.WATCH_TIMEOUT || '8000');
const MAX_FAILS = parseInt(process.env.WATCH_MAX_FAILS || '3');

let fails = 0;
let restarting = false;

function log(msg) {
  console.log(`[watchdog ${new Date().toISOString()}] ${msg}`);
}

function restartApp(reason) {
  if (restarting) return;
  restarting = true;
  log(`🔁 ${APP} qayta ishga tushirilmoqda — sabab: ${reason}`);
  exec(`pm2 restart ${APP} --update-env`, (err, stdout, stderr) => {
    if (err) log(`restart xato: ${err.message}`);
    else log(`✅ ${APP} restart qilindi`);
    fails = 0;
    // restartdan keyin 30s "sovish" — darrov qayta restart qilmaymiz
    setTimeout(() => { restarting = false; }, 30000);
  });
}

function check() {
  if (restarting) return;
  const req = http.get(URL, { timeout: TIMEOUT_MS }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      if (res.statusCode === 200 && body.includes('ok')) {
        if (fails > 0) log(`sog'lom (avval ${fails} marta xato edi)`);
        fails = 0;
      } else {
        onFail(`status ${res.statusCode}`);
      }
    });
  });
  req.on('timeout', () => { req.destroy(); onFail('timeout (osilib qolgan)'); });
  req.on('error', (e) => onFail(e.message));
}

function onFail(reason) {
  fails++;
  log(`⚠️ health xato (${fails}/${MAX_FAILS}): ${reason}`);
  if (fails >= MAX_FAILS) restartApp(reason);
}

setInterval(check, INTERVAL_MS);
check();
log(`ishga tushdi — ${URL} kuzatilmoqda (har ${INTERVAL_MS / 1000}s)`);
