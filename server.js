// Ember Swarm server: static files + a small global-leaderboard API (Postgres).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

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
    ).then(() => pool.query(
      `CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT UNIQUE NOT NULL,
        pass_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )`
    )).then(() => pool.query(
      `CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`
    )).then(() => pool.query(
      `CREATE TABLE IF NOT EXISTS feedback(
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT, body TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )`
    )).then(() => {
      console.log('DB ready');
      // one-off cleanup of setup test rows (fake tokens; never returned by real clients)
      pool.query("DELETE FROM scores WHERE token IN ('testtoken1','tok2')").catch(() => {});
      // migrate legacy raw device score keys into the 'd' namespace (skip account rows 'u<id>',
      // rows already migrated, and any that would collide with an existing 'd' row)
      pool.query("UPDATE scores SET token='d'||token WHERE token !~ '^u[0-9]+$' AND token NOT LIKE 'd%' AND ('d'||token) NOT IN (SELECT token FROM scores)").catch(() => {});
      // sweep expired sessions now and hourly (the table would otherwise grow unbounded)
      const sweepSessions = () => pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
      sweepSessions();
      setInterval(sweepSessions, 3600000).unref();
    }).catch(e => console.error('DB init error', e.message));
  } catch (e) { console.error('pg load error', e.message); }
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const clampInt = (v, lo, hi) => { v = Math.floor(Number(v) || 0); return Math.max(lo, Math.min(hi, v)); };

