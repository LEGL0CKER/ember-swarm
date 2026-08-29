// Ember Swarm server: static files + a small global-leaderboard API (Postgres).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/* ---------- database (optional; API disabled if absent) ---------- */
let pool = null;
const DB_URL = process.env.DATABASE_URL;
if (DB_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DB_URL,
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    pool.query(
      `CREATE TABLE IF NOT EXISTS scores(
        token TEXT PRIMARY KEY, name TEXT, avatar JSONB,
        score INT, time INT, kills INT, level INT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`
    ).then(() => {
      console.log('DB ready');
      // one-off cleanup of setup test rows (fake tokens; never returned by real clients)
      pool.query("DELETE FROM scores WHERE token IN ('testtoken1','tok2')").catch(() => {});
    }).catch(e => console.error('DB init error', e.message));
  } catch (e) { console.error('pg load error', e.message); }
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const clampInt = (v, lo, hi) => { v = Math.floor(Number(v) || 0); return Math.max(lo, Math.min(hi, v)); };

function handleApi(req, res, urlPath) {
  if (!pool) return sendJSON(res, 503, { error: 'db_unavailable' });

  if (req.method === 'GET' && urlPath === '/api/leaderboard') {
    pool.query('SELECT name,avatar,score,time,kills,level FROM scores ORDER BY score DESC LIMIT 50')
      .then(r => sendJSON(res, 200, { board: r.rows }))
      .catch(() => sendJSON(res, 500, { error: 'query_failed' }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/score') {
    let body = '', tooBig = false;
    req.on('data', c => { body += c; if (body.length > 4000) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return sendJSON(res, 413, { error: 'too_large' });
      let d; try { d = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      const token = String(d.token || '').slice(0, 64);
      if (!token) return sendJSON(res, 400, { error: 'no_token' });
      const name = String(d.name || 'Player').slice(0, 16);
      const score = clampInt(d.score, 0, 10000000);
      const time = clampInt(d.time, 0, 86400);
      const kills = clampInt(d.kills, 0, 1000000);
      const level = clampInt(d.level, 0, 10000);
      let avatar = '{}'; try { avatar = JSON.stringify(d.avatar || {}); } catch (e) {}
      pool.query(
        `INSERT INTO scores(token,name,avatar,score,time,kills,level,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT(token) DO UPDATE SET
           name=EXCLUDED.name, avatar=EXCLUDED.avatar, score=EXCLUDED.score,
           time=EXCLUDED.time, kills=EXCLUDED.kills, level=EXCLUDED.level, updated_at=now()
         WHERE EXCLUDED.score > scores.score`,
        [token, name, avatar, score, time, kills, level]
      ).then(() => sendJSON(res, 200, { ok: true }))
       .catch(() => sendJSON(res, 500, { error: 'insert_failed' }));
    });
    req.on('error', () => { try { sendJSON(res, 400, { error: 'req_error' }); } catch (_) {} });
    return;
  }
  return sendJSON(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);

  const filePath = path.join(ROOT, path.normalize(urlPath === '/' ? '/index.html' : urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------- Duos: WebSocket relay (host-authoritative rooms) ---------- */
try {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server, path: '/duo' });
  const rooms = new Map(); // CODE -> { host, guest }
  const code4 = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 4; i++) c += A[(Math.random() * A.length) | 0]; return c; };
  const send = (ws, obj) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } };
  wss.on('connection', ws => {
    ws.room = null; ws.role = null; ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t === 'create') {
        if (ws.room) return;
        let c; let guard = 0; do { c = code4(); } while (rooms.has(c) && ++guard < 50);
        rooms.set(c, { host: ws, guest: null }); ws.room = c; ws.role = 'host';
        send(ws, { t: 'created', code: c });
      } else if (m.t === 'join') {
        const code = String(m.code || '').toUpperCase(); const r = rooms.get(code);
        if (!r) return send(ws, { t: 'joinfail', reason: 'No room with that code' });
        if (r.guest || r.host === ws) return send(ws, { t: 'joinfail', reason: 'Room is full' });
        r.guest = ws; ws.room = code; ws.role = 'guest';
        send(ws, { t: 'joined', code });
        send(r.host, { t: 'peer', ev: 'joined' });
      } else {
        // relay everything else verbatim to the other peer
        const r = rooms.get(ws.room); if (!r) return;
        const peer = ws.role === 'host' ? r.guest : r.host;
        if (peer && peer.readyState === 1) peer.send(raw.toString());
      }
    });
    ws.on('close', () => {
      const r = rooms.get(ws.room); if (!r) return;
      const peer = ws.role === 'host' ? r.guest : r.host;
      send(peer, { t: 'peer', ev: 'left' });
      // host leaving closes the room; guest leaving frees the slot
      if (ws.role === 'host') rooms.delete(ws.room);
      else r.guest = null;
    });
  });
  // keepalive: drop dead sockets
  setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }); }, 30000);
  console.log('Duo relay ready on /duo');
} catch (e) { console.error('ws relay unavailable:', e.message); }

server.listen(PORT, () => console.log('Ember Swarm listening on port ' + PORT));
