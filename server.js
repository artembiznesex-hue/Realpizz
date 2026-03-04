/**
 * OkakPix — Pixel Battle Multiplayer Server
 * Node.js + WebSocket (ws) + Express
 *
 * Запуск: node server.js
 * Порт:   3000 (або PORT з env)
 */

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT     = process.env.PORT || 3000;
const CANVAS_W = 1000;
const CANVAS_H = 1000;
const MAX_STACK = 120;
const REGEN_INTERVAL_MS = 1000; // +1 піксель/сек

// ── ADMIN ACCOUNT ──────────────────────────────────────────
const ADMIN_USERS = {
  admin: { password: 'admin', noCooldown: true }
};

// ── CANVAS STATE ────────────────────────────────────────────
// Зберігаємо полотно як RGBA Buffer
let canvasBuffer = Buffer.alloc(CANVAS_W * CANVAS_H * 4, 0);

// Завантаження earth.png → у буфер
function loadEarth() {
  const earthPath = path.join(__dirname, 'earth.png');
  if (!fs.existsSync(earthPath)) {
    console.log('[OkakPix] earth.png не знайдено, полотно порожнє');
    return;
  }
  // Читаємо PNG пікселі через sharp (якщо є) або raw
  try {
    const sharp = require('sharp');
    sharp(earthPath)
      .resize(CANVAS_W, CANVAS_H, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => {
        // info.channels може бути 3 або 4
        for (let i = 0; i < CANVAS_W * CANVAS_H; i++) {
          const si = i * info.channels;
          const di = i * 4;
          canvasBuffer[di]   = data[si];
          canvasBuffer[di+1] = data[si+1];
          canvasBuffer[di+2] = data[si+2];
          canvasBuffer[di+3] = 255;
        }
        console.log(`[OkakPix] earth.png завантажено (${info.width}x${info.height})`);
      })
      .catch(e => console.error('[OkakPix] sharp error:', e.message));
  } catch(e) {
    console.log('[OkakPix] sharp недоступний, полотно без earth.png');
  }
}

// Збереження полотна кожні 30 секунд
function saveCanvas() {
  try {
    fs.writeFileSync(
      path.join(__dirname, 'canvas_state.bin'),
      canvasBuffer
    );
  } catch(e) {}
}

function loadCanvasState() {
  const p = path.join(__dirname, 'canvas_state.bin');
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    if (buf.length === canvasBuffer.length) {
      buf.copy(canvasBuffer);
      console.log('[OkakPix] canvas_state.bin відновлено');
      return true;
    }
  }
  return false;
}

// ── SESSIONS ────────────────────────────────────────────────
const sessions = new Map(); // token → { username, noCooldown }
const users    = new Map(); // username → { password }

// Завантаження users.json
const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      for (const [k,v] of Object.entries(data)) users.set(k, v);
    } catch(e) {}
  }
  // Додаємо admin якщо нема
  if (!users.has('admin')) users.set('admin', { password: 'admin', noCooldown: true });
}
function saveUsers() {
  const obj = {};
  for (const [k,v] of users) obj[k]=v;
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
}

// ── WS CLIENTS ──────────────────────────────────────────────
const clients = new Map(); // ws → { username, stack, lastRegen, noCooldown, ip }

function broadcast(msg, except) {
  const str = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) {
      ws.send(str);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getOnlineCount() { return clients.size; }

// ── PIXEL LOGIC ─────────────────────────────────────────────
function setPixel(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) return false;
  const idx = (y * CANVAS_W + x) * 4;
  canvasBuffer[idx]   = r;
  canvasBuffer[idx+1] = g;
  canvasBuffer[idx+2] = b;
  canvasBuffer[idx+3] = 255;
  return true;
}

// ── HTTP ROUTES ─────────────────────────────────────────────
app.use(express.static(__dirname)); // index.html, earth.png

// Повне полотно як PNG (через sharp якщо є, інакше raw RGBA)
app.get('/canvas.png', (req, res) => {
  try {
    const sharp = require('sharp');
    sharp(Buffer.from(canvasBuffer), {
      raw: { width: CANVAS_W, height: CANVAS_H, channels: 4 }
    })
    .png()
    .toBuffer()
    .then(buf => {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(buf);
    })
    .catch(() => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(canvasBuffer);
    });
  } catch(e) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(canvasBuffer);
  }
});

// Полотно як raw RGBA bytes (швидко)
app.get('/canvas.raw', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Canvas-Width', CANVAS_W);
  res.setHeader('X-Canvas-Height', CANVAS_H);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(canvasBuffer);
});