/* ---------- accounts: password hashing + sessions ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
// a well-formed hash to verify against when a username doesn't exist, so login
// timing is the same whether or not the account is real (no user enumeration)
const DUMMY_HASH = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);
// store as scrypt$<saltHex>$<hashHex>
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const want = Buffer.from(parts[2], 'hex');
  let dk;
  try { dk = await scrypt(pw, salt, want.length || SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }); }
  catch (e) { return false; }
  return dk.length === want.length && crypto.timingSafeEqual(dk, want);
}
const newSessionToken = () => crypto.randomBytes(32).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const SESSION_DAYS = 30;

// create a session row for a user, return the raw token (only the hash is stored)
async function createSession(userId) {
  const token = newSessionToken();
  await pool.query(
    'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2, now() + ($3 || \' days\')::interval)',
    [sha256(token), userId, String(SESSION_DAYS)]
  );
  return token;
}
// resolve a raw bearer token to { id, username } or null
async function userForToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const r = await pool.query(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return r.rows[0] || null;
}
const validUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;

/* ---------- simple in-memory rate limiter (per IP) ---------- */
const rlBuckets = new Map(); // key -> [timestamps]
// how many hits for `key` are still inside the window (does NOT record a new hit)
function rlCount(key, windowMs) {
  const now = Date.now();
  let arr = rlBuckets.get(key);
  if (!arr) { arr = []; rlBuckets.set(key, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return arr.length;
}
// record one hit for `key` (called only on failures / abuse-prone successes)
function rlAdd(key) { const arr = rlBuckets.get(key) || []; arr.push(Date.now()); rlBuckets.set(key, arr); }
setInterval(() => { // stop the map from growing unbounded
  const now = Date.now();
  for (const [k, arr] of rlBuckets) { while (arr.length && now - arr[0] > 3600000) arr.shift(); if (!arr.length) rlBuckets.delete(k); }
}, 600000).unref();
// Behind a proxy, a client's own X-Forwarded-For values are prepended; the RIGHTMOST
// entry is the one the trusted proxy appended, so use that (never [0], which is spoofable).
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) { const parts = String(xf).split(',').map(s => s.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// read a small JSON body (auth payloads are tiny); calls cb(err, obj)
function readJson(req, res, limit, cb) {
  let body = '', tooBig = false;
  req.on('data', c => { body += c; if (body.length > limit) { tooBig = true; req.destroy(); } });
  req.on('end', () => {
    if (tooBig) return cb('too_large');
    try { cb(null, JSON.parse(body || '{}')); } catch (e) { cb('bad_json'); }
  });
  req.on('error', () => cb('req_error'));
}

function handleApi(req, res, urlPath) {
  if (!pool) return sendJSON(res, 503, { error: 'db_unavailable' });

  if (req.method === 'GET' && urlPath === '/api/leaderboard') {
    pool.query('SELECT name,avatar,score,time,kills,level FROM scores ORDER BY score DESC LIMIT 50')
      .then(r => sendJSON(res, 200, { board: r.rows }))
      .catch(() => sendJSON(res, 500, { error: 'query_failed' }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/score') {
    readJson(req, res, 4000, async (err, d) => {
      if (err) return sendJSON(res, err === 'too_large' ? 413 : 400, { error: err });
      const score = clampInt(d.score, 0, 10000000);
      const time = clampInt(d.time, 0, 86400);
      const kills = clampInt(d.kills, 0, 1000000);
      const level = clampInt(d.level, 0, 10000);
      let avatar = '{}'; try { avatar = JSON.stringify(d.avatar || {}); } catch (e) {}
      // a logged-in session ties the score to the account (name comes from the account, can't be spoofed)
      let key, name;
      try {
        const acct = d.sessionToken ? await userForToken(String(d.sessionToken)) : null;
        if (acct) { key = 'u' + acct.id; name = acct.username; }
      } catch (e) {}
      if (!key) {
        const token = String(d.token || '').slice(0, 64);
        if (!token) return sendJSON(res, 400, { error: 'no_token' });
        key = 'd' + token; // namespace device tokens so they can't collide with account keys
        name = String(d.name || 'Player').slice(0, 16);
      }
      pool.query(
        `INSERT INTO scores(token,name,avatar,score,time,kills,level,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT(token) DO UPDATE SET
           name=EXCLUDED.name, avatar=EXCLUDED.avatar, score=EXCLUDED.score,
           time=EXCLUDED.time, kills=EXCLUDED.kills, level=EXCLUDED.level, updated_at=now()
         WHERE EXCLUDED.score > scores.score`,
        [key, name, avatar, score, time, kills, level]
      ).then(() => sendJSON(res, 200, { ok: true }))
       .catch(() => sendJSON(res, 500, { error: 'insert_failed' }));
    });
    return;
  }

  // ---- accounts ----
  if (req.method === 'POST' && (urlPath === '/api/register' || urlPath === '/api/login')) {
    const ip = clientIp(req);
    // Cap only repeated FAILURES (wrong password) / abusive signups, so many legit
    // users behind one shared IP (a school NAT) don't lock each other out.
    if (urlPath === '/api/login' && rlCount('login:' + ip, 10 * 60 * 1000) >= 20) return sendJSON(res, 429, { error: 'too_many_attempts', message: 'Too many attempts. Try again in a few minutes.' });
    if (urlPath === '/api/register' && rlCount('reg:' + ip, 60 * 60 * 1000) >= 30) return sendJSON(res, 429, { error: 'too_many_attempts', message: 'Too many new accounts from here. Try again later.' });
    readJson(req, res, 1000, async (err, d) => {
      if (err) return sendJSON(res, err === 'too_large' ? 413 : 400, { error: err });
      const username = typeof d.username === 'string' ? d.username.trim() : '';
      const password = typeof d.password === 'string' ? d.password : '';
      if (!validUsername(username)) return sendJSON(res, 400, { error: 'bad_username', message: '3-16 letters, numbers or underscore.' });
      if (!validPassword(password)) return sendJSON(res, 400, { error: 'bad_password', message: 'Password must be at least 8 characters.' });
      const lower = username.toLowerCase();
      try {
        if (urlPath === '/api/register') {
          // cheap availability check first so a taken name doesn't cost a scrypt hash
          const exists = await pool.query('SELECT 1 FROM users WHERE username_lower=$1', [lower]);
          if (exists.rows[0]) return sendJSON(res, 409, { error: 'username_taken', message: 'That name is taken.' });
          const ph = await hashPassword(password);
          const r = await pool.query(
            'INSERT INTO users(username,username_lower,pass_hash) VALUES($1,$2,$3) ON CONFLICT(username_lower) DO NOTHING RETURNING id',
            [username, lower, ph]
          );
          if (!r.rows[0]) return sendJSON(res, 409, { error: 'username_taken', message: 'That name is taken.' });
          rlAdd('reg:' + ip);
          const token = await createSession(r.rows[0].id);
          return sendJSON(res, 200, { ok: true, token, username });
        } else { // login
          const r = await pool.query('SELECT id, username, pass_hash FROM users WHERE username_lower=$1', [lower]);
          const row = r.rows[0];
          // always run one scrypt (a dummy when the user is unknown) so response time
          // doesn't reveal whether the username exists
          const ok = row ? await verifyPassword(password, row.pass_hash) : (await verifyPassword(password, DUMMY_HASH), false);
          if (!ok) { rlAdd('login:' + ip); return sendJSON(res, 401, { error: 'invalid_credentials', message: 'Wrong name or password.' }); }
          const token = await createSession(row.id);
          return sendJSON(res, 200, { ok: true, token, username: row.username });
        }
      } catch (e) { return sendJSON(res, 500, { error: 'server_error' }); }
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/logout') {
    readJson(req, res, 1000, (err, d) => {
      if (err) return sendJSON(res, 400, { error: err });
      const t = String((d && d.token) || '');
      if (t.length >= 32) pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(t)]).catch(() => {});
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/me') {
    readJson(req, res, 1000, async (err, d) => {
      if (err) return sendJSON(res, 400, { error: err });
      try {
        const acct = await userForToken(String((d && d.token) || ''));
        return sendJSON(res, 200, { user: acct ? { username: acct.username } : null });
      } catch (e) { return sendJSON(res, 500, { error: 'server_error' }); }
    });
    return;
  }

  // ---- feedback (write-only from players) ----
  if (req.method === 'POST' && urlPath === '/api/feedback') {
    const ip = clientIp(req);
    if (rlCount('fb:' + ip, 10 * 60 * 1000) >= 6) return sendJSON(res, 429, { error: 'too_many', message: "Thanks — you've sent a lot! Try again later." });
    readJson(req, res, 3000, async (err, d) => {
      if (err) return sendJSON(res, err === 'too_large' ? 413 : 400, { error: err });
      const body = typeof d.body === 'string' ? d.body.trim() : '';
      if (body.length < 2 || body.length > 1000) return sendJSON(res, 400, { error: 'bad_body', message: 'Feedback must be 2-1000 characters.' });
      let userId = null, name = 'Anonymous';
      try { const acct = d.sessionToken ? await userForToken(String(d.sessionToken)) : null; if (acct) { userId = acct.id; name = acct.username; } } catch (e) {}
      if (!userId) { const n = typeof d.name === 'string' ? d.name.trim().slice(0, 24) : ''; if (n) name = n; }
      try {
        await pool.query('INSERT INTO feedback(user_id,name,body) VALUES($1,$2,$3)', [userId, name.slice(0, 24), body]);
        rlAdd('fb:' + ip);
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 500, { error: 'server_error' }); }
    });
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
