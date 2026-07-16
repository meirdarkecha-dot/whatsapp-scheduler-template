import baileys, { useMultiFileAuthState, initAuthCreds, DisconnectReason, Browsers, fetchLatestBaileysVersion, BufferJSON } from '@whiskeysockets/baileys';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { google } from 'googleapis';

const makeWASocket = baileys.default || baileys;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Google Sheets ----------
const SHEET_ID = process.env.SHEET_ID || ''; // אופציונלי: מזהה Google Sheet לגיבוי (משאירים ריק אם לא בשימוש)

function getSheetsClient() {
  const creds = process.env.GOOGLE_CREDENTIALS;
  if (!creds) { log('❌ GOOGLE_CREDENTIALS missing'); return null; }
  try {
    const parsed = JSON.parse(creds);
    const auth = new google.auth.GoogleAuth({
      credentials: parsed,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (e) { log('❌ Google Sheets init err:', e.message, '| creds starts:', (creds||'').slice(0,30)); return null; }
}

async function sheetsInitHeaders() {
  const sheets = getSheetsClient();
  if (!sheets) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A1' });
    if (res.data.values?.length) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['ID', 'תאריך תזמון', 'תאריך שליחה', 'יעדים', 'תווית', 'תוכן ההודעה', 'סטטוס']] },
    });
  } catch (e) { log('❌ Sheets initHeaders err:', e.message); }
}

async function sheetsAddRow(s, groups) {
  const sheets = getSheetsClient();
  if (!sheets) return;
  try {
    const jidNames = s.jids.map(j => { const g = groups.find(x => x.jid === j); return g ? g.name : j; }).join(', ');
    const sendAt = new Date(s.sendAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[s.id, new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), sendAt, jidNames, s.label || '', s.message || '(תמונה)', '']] },
    });
    log('📊 row added to Google Sheets');
  } catch (e) { log('❌ Sheets addRow err:', e.message); }
}

async function sheetsMarkSent(id) {
  const sheets = getSheetsClient();
  if (!sheets) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A:A' });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === id);
    if (rowIndex === -1) return;
    const sentAt = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Sheet1!G${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[`✅ נשלח ${sentAt}`]] },
    });
    log('📊 marked sent in Google Sheets');
  } catch (e) { log('❌ Sheets markSent err:', e.message); }
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'auth');
const SCHEDULES_PATH = process.env.SCHEDULES_PATH || path.join(__dirname, 'schedules.json');
const GROUPS_PATH = process.env.GROUPS_PATH || path.join(path.dirname(SCHEDULES_PATH), 'groups.json');
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_PASS = process.env.GMAIL_PASS || '';
const NOTIFY_JID = process.env.NOTIFY_JID || ''; // e.g. 972501234567@s.whatsapp.net
const APP_URL = process.env.APP_URL || ''; // כתובת האפליקציה שלך ב-Railway (למשל https://xxx.up.railway.app)