// ── WEBSOCKET ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const client = { username: null, stack: MAX_STACK, lastRegen: Date.now(), noCooldown: false, ip };
  clients.set(ws, client);

  console.log(`[WS] Connect from ${ip}, total: ${clients.size}`);

  // Надіслати поточний розмір полотна
  sendTo(ws, { type: 'init', width: CANVAS_W, height: CANVAS_H });

  // Оновити онлайн для всіх
  broadcast({ type: 'online', count: getOnlineCount() });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    switch(msg.type) {

      // ── AUTH ──
      case 'login': {
        const { username, password } = msg;
        if (!username || !password) { sendTo(ws, { type: 'auth_fail', reason: 'Заповніть всі поля' }); return; }
        const u = users.get(username);
        if (!u) { sendTo(ws, { type: 'auth_fail', reason: 'Користувача не знайдено' }); return; }
        if (u.password !== password) { sendTo(ws, { type: 'auth_fail', reason: 'Невірний пароль' }); return; }
        client.username = username;
        client.noCooldown = !!u.noCooldown;
        client.stack = client.noCooldown ? 999999 : MAX_STACK;
        sendTo(ws, { type: 'auth_ok', username, noCooldown: client.noCooldown, stack: client.stack });
        broadcast({ type: 'online', count: getOnlineCount() });
        console.log(`[AUTH] Login: ${username} (noCooldown=${client.noCooldown})`);
        break;
      }

      case 'register': {
        const { username, password } = msg;
        if (!username || !password) { sendTo(ws, { type: 'auth_fail', reason: 'Заповніть всі поля' }); return; }
        if (username.length < 3) { sendTo(ws, { type: 'auth_fail', reason: 'Нікнейм мінімум 3 символи' }); return; }
        if (password.length < 4) { sendTo(ws, { type: 'auth_fail', reason: 'Пароль мінімум 4 символи' }); return; }
        if (users.has(username)) { sendTo(ws, { type: 'auth_fail', reason: 'Нікнейм вже зайнятий' }); return; }
        users.set(username, { password, noCooldown: false });
        saveUsers();
        client.username = username;
        client.noCooldown = false;
        client.stack = MAX_STACK;
        sendTo(ws, { type: 'auth_ok', username, noCooldown: false, stack: MAX_STACK });
        broadcast({ type: 'online', count: getOnlineCount() });
        console.log(`[AUTH] Register: ${username}`);
        break;
      }

      // ── PIXEL ──
      case 'pixel': {
        if (!client.username) { sendTo(ws, { type: 'error', reason: 'Потрібна авторизація' }); return; }

        // Відновлення стаку
        if (!client.noCooldown) {
          const now = Date.now();
          const toAdd = Math.floor((now - client.lastRegen) / REGEN_INTERVAL_MS);
          if (toAdd > 0) {
            client.stack = Math.min(MAX_STACK, client.stack + toAdd);
            client.lastRegen = now - ((now - client.lastRegen) % REGEN_INTERVAL_MS);
          }
          if (client.stack <= 0) {
            sendTo(ws, { type: 'stack_empty' });
            return;
          }
          client.stack--;
        }

        const { x, y, color } = msg;
        // color = '#RRGGBB'
        const r = parseInt(color.slice(1,3), 16);
        const g = parseInt(color.slice(3,5), 16);
        const b = parseInt(color.slice(5,7), 16);

        if (!setPixel(x, y, r, g, b)) return;

        const pixMsg = { type: 'pixel', x, y, color, by: client.username };
        // Відправити всім (включаючи автора для підтвердження)
        const str = JSON.stringify(pixMsg);
        for (const [cws] of clients) {
          if (cws.readyState === WebSocket.OPEN) cws.send(str);
        }

        // Оновити стак автору
        if (!client.noCooldown) {
          sendTo(ws, { type: 'stack_update', stack: client.stack });
        }
        break;
      }

      // ── REQUEST CANVAS CHUNK ──
      case 'request_canvas': {
        // Надіслати весь канвас як base64 chunks
        const CHUNK = 50000; // пікселів за раз
        const total = CANVAS_W * CANVAS_H;
        let offset = 0;
        let chunkIdx = 0;
        const totalChunks = Math.ceil(total / CHUNK);

        function sendChunk() {
          if (offset >= total) return;
          const end = Math.min(offset + CHUNK, total);
          const slice = canvasBuffer.slice(offset*4, end*4);
          sendTo(ws, {
            type: 'canvas_chunk',
            offset,
            data: slice.toString('base64'),
            chunkIdx,
            totalChunks,
            width: CANVAS_W,
            height: CANVAS_H
          });
          offset = end;
          chunkIdx++;
          setImmediate(sendChunk);
        }
        sendChunk();
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ type: 'online', count: getOnlineCount() });
    console.log(`[WS] Disconnect, total: ${clients.size}`);
  });

  ws.on('error', () => clients.delete(ws));
});

// ── SAVE LOOP ────────────────────────────────────────────────
setInterval(saveCanvas, 30000);

// ── START ────────────────────────────────────────────────────
loadUsers();
if (!loadCanvasState()) loadEarth();

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║        OkakPix Pixel Battle          ║
║  http://localhost:${PORT}              ║
║  Admin: admin / admin                ║
╚══════════════════════════════════════╝
  `);
});
