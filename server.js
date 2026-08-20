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
    ).then(() => console.log('DB ready')).catch(e => console.error('DB init error', e.message));
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

http.createServer((req, res) => {
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
}).listen(PORT, () => console.log('Ember Swarm listening on port ' + PORT));