fs.mkdirSync(SESSION_DIR, { recursive: true });

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11,19)}]`, ...args);
}

async function sendEmail(subject, text) {
  if (!GMAIL_USER || !GMAIL_PASS || !ALERT_EMAIL) return;
  try {
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
    await t.sendMail({ from: GMAIL_USER, to: ALERT_EMAIL, subject, text });
    log('📧 email sent:', subject);
  } catch (e) { log('email err:', e.message); }
}

let pgPool = null;

// schedules stored only in PostgreSQL (wa_session key='schedules')
// in-memory cache so sync callers work
let schedulesCache = [];

function loadSchedules() {
  return schedulesCache;
}
async function saveSchedules(list) {
  schedulesCache = list;
  if (pgPool) {
    try {
      await pgPool.query(
        'INSERT INTO wa_session(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
        ['schedules', JSON.stringify(list)]
      );
      log('📅 schedules saved to PG:', list.length, 'items');
    } catch (e) { log('❌ schedules PG save err:', e.message); }
  }
}
async function loadSchedulesPg() {
  if (!pgPool) return null;
  try {
    const { rows } = await pgPool.query('SELECT value FROM wa_session WHERE key=$1', ['schedules']);
    return rows[0] ? JSON.parse(rows[0].value) : null;
  } catch (e) { log('❌ schedules PG load err:', e.message); return null; }
}

let sock = null;
let status = 'starting';
let qrDataUrl = null;

// ---------- scheduler ----------
let schedulerRunning = false;
function startScheduler() {
  setInterval(async () => {
    if (!sock || status !== 'connected') return;
    // מנעול נגד ריצה חופפת: אם מחזור שליחה קודם עדיין פועל (למשל שליחה
    // איטית להרבה קבוצות), לדלג — אחרת אותה הודעה נשלחת פעמיים.
    if (schedulerRunning) { log('⏭ scheduler still running — skip tick'); return; }
    schedulerRunning = true;
    try {
    const now = Date.now();
    const list = loadSchedules();
    let changed = false;
    for (const s of list) {
      if (s.sent) continue;
      if (new Date(s.sendAt).getTime() > now) continue;
      // סימון נוכחות לפני מחזור השליחה — עוזר לסנכרון מפתחות ההצפנה
      // ומצמצם את "ממתין להודעה זו" אצל הנמענים. לא שולח שום הודעה גלויה.
      try { await sock.sendPresenceUpdate('available'); } catch (_) {}
      for (const jid of s.jids) {
        if (!sock || status !== 'connected') break;
        try {
          // חימום שקט: מאלץ פתיחת ערוץ הצפנה מול הקבוצה לפני ההודעה האמיתית
          try {
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 1200));
            await sock.sendPresenceUpdate('paused', jid);
          } catch (_) {}
          if (s.imageData) {
            const base64 = s.imageData.replace(/^data:image\/\w+;base64,/, '');
            const msg = { image: Buffer.from(base64, 'base64') };
            if (s.message) msg.caption = s.message;
            await sock.sendMessage(jid, msg);
          } else {
            await sock.sendMessage(jid, { text: s.message });
          }
          log('📅 sent to', jid, '|', s.label || s.message.slice(0, 40));
          // שהייה קצרה בין קבוצות — מפחית עומס ובעיות סנכרון
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) { log('send err:', jid, e.message); }
      }
      s.sent = true;
      s.sentAt = new Date().toISOString();
      changed = true;
      sheetsMarkSent(s.id).catch(() => {});
    }
    if (changed) await saveSchedules(list);
    } finally {
      schedulerRunning = false;
    }
  }, 30_000);
}

// ---------- WhatsApp ----------
let authState = null;
let saveCreds = null;
let reconnectTimer = null;
let activeSockId = 0;
let waVersion = undefined;

let pairingCode = null;
let pairingPhone = null;

function createSocket(version) {
  const myId = ++activeSockId;
  sock = makeWASocket({
    auth: authState, version,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 30_000,
    retryRequestDelayMs: 2000,
  });

  // request pairing code if phone number is set
  if (pairingPhone) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairingPhone);
        pairingCode = code;
        status = 'pairing';
        log('🔑 pairing code:', code);
      } catch (e) { log('pairing code err:', e.message); }
    }, 3000);
  }

  sock.ev.on('creds.update', async () => {
    if (myId !== activeSockId) return;
    log('💾 creds.update fired — saving...');
    try {
      await saveCreds();
      log('💾 creds.update save SUCCESS');
    } catch (e) { log('💾 creds.update save FAILED:', e.message, e.stack); }
  });

  sock.ev.on('connection.update', async (u) => {
    if (myId !== activeSockId) return; // ignore events from stale sockets
    const { connection, lastDisconnect: ld, qr } = u;
    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr);
      status = 'qr';
      log('📱 QR ready');
    }
    if (connection === 'open') {
      status = 'connected';
      qrDataUrl = null;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { await saveCreds(); log('💾 force-saved on connect'); } catch (e) { log('💾 save err on connect:', e.message); }
      // save creds every 5 minutes as a safety net
      const credsInterval = setInterval(async () => {
        if (myId !== activeSockId) { clearInterval(credsInterval); return; }
        try { await saveCreds(); log('💾 periodic creds save OK'); } catch (e) { log('💾 periodic save err:', e.message); }
      }, 5 * 60 * 1000);
      log('🟢 connected');
      // הודעת "מחובר" בוטלה לבקשת המשתמש — נשלחת רק הודעת התנתקות.
      // (אם תרצה להחזיר: בטל את ההערה מהבלוק הבא)
      // await sendEmail('✅ WhatsApp Scheduler מחובר', 'הסקדיולר מחובר ופועל.');
      // if (NOTIFY_JID) {
      //   setTimeout(async () => {
      //     try {
      //       await sock.sendMessage(NOTIFY_JID, { text: '✅ הסקדיולר מחובר ופועל!' });
      //       log('📲 WA notification sent to', NOTIFY_JID);
      //     } catch (e) { log('📲 WA notification failed:', e.message); }
      //   }, 5000);
      // }
    }
    if (connection === 'close') {
      const code = ld?.error?.output?.statusCode;
      status = 'disconnected';
      log('🔴 disconnected code:', code);
      const isLoggedOut = code === DisconnectReason.loggedOut || code === 401;
      if (isLoggedOut) {
        log('🗑 logged out — clearing session and restarting');
        await sendEmail('⚠️ WhatsApp Scheduler — נדרשת סריקת QR', `פתחי: ${APP_URL}/qr`);
        if (NOTIFY_JID) {
          try { await sock.sendMessage(NOTIFY_JID, { text: `⚠️ הסקדיולר התנתק ונדרשת סריקת QR מחדש!\nפתחי: ${APP_URL}/qr` }); } catch (_) {}
        }
        // clear local fs session (when not using Postgres)
        try {
          const files = fs.readdirSync(SESSION_DIR);
          log('🗑 deleting files:', files.join(', '));
          for (const f of files) fs.rmSync(path.join(SESSION_DIR, f), { force: true });
        } catch (_) {}
        // clear Postgres session creds/keys so a fresh QR is generated (keep 'schedules')
        if (pgPool) {
          try {
            const { rowCount } = await pgPool.query(`DELETE FROM wa_session WHERE key <> 'schedules'`);
            log(`🗑 cleared ${rowCount} session rows from PostgreSQL (kept schedules)`);
          } catch (e) { log('🗑 PG session clear failed:', e.message); }
        }
        // drop the stale in-memory creds so startBot reloads fresh ones
        authState = null;
        await startBot();
      } else {
        log('🔄 reconnecting in 5s...');
        // debounce — only one reconnect timer at a time
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          createSocket(version);
        }, 5000);
      }
    }
  });
}

// ---------- PostgreSQL auth state ----------
async function usePostgresAuthState(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_session (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  log('🐘 PostgreSQL table ready');

  const dbGet = async (key) => {
    try {
      const { rows } = await pool.query('SELECT value FROM wa_session WHERE key=$1', [key]);
      if (!rows[0]) return null;
      return JSON.parse(rows[0].value, BufferJSON.reviver);
    } catch (e) { log('❌ PG GET error:', e.message); return null; }
  };
  const dbSet = async (key, value) => {
    if (value == null) {
      await pool.query('DELETE FROM wa_session WHERE key=$1', [key]);
    } else {
      await pool.query('INSERT INTO wa_session(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value, BufferJSON.replacer)]);
    }
  };

  const credsData = await dbGet('creds');
  log('🐘 creds from DB:', credsData ? '✅ found' : '❌ not found (will show QR)');
  const creds = credsData || initAuthCreds();

  // stateObj is returned as authState — Baileys replaces stateObj.creds on every update,
  // so saveCreds must read stateObj.creds (the live reference) not the closure variable.
  const stateObj = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {};
        await Promise.all(ids.map(async id => { const v = await dbGet(`${type}:${id}`); if (v != null) out[id] = v; }));
        return out;
      },
      set: async (data) => {
        await Promise.all(Object.entries(data).flatMap(([type, entries]) =>
          Object.entries(entries || {}).map(([id, value]) => dbSet(`${type}:${id}`, value))
        ));
      }
    }
  };

  return {
    state: stateObj,
    saveCreds: async () => {
      log('💾 saving creds to PostgreSQL...');
      await dbSet('creds', stateObj.creds);
      log('💾 creds saved to PostgreSQL ✅');
    }
  };
}

async function startBot() {
  let state;
  if (process.env.DATABASE_URL) {
    log('🐘 using PostgreSQL session storage');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pgPool = pool;
    // load schedules into memory cache from PostgreSQL
    const pgSchedules = await loadSchedulesPg();
    if (pgSchedules !== null) {
      schedulesCache = pgSchedules;
      log(`📅 loaded ${pgSchedules.length} schedules from PostgreSQL`);
    }
    state = await usePostgresAuthState(pool);
  } else {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const files = fs.readdirSync(SESSION_DIR);
    log('SESSION_DIR:', SESSION_DIR, '| files:', files.length ? files.join(', ') : '(empty)');
    state = await useMultiFileAuthState(SESSION_DIR);
  }
  authState = state.state;
  saveCreds = state.saveCreds;
  _saveCreds = saveCreds;
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  waVersion = version;
  createSocket(version);
}

// graceful shutdown — lets Baileys flush creds before Railway kills the container
let _saveCreds = null;
async function gracefulShutdown(signal) {
  log(`${signal} received — saving session and schedules...`);
  try { if (_saveCreds) await _saveCreds(); } catch (_) {}
  try { if (pgPool) await saveSchedules(schedulesCache); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (e) => log('💥 uncaughtException:', e.message, e.stack));
process.on('unhandledRejection', (e) => log('💥 unhandledRejection:', e?.message || e));

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => res(d));
    req.on('error', rej);
  });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// רשימת קבוצות ברירת מחדל — ריקה בתבנית.
// אחרי חיבור הוואטסאפ, מוסיפים קבוצות דרך העמוד /groups באפליקציה (בלי לגעת בקוד).
const DEFAULT_GROUPS = [];
const GROUPS_DELETED_PATH = path.join(path.dirname(GROUPS_PATH), 'groups_deleted.json');
function loadDeletedJids() {
  try {
    const v = JSON.parse(fs.readFileSync(GROUPS_DELETED_PATH, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function saveDeletedJids(list) {
  fs.writeFileSync(GROUPS_DELETED_PATH, JSON.stringify(list, null, 2));
}

function loadGroups() {
  // מיזוג: מה שנשמר בקובץ (הוספות מהממשק) + הרשימה הקבועה בקוד, בלי כפילויות.
  // בלי המיזוג, קובץ קיים היה עוקף לגמרי את DEFAULT_GROUPS וקבוצות שנוספו בקוד לא הופיעו.
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(GROUPS_PATH, 'utf8')); } catch { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  const merged = [...saved];
  for (const d of DEFAULT_GROUPS) {
    if (!merged.find(g => g.jid === d.jid)) merged.push(d);
  }
  // קבוצות שהוסרו ידנית לא חוזרות מהרשימה הקבועה
  const deleted = loadDeletedJids();
  return merged.filter(g => !deleted.includes(g.jid));
}
function saveGroups(list) {
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(list, null, 2));
}

function renderPage(msg) {
  const schedules = loadSchedules();
  const groups = loadGroups();
  const sorted = schedules.slice().sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
  const statusColor = status === 'connected' ? '#25d366' : status === 'qr' ? '#f6ad55' : '#e53e3e';
  const statusText = status === 'connected' ? '✅ מחובר' : status === 'qr' ? '📱 ממתין לסריקת QR' : '🔴 לא מחובר';

  // קטגוריה לפי שם הקבוצה — תצוגה בלבד, לא נוגע בנתונים השמורים
  function categoryOf(name) {
    const n = name || '';
    if (n.includes('בית לתקשורת מקרבת')) return '💞 קבוצות זוגות';
    if (n.includes('אנשי טיפול') || n.includes('להיות מטפל') || n.includes('לשווק דרך הלב')) return '🌱 קבוצות מטפלים';
    if (n.includes('תוכנית הכשרה') || n.includes('מחזור') || n.includes('שנה ב') || n.includes('מובילי דרך')) return '🎓 לקוחות';
    return '📁 אחר';
  }
  const catOrder = ['💞 קבוצות זוגות', '🌱 קבוצות מטפלים', '🎓 לקוחות', '📁 אחר'];
  const byCat = {};
  for (const g of groups) { (byCat[categoryOf(g.name)] ||= []).push(g); }
  const groupCheckboxes = catOrder
    .filter(cat => byCat[cat]?.length)
    .map(cat => {
      const items = byCat[cat].map(g =>
        `<label style="display:flex;align-items:center;gap:8px;font-weight:400;margin-bottom:8px;cursor:pointer">
          <input type="checkbox" name="jids" value="${esc(g.jid)}" style="width:18px;height:18px;margin:0;cursor:pointer">
          ${esc(g.name)}
        </label>`
      ).join('');
      return `<div style="margin-bottom:14px">
        <div style="font-weight:800;font-size:14px;color:#1e3a8a;margin-bottom:6px;padding-bottom:4px;border-bottom:2px solid #1e3a8a">${esc(cat)}</div>
        ${items}
      </div>`;
    }).join('');

  const groupManageRows = groups.map(g =>
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f3f4f6">
      <span style="flex:1;font-size:13px">${esc(g.name)}</span>
      <form method="POST" action="/groups/delete" style="margin:0">
        <input type="hidden" name="jid" value="${esc(g.jid)}">
        <button type="submit" style="background:#fee2e2;color:#dc2626;border:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px">הסר</button>
      </form>
    </div>`
  ).join('');

  const pending = sorted.filter(s => !s.sent);
  const sent = sorted.filter(s => s.sent).reverse(); // newest sent first

  function renderRow(s, showDel) {
    const dt = new Date(s.sendAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const jidNames = s.jids.map(j => { const g = groups.find(x => x.jid === j); return g ? g.name : j; }).join(', ');
    const delBtn = showDel ? `<form method="POST" action="/delete" style="display:inline"><input type="hidden" name="id" value="${esc(s.id)}"><button type="submit" style="background:#fee2e2;color:#dc2626;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">מחק</button></form>` : '';
    const editBtn = showDel ? `<button onclick="editMsg(this)" data-msg="${esc(JSON.stringify(s))}" style="background:#e0f2fe;color:#0369a1;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✏️ ערוך</button>` : '';
    const imgHtml = s.imageData ? `<img src="${s.imageData}" style="max-height:100px;border-radius:6px;margin-bottom:6px;display:block">` : '';
    return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b>${esc(s.label || 'הודעה')}</b>${editBtn}${delBtn}</div>
      ${imgHtml}
      ${s.message ? `<div style="font-size:13px;color:#444;white-space:pre-wrap;word-break:break-word">${esc(s.message)}</div>` : ''}
      <div style="font-size:12px;color:#888;margin-top:6px">📅 ${dt} ישראל | יעדים: ${esc(jidNames)}</div>
    </div>`;
  }

  const pendingRows = pending.map(s => renderRow(s, true)).join('') || '<div style="text-align:center;padding:32px;color:#999">אין הודעות ממתינות</div>';
  const sentRows = sent.map(s => renderRow(s, false)).join('') || '<div style="text-align:center;padding:32px;color:#999">אין הודעות שנשלחו עדיין</div>';

  const scrollTarget = msg && msg.includes('קבוצ') ? 'groups-section' : 'scheduled';
  const scrollScript = msg ? `<script>document.getElementById('${scrollTarget}').scrollIntoView({behavior:'smooth'});</script>` : '';
  const msgHtml = msg ? `<div style="background:#dcfce7;color:#166534;padding:12px 16px;border-radius:8px;margin-bottom:16px">${esc(msg)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Scheduler ☁️</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; min-height: 100vh; }
  .header { background: #25d366; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 20px; font-weight: 600; flex: 1; }
  .container { max-width: 800px; margin: 24px auto; padding: 0 16px; }
  .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
  .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #555; margin-bottom: 6px; font-weight: 500; }
  input[type=text], input[type=datetime-local], textarea { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; direction: rtl; margin-bottom: 14px; }
  textarea { resize: vertical; min-height: 120px; white-space: pre-wrap; }
  .btn { width: 100%; padding: 14px; background: #25d366; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit; }
  .btn:hover { background: #1db954; }
  .hint { font-size: 12px; color: #999; margin-top: -10px; margin-bottom: 14px; }
  .group-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-bottom: 14px; }
</style>
</head>
<body>
<div class="header">
  <span>📅</span>
  <h1>WhatsApp Scheduler ☁️</h1>
  <span style="font-size:13px;background:${statusColor};padding:4px 12px;border-radius:20px">${statusText}</span>
</div>
<div class="container">
  ${msgHtml}
  ${(status === 'qr' || status === 'pairing' || status === 'disconnected') ? `<div class="card" style="text-align:center"><h2>📱 נדרש חיבור לוואטסאפ</h2><div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:8px"><a href="/qr" style="padding:10px 24px;background:#25d366;color:white;border-radius:8px;text-decoration:none;font-weight:600">סריקת QR</a><a href="/pair" style="padding:10px 24px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;font-weight:600">🔑 קוד חיבור (קל יותר!)</a></div></div>` : ''}
  <div class="card" id="scheduled">
    <h2>🗓 הודעות ממתינות לשליחה</h2>
    ${pendingRows}
  </div>
  <div class="card" id="add-form-card">
    <h2 id="form-title">➕ הודעה מתוזמנת חדשה</h2>
    <form method="POST" action="/add" id="msg-form">
      <input type="hidden" name="editId" id="editId" value="">
      <label>תווית (אופציונלי)</label>
      <input type="text" name="label" placeholder="למשל: ברכות שבת">
      <label>בחר יעדים (סמן אחד או יותר)</label>
      <div class="group-grid">${groupCheckboxes}</div>
      <label>או מספר אישי / JID נוסף (אופציונלי)</label>
      <input type="text" name="manualJid" placeholder="972501234567@s.whatsapp.net">
      <label>תמונה (אופציונלי)</label>
      <input type="file" id="imgPicker" accept="image/*" style="margin-bottom:4px">
      <input type="hidden" name="imageData" id="imageData">
      <div id="imgPreview" style="margin-bottom:10px"></div>
      <script>document.getElementById('imgPicker').addEventListener('change',function(){const f=this.files[0];if(!f)return;const r=new FileReader();r.onload=e=>{document.getElementById('imageData').value=e.target.result;document.getElementById('imgPreview').innerHTML='<img src="'+e.target.result+'" style="max-height:120px;border-radius:8px">';};r.readAsDataURL(f);});</script>
      <label>תוכן ההודעה (אופציונלי אם יש תמונה)</label>
      <textarea name="message" placeholder="כתבי את ההודעה כאן..."></textarea>
      <label>תאריך ושעת שליחה (שעון ישראל)</label>
      <input type="datetime-local" name="sendAt" required style="margin-bottom:4px">
      <input type="hidden" name="tz" id="tzField" value="+03:00">
      <script>try{const o=-new Date().getTimezoneOffset(),s=o>=0?'+':'-',h=String(Math.floor(Math.abs(o)/60)).padStart(2,'0'),m=String(Math.abs(o)%60).padStart(2,'0');document.getElementById('tzField').value=s+h+':'+m;}catch(e){}</script>
      <div class="hint" style="margin-bottom:14px">שעון השרת עכשיו: ${new Date().toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})}</div>
      <button type="submit" class="btn" id="submit-btn" onclick="this.textContent='⏳ שומר...'">📤 תזמן הודעה</button>
      <button type="button" id="cancel-edit-btn" onclick="cancelEdit()" style="display:none;margin-top:8px;width:100%;padding:12px;background:#f3f4f6;border:none;border-radius:8px;cursor:pointer;font-size:15px">ביטול עריכה</button>
    </form>
  </div>
  <script>
  function editMsg(btn) {
    const s = JSON.parse(btn.dataset.msg);
    document.getElementById('editId').value = s.id;
    document.getElementById('form-title').textContent = '✏️ עריכת הודעה';
    document.getElementById('submit-btn').textContent = '💾 שמור שינויים';
    document.getElementById('cancel-edit-btn').style.display = 'block';
    document.querySelector('[name=label]').value = s.label || '';
    document.querySelector('[name=message]').value = s.message || '';
    if (s.imageData) {
      document.getElementById('imageData').value = s.imageData;
      document.getElementById('imgPreview').innerHTML = '<img src="'+s.imageData+'" style="max-height:120px;border-radius:8px">';
    }
    const dt = new Date(s.sendAt);
    const local = new Date(dt.getTime() - dt.getTimezoneOffset()*60000).toISOString().slice(0,16);
    document.querySelector('[name=sendAt]').value = local;
    // check matching jids
    document.querySelectorAll('[name=jids]').forEach(cb => { cb.checked = s.jids.includes(cb.value); });
    document.getElementById('add-form-card').scrollIntoView({behavior:'smooth'});
  }
  function cancelEdit() {
    document.getElementById('editId').value = '';
    document.getElementById('form-title').textContent = '➕ הודעה מתוזמנת חדשה';
    document.getElementById('submit-btn').textContent = '📤 תזמן הודעה';
    document.getElementById('cancel-edit-btn').style.display = 'none';
    document.getElementById('msg-form').reset();
    document.getElementById('imgPreview').innerHTML = '';
  }
  </script>
  <div class="card" id="groups-section">
    <h2>👥 ניהול קבוצות</h2>
    ${groupManageRows || '<p style="color:#999;font-size:13px">אין קבוצות</p>'}
    <form method="POST" action="/groups/add" style="margin-top:16px">
      <label>שם הקבוצה</label>
      <input type="text" name="name" placeholder="למשל: בית לתקשורת מקרבת 6" required>
      <label>JID של הקבוצה</label>
      <input type="text" name="jid" placeholder="120363xxxxxx@g.us" required dir="ltr">
      <button type="submit" class="btn" style="background:#6366f1" onclick="this.textContent='⏳ שומר...'">➕ הוסף קבוצה</button>
    </form>
  </div>
  <div class="card" id="archive">
    <h2>✅ הודעות שנשלחו</h2>
    ${sentRows}
  </div>
  <div class="card">
    <h2>📊 Google Sheets</h2>
    <p style="font-size:13px;color:#555;margin-bottom:12px">ייצא את כל ההודעות (ממתינות ונשלחות) לגיליון Google Sheets</p>
    <form method="POST" action="/export-sheets">
      <button type="submit" class="btn" style="background:#0f9d58" onclick="this.textContent='⏳ מייצא...'">📤 ייצא הכל לגיליון</button>
    </form>
    ${SHEET_ID ? `<a href="https://docs.google.com/spreadsheets/d/${SHEET_ID}" target="_blank" style="display:inline-block;margin-top:12px;color:#0f9d58;font-size:14px">📋 פתח את הגיליון</a>` : ''}
  </div>
</div>
${scrollScript}
</body>
</html>`;
}

http.createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/index.html' || req.url?.startsWith('/?')) {
      const url = new URL(req.url, 'http://localhost');
      const msg = url.searchParams.get('msg') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderPage(msg));
    }

    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status, qr: qrDataUrl }));
    }

    if (req.url === '/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>סריקת QR</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}img{border:1px solid #ddd;border-radius:8px;max-width:280px;display:block;margin:16px auto}#status{font-size:14px;color:#555;margin:12px 0}#qr-wrap{min-height:300px;display:flex;align-items:center;justify-content:center;flex-direction:column}</style></head><body><h2>📱 סריקת QR</h2><div id="qr-wrap"><p id="status">ממתינה ל-QR...</p></div><p style="color:#555;font-size:13px;margin-top:8px">WhatsApp ← הגדרות ← מכשירים מקושרים ← קישור מכשיר</p><a href="/">← חזרה</a><script>
let lastQr = null;
async function poll() {
  try {
    const r = await fetch('/state');
    const d = await r.json();
    if (d.status === 'connected') {
      window.location.href = '/?msg=' + encodeURIComponent('✅ מחובר בהצלחה!');
      return;
    }
    const wrap = document.getElementById('qr-wrap');
    if (d.qr && d.qr !== lastQr) {
      lastQr = d.qr;
      wrap.innerHTML = '<img src="' + d.qr + '"><p id="status" style="color:#25d366;font-weight:600">QR מוכן — סרקי עכשיו!</p>';
    } else if (!d.qr) {
      wrap.innerHTML = '<p id="status">ממתינה ל-QR...</p>';
    }
  } catch(e) {}
  setTimeout(poll, 2000);
}
poll();
</script></body></html>`);
    }

    if (req.url === '/add' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const checkedJids = params.getAll('jids').map(j => j.trim()).filter(Boolean);
      const manualJid = (params.get('manualJid') || '').trim();
      if (manualJid) checkedJids.push(manualJid);
      const jids = [...new Set(checkedJids)];
      const message = (params.get('message') || '').trim();
      const sendAt = (params.get('sendAt') || '').trim();
      const tz = (params.get('tz') || '+03:00').trim();
      const label = (params.get('label') || '').trim();
      const imageData = (params.get('imageData') || '').trim();
      const editId = (params.get('editId') || '').trim();
      if (!jids.length || (!message && !imageData) || !sendAt) {
        res.writeHead(302, { Location: '/?msg=' + encodeURIComponent('שגיאה: יש לבחור יעד, למלא הודעה או תמונה, ושעה') });
        return res.end();
      }
      const sendAtMs = new Date(sendAt + ':00' + tz).getTime();
      if (isNaN(sendAtMs) || sendAtMs < Date.now() - 300_000) {
        res.writeHead(302, { Location: '/?msg=' + encodeURIComponent('שגיאה: יש לבחור זמן עתידי') });
        return res.end();
      }
      const list = loadSchedules();
      if (editId) {
        const idx = list.findIndex(s => s.id === editId);
        if (idx !== -1) {
          list[idx] = { ...list[idx], jids, message, imageData: imageData || null, sendAt: new Date(sendAtMs).toISOString(), label };
          await saveSchedules(list);
          log('✏️ edited:', label || message.slice(0, 30));
          res.writeHead(302, { Location: '/?msg=' + encodeURIComponent('✅ ההודעה עודכנה!') });
          return res.end();
        }
      }
      list.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        jids,
        message,
        imageData: imageData || null,
        sendAt: new Date(sendAtMs).toISOString(),
        label,
        sent: false,
        createdAt: new Date().toISOString()
      });
      const newItem = list[list.length - 1];
      await saveSchedules(list);
      log('📅 scheduled:', label || message.slice(0, 30), 'at', sendAt, '| cache:', schedulesCache.length, '| pgPool:', !!pgPool);
      sheetsAddRow(newItem, loadGroups()).catch(() => {});
      res.writeHead(302, { Location: '/?msg=' + encodeURIComponent(`✅ ההודעה תוזמנה! (${schedulesCache.length} בזיכרון)`) });
      return res.end();
    }

    if (req.url === '/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const id = params.get('id');
      await saveSchedules(loadSchedules().filter(s => s.id !== id));
      res.writeHead(302, { Location: '/?msg=' + encodeURIComponent('נמחק') });
      return res.end();
    }

    if (req.url === '/groups/add' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const name = (params.get('name') || '').trim();
      const jid = (params.get('jid') || '').trim();
      if (name && jid) {
        // אם הוסרה בעבר — לבטל את סימון ההסרה כדי שתחזור להופיע
        const deleted = loadDeletedJids();
        if (deleted.includes(jid)) saveDeletedJids(deleted.filter(d => d !== jid));
        const list = loadGroups();
        if (!list.find(g => g.jid === jid)) { list.push({ jid, name }); saveGroups(list); }
      }
      res.writeHead(302, { Location: '/?msg=' + encodeURIComponent('✅ הקבוצה נוספה!') });
      return res.end();
    }

    if (req.url === '/pair') {
      const code = pairingCode;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>קוד חיבור</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}.code{font-size:48px;font-weight:800;letter-spacing:12px;color:#25d366;margin:24px 0;font-family:monospace}.card{background:white;border-radius:12px;padding:32px;max-width:420px;margin:0 auto;box-shadow:0 1px 4px rgba(0,0,0,.1)}</style></head><body>
<div class="card">
<h2>🔑 קוד חיבור לוואטסאפ</h2>
${code ? `<div class="code">${code}</div>
<p style="color:#555;font-size:14px">פתחי וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← קישור עם מספר טלפון</p>
<p style="color:#999;font-size:12px;margin-top:8px">הקוד תקף לכמה דקות</p>` : `
<p style="color:#555;margin-bottom:20px">הכניסי את מספר הטלפון שלך (עם קידומת מדינה, ללא +)</p>
<form method="POST" action="/pair/request">
<input type="tel" name="phone" placeholder="972586120852" dir="ltr" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:18px;text-align:center;margin-bottom:12px">
<button type="submit" style="width:100%;padding:14px;background:#6366f1;color:white;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer">קבלי קוד</button>
</form>`}
</div>
<a href="/" style="display:inline-block;margin-top:16px;color:#25d366">← חזרה</a>
<script>if(${!!code}) setTimeout(() => fetch('/state').then(r=>r.json()).then(d => { if(d.status==='connected') window.location.href='/?msg='+encodeURIComponent('✅ מחובר!'); }), 3000);</script>
</body></html>`);
    }

    if (req.url === '/pair/request' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const phone = (params.get('phone') || '').replace(/\D/g, '');
      if (!phone) { res.writeHead(302, { Location: '/pair' }); return res.end(); }
      pairingPhone = phone;
      pairingCode = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      activeSockId++; // invalidate old socket
      setTimeout(() => createSocket(waVersion), 1000);
      res.writeHead(302, { Location: '/pair' });
      return res.end();
    }

    if (req.url === '/groups/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const jid = (params.get('jid') || '').trim();
      saveGroups(loadGroups().filter(g => g.jid !== jid));
      // לזכור שהוסרה, כדי שלא תחזור מהרשימה הקבועה שבקוד
      const deleted = loadDeletedJids();
      if (jid && !deleted.includes(jid)) saveDeletedJids([...deleted, jid]);
      res.writeHead(302, { Location: '/?msg=' + encodeURIComponent('הקבוצה הוסרה') });
      return res.end();
    }

    if (req.url === '/groups') {
      // fetch live groups from WhatsApp if connected
      let allGroups = [];
      if (sock && status === 'connected') {
        try {
          const wGroups = await sock.groupFetchAllParticipating();
          allGroups = Object.values(wGroups)
            .map(g => ({ jid: g.id, name: g.subject, size: g.participants?.length || 0 }))
            .sort((a, b) => a.name.localeCompare(b.name, 'he'));
        } catch (e) { log('groupFetch err:', e.message); }
      }
      const rows = allGroups.length
        ? allGroups.map(g =>
            `<tr>
              <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0"><b>${esc(g.name)}</b></td>
              <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#666;direction:ltr">${esc(g.jid)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#999;text-align:center">${g.size}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0">
                <form method="POST" action="/groups/add" style="margin:0;display:flex;gap:6px">
                  <input type="hidden" name="name" value="${esc(g.name)}">
                  <input type="hidden" name="jid" value="${esc(g.jid)}">
                  <button type="submit" style="background:#25d366;color:white;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px">+ הוסף</button>
                </form>
              </td>
            </tr>`
          ).join('')
        : `<tr><td colspan="4" style="padding:32px;text-align:center;color:#999">${status !== 'connected' ? 'הבוט לא מחובר — חברי WhatsApp קודם' : 'לא נמצאו קבוצות'}</td></tr>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>כל הקבוצות</title><style>body{font-family:'Segoe UI',sans-serif;background:#f0f2f5;padding:24px}h2{margin-bottom:8px}table{background:white;border-radius:12px;border-collapse:collapse;width:100%;max-width:900px;box-shadow:0 1px 4px rgba(0,0,0,.1)}th{background:#25d366;color:white;padding:12px;text-align:right}a{display:inline-block;margin-top:16px;color:#25d366}input[type=text]{padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:200px}</style></head><body><h2>👥 כל הקבוצות שלי (${allGroups.length})</h2><p style="color:#666;margin-bottom:16px;font-size:13px">לחצי "+ הוסף" כדי להוסיף קבוצה לרשימת התזמון</p><table><tr><th>שם קבוצה</th><th>JID</th><th>חברים</th><th>הוסף</th></tr>${rows}</table><a href="/">← חזרה לתזמון</a></body></html>`);
    }

    if (req.url === '/export-sheets' && req.method === 'POST') {
      try {
        const list = loadSchedules();
        const groups = loadGroups();
        await sheetsInitHeaders();
        for (const s of list) {
          await sheetsAddRow(s, groups);
          if (s.sent) await sheetsMarkSent(s.id);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`✅ יוצאו ${list.length} הודעות לגיליון!`);
      } catch (e) { res.writeHead(200); return res.end('❌ שגיאה: ' + e.message); }
    }

    if (req.url === '/sheets-debug') {
      try {
        const credsEnv = process.env.GOOGLE_CREDENTIALS;
        if (!credsEnv) { res.writeHead(200); return res.end('❌ GOOGLE_CREDENTIALS לא מוגדר'); }
        const credsRaw = process.env.GOOGLE_CREDENTIALS || '';
        let parsedOk = false;
        let parseErr = '';
        try { JSON.parse(credsRaw); parsedOk = true; } catch(e) { parseErr = e.message; }
        const sheets = getSheetsClient();
        if (!sheets) { res.writeHead(200); return res.end(`❌ getSheetsClient החזיר null\ncreds length: ${credsRaw.length}\nparse ok: ${parsedOk}\nparse err: ${parseErr}\nstarts: ${credsRaw.slice(0,50)}`); }
        // try to read sheet
        const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A1:G1' });
        const list = loadSchedules();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`✅ Sheets מחובר!\nכותרות: ${JSON.stringify(r.data.values)}\nהודעות בזיכרון: ${list.length}`);
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('❌ שגיאה: ' + e.message);
      }
    }

    if (req.url === '/schedules-debug') {
      const cacheList = loadSchedules();
      const pgList = await loadSchedulesPg();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`Cache: ${cacheList.length} הודעות\nPG: ${pgList ? pgList.length : 'null'} הודעות\npgPool: ${pgPool ? 'מחובר' : 'null'}\n\nפרטים:\n${JSON.stringify(cacheList.map(s=>({id:s.id,label:s.label,sent:s.sent,sendAt:s.sendAt})),null,2)}`);
    }

    if (req.url === '/force-save') {
      if (!saveCreds) { res.writeHead(200); return res.end('saveCreds not ready'); }
      try {
        await saveCreds();
        const list = loadSchedules();
        await saveSchedules(list);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`✅ Saved! creds + ${list.length} schedules`);
      } catch (e) { res.writeHead(200); return res.end('❌ Save error: ' + e.message + '\n' + e.stack); }
    }

    // Force a fresh QR: clears stale WhatsApp session (keeps 'schedules') and restarts the socket.
    // Use when stuck on "ממתינה ל-QR..." after a WhatsApp-side logout. Requires ?confirm=yes.
    if (req.url?.startsWith('/reset-session')) {
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('confirm') !== 'yes') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><title>איפוס חיבור</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}.card{background:#fff;border-radius:12px;padding:32px;max-width:460px;margin:0 auto;box-shadow:0 1px 4px rgba(0,0,0,.1)}a.btn{display:inline-block;margin-top:16px;background:#e53e3e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600}</style></head><body><div class="card"><h2>🔄 איפוס חיבור וואטסאפ</h2><p style="color:#555">פעולה זו תמחק את ה-session הישן (ה-creds הפגומים) ותפיק QR חדש.<br><b>ההודעות המתוזמנות שלך יישמרו.</b></p><a class="btn" href="/reset-session?confirm=yes">כן, אפס וצור QR חדש</a><p style="margin-top:16px"><a href="/">← ביטול</a></p></div></body></html>`);
      }
      log('🔄 /reset-session triggered — clearing session');
      activeSockId++; // invalidate the current (looping) socket
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try {
        const files = fs.readdirSync(SESSION_DIR);
        for (const f of files) fs.rmSync(path.join(SESSION_DIR, f), { force: true });
      } catch (_) {}
      let cleared = 0;
      if (pgPool) {
        try {
          const r = await pgPool.query(`DELETE FROM wa_session WHERE key <> 'schedules'`);
          cleared = r.rowCount;
        } catch (e) { log('🔄 reset PG clear failed:', e.message); }
      }
      authState = null;
      qrDataUrl = null;
      status = 'disconnected';
      pairingPhone = null;
      pairingCode = null;
      await startBot();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"><title>אופס...</title><meta http-equiv="refresh" content="3;url=/qr"></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ ה-session אופס (${cleared} שורות נמחקו, ההודעות נשמרו)</h2><p>מעביר אותך לדף ה-QR... סרוק את הקוד החדש.</p><a href="/qr">לדף ה-QR ←</a></body></html>`);
    }

    if (req.url === '/check-db') {
      if (!process.env.DATABASE_URL) { res.writeHead(200); return res.end('No DATABASE_URL set'); }
      try {
        const pool2 = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        const { rows } = await pool2.query('SELECT key, length(value::text) as size FROM wa_session ORDER BY key');
        await pool2.end();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(rows.length ? rows.map(r => `${r.key}: ${r.size} chars`).join('\n') : 'Table empty — no session saved yet');
      } catch (e) { res.writeHead(200); return res.end('DB error: ' + e.message); }
    }

    if (req.url === '/test-save') {
      if (!process.env.DATABASE_URL) { res.writeHead(200); return res.end('No DATABASE_URL set'); }
      try {
        const pool2 = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await pool2.query(`CREATE TABLE IF NOT EXISTS wa_session (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
        await pool2.query(`INSERT INTO wa_session(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, ['test-ping', JSON.stringify({ ts: Date.now() })]);
        const { rows } = await pool2.query('SELECT key, length(value::text) as size FROM wa_session ORDER BY key');
        await pool2.end();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('✅ Write OK!\n\nRows:\n' + rows.map(r => `${r.key}: ${r.size} chars`).join('\n'));
      } catch (e) { res.writeHead(200); return res.end('❌ DB write error: ' + e.message); }
    }

    res.writeHead(404); res.end();
  } catch (e) {
    log('http err:', e.message);
    try { res.writeHead(302, { Location: '/?msg=' + encodeURIComponent('שגיאה: ' + e.message) }); res.end(); } catch (_) {}
  }
}).listen(PORT, () => log(`🌐 http://localhost:${PORT}`));

startScheduler();
startBot().catch(e => log('fatal:', e.message));
