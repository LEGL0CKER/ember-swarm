// Server tests with an in-memory `pg` stub: accounts (hashed password + hashed session), failure-only
// rate limiting, constant-ish login timing for unknown users, feedback, score plausibility, admin gate,
// crash-vector requests (malformed URL, NUL, null JSON body) and the /duo relay's guards.
//   node test/server.test.mjs
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; const check = (ok, msg) => { console.log((ok ? '  OK   ' : '  FAIL ') + msg); if (!ok) failures++; };

// ---- tiny in-memory Postgres stand-in (only the statements server.js uses) ----
const db = { scores: new Map(), users: [], sessions: new Map(), feedback: [] };
class Pool {
  constructor() {} on() {}
  async query(sql, p = []) {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE TABLE/i.test(sql) || /^DELETE FROM scores WHERE token IN/i.test(sql) || /^UPDATE scores SET token/i.test(sql)) return { rows: [] };
    if (/^DELETE FROM sessions WHERE expires_at/i.test(sql)) return { rows: [] };
    if (/^SELECT 1 FROM users WHERE username_lower/i.test(sql)) return { rows: db.users.filter(u => u.username_lower === p[0]).map(() => ({ 1: 1 })) };
    if (/^INSERT INTO users/i.test(sql)) { if (db.users.some(u => u.username_lower === p[1])) return { rows: [] }; const u = { id: db.users.length + 1, username: p[0], username_lower: p[1], pass_hash: p[2] }; db.users.push(u); return { rows: [{ id: u.id }] }; }
    if (/^SELECT id, username, pass_hash FROM users/i.test(sql)) return { rows: db.users.filter(u => u.username_lower === p[0]) };
    if (/^INSERT INTO sessions/i.test(sql)) { db.sessions.set(p[0], { user_id: p[1], exp: Date.now() + 864e5 }); return { rows: [] }; }
    if (/^SELECT u\.id, u\.username FROM sessions/i.test(sql)) { const s = db.sessions.get(p[0]); if (!s || s.exp < Date.now()) return { rows: [] }; const u = db.users.find(u => u.id === s.user_id); return { rows: u ? [{ id: u.id, username: u.username }] : [] }; }
    if (/^DELETE FROM sessions WHERE token_hash/i.test(sql)) { db.sessions.delete(p[0]); return { rows: [] }; }
    if (/^INSERT INTO feedback/i.test(sql)) { db.feedback.push({ id: db.feedback.length + 1, user_id: p[0], name: p[1], body: p[2] }); return { rows: [] }; }
    if (/^SELECT id, user_id, name, body, created_at FROM feedback/i.test(sql)) return { rows: db.feedback.slice().reverse() };
    if (/^INSERT INTO scores/i.test(sql)) { const cur = db.scores.get(p[0]); if (!cur || p[3] > cur.score) db.scores.set(p[0], { token: p[0], name: p[1], avatar: p[2], score: p[3], time: p[4], kills: p[5], level: p[6] }); return { rows: [] }; }
    if (/^SELECT name,avatar,score,time,kills,level FROM scores/i.test(sql)) return { rows: [...db.scores.values()].sort((a, b) => b.score - a.score).slice(0, 50) };
    throw new Error('unstubbed SQL: ' + sql);
  }
}
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'pg') return { Pool }; return origLoad.call(this, req, ...rest); };
process.env.DATABASE_URL = 'postgres://stub';
process.env.PORT = String(3900 + Math.floor(Math.random() * 90));
process.env.ADMIN_TOKEN = 'test-admin-token-0123456789';
const PORT = process.env.PORT;
require(path.join(ROOT, 'server.js'));
await new Promise(r => setTimeout(r, 300));
const base = 'http://localhost:' + PORT;
const post = async (p, body, headers) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j }; };
const get = async (p, headers) => { const r = await fetch(base + p, { headers }); let j = null; try { j = await r.clone().json(); } catch (e) {} return { status: r.status, j, text: j ? '' : await r.text() }; };

console.log('ACCOUNTS');
let r = await post('/api/register', { username: 'ryder_1', password: 'correct horse' });
check(r.status === 200 && r.j.token && r.j.token.length === 64, 'register returns a 32-byte session token');
const tok = r.j.token; const u = db.users[0];
check(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(u.pass_hash) && !u.pass_hash.includes('correct'), 'password stored as salted scrypt hash');
check(![...db.sessions.keys()].includes(tok) && [...db.sessions.keys()][0].length === 64, 'session stored only as a SHA-256 hash');
r = await post('/api/register', { username: 'RYDER_1', password: 'another pw' });
check(r.status === 409, 'duplicate username (case-insensitive) rejected');
r = await post('/api/register', { username: 'bad name!', password: 'x' });
check(r.status === 400, 'invalid username/password rejected');
r = await post('/api/me', { token: tok });
check(r.status === 200 && r.j.user && r.j.user.username === 'ryder_1', '/api/me resolves the session');
r = await post('/api/login', { username: 'ryder_1', password: 'wrong password' });
check(r.status === 401, 'wrong password -> 401');
r = await post('/api/login', { username: 'ryder_1', password: 'correct horse' });
check(r.status === 200 && r.j.token, 'login works');
const tm = async (u) => { const t0 = performance.now(); await post('/api/login', { username: u, password: 'nope nope nope' }); return performance.now() - t0; };
const known = [], unknown = []; for (let i = 0; i < 4; i++) { known.push(await tm('ryder_1')); unknown.push(await tm('nobody_' + i)); }
const med = a => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
check(med(unknown) > med(known) * 0.5, `unknown-user login runs scrypt (median known ${med(known).toFixed(0)}ms vs unknown ${med(unknown).toFixed(0)}ms)`);
r = await post('/api/logout', { token: tok });
r = await post('/api/me', { token: tok });
check(r.status === 200 && r.j.user === null, 'logout invalidates the session');

console.log('RATE LIMITING (failures only)');
let last; for (let i = 0; i < 12; i++) last = await post('/api/login', { username: 'ryder_1', password: 'bad password ' + i });
check(last.status === 429, 'per-account cap after repeated failed logins (' + last.status + ')');
r = await post('/api/login', { username: 'ryder_1', password: 'correct horse' });
check(r.status === 429, 'lockout also covers the right password until the window passes');
r = await post('/api/register', { username: 'someone_else', password: 'long enough pw' });
check(r.status === 200, 'unrelated register from the same IP still works');
let ok = 0; for (let i = 0; i < 5; i++) { const x = await post('/api/login', { username: 'someone_else', password: 'long enough pw' }); if (x.status === 200) ok++; }
check(ok === 5, 'successful logins are refunded, never counted (5/5 ok)');

console.log('SCORES / FEEDBACK / ADMIN');
const RLO = '‮', ZW = '​';
r = await post('/api/score', { token: 'dev1', name: ' ' + RLO + ' Evil  ', score: 10000000, time: 1, kills: 0, level: 0 });
check(r.status === 400, 'forged score rejected (' + (r.j && r.j.error) + ')');
r = await post('/api/score', { token: 'dev1', name: ' ' + RLO + 'Spoof' + ZW + ' ', score: 120 * 3 + 50 * 10 + 6 * 50, time: 120, kills: 50, level: 6 });
check(r.status === 200 && db.scores.get('ddev1').name === 'Spoof', 'consistent score accepted, name sanitised (' + JSON.stringify(db.scores.get('ddev1').name) + ')');
r = await post('/api/score', { token: 'dev1', score: 30 * 3 + 900 * 10 + 50, time: 30, kills: 900, level: 1 });
check(r.status === 400, 'implausible kill rate rejected');
r = await get('/api/leaderboard');
check(r.status === 200 && r.j.board.length === 1, 'leaderboard lists the accepted row');
r = await post('/api/feedback', { body: 'love the frost biome', name: 'anon' });
check(r.status === 200 && db.feedback.length === 1, 'feedback stored');
r = await get('/api/admin/feedback');
check(r.status === 401, 'admin feedback read without token -> 401');
r = await get('/api/admin/feedback', { Authorization: 'Bearer ' + process.env.ADMIN_TOKEN });
check(r.status === 200 && r.j.feedback.length === 1 && r.j.feedback[0].body === 'love the frost biome', 'admin feedback read with token');

console.log('CRASH VECTORS (server must survive)');
const raw = (line) => new Promise(res => { const s = net.connect(PORT, 'localhost', () => s.write(line + '\r\nHost: x\r\n\r\n')); let d = ''; s.on('data', c => d += c); s.on('end', () => res(d)); s.on('error', () => res('ERR')); setTimeout(() => { s.destroy(); res(d); }, 1500); });
let resp = await raw('GET /% HTTP/1.1'); check(/^HTTP\/1\.1 400/.test(resp), 'malformed percent-escape -> 400');
resp = await raw('GET /%00 HTTP/1.1'); check(/^HTTP\/1\.1 400/.test(resp), 'NUL byte in path -> 400');
r = await post('/api/score', 'null'); check(r.status === 400, 'JSON null body -> 400, no crash');
r = await post('/api/login', '[1,2]'); check(r.status === 400, 'JSON array body -> 400, no crash');
r = await get('/server.js'); check(r.status === 200 && /<!doctype html>/i.test(r.text || ''), 'server.js is not served (SPA fallback instead)');
r = await get('/node_modules/pg/package.json'); check(!(r.j && r.j.name === 'pg'), 'node_modules not served');
r = await get('/models/Frog.glb'); check(r.status === 200, 'models are served');
r = await get('/'); check(r.status === 200, 'server still alive after crash vectors');

console.log('DUO RELAY');
const WebSocket = require(path.join(ROOT, 'node_modules/ws'));
const wsOpen = () => new Promise((res, rej) => { const w = new WebSocket('ws://localhost:' + PORT + '/duo'); w.msgs = []; w.on('message', m => w.msgs.push(JSON.parse(m))); w.on('open', () => res(w)); w.on('error', rej); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const A = await wsOpen(), B = await wsOpen(), C = await wsOpen();
A.send('null'); A.send('5'); A.send('"x"'); await wait(100);
A.send(JSON.stringify({ t: 'create' })); await wait(150);
const code = A.msgs.find(m => m.t === 'created').code; check(/^[A-Z0-9]{4}$/.test(code), 'room created after junk frames (' + code + ')');
B.send(JSON.stringify({ t: 'join', code })); await wait(150);
check(B.msgs.some(m => m.t === 'joined') && A.msgs.some(m => m.t === 'peer' && m.ev === 'joined'), 'guest joins, host notified');
C.send(JSON.stringify({ t: 'join', code })); await wait(150);
check(C.msgs.some(m => m.t === 'joinfail'), 'third player refused');
B.send(JSON.stringify({ t: 'join', code: 'ZZZZ' })); await wait(150);
check(B.msgs.filter(m => m.t === 'joinfail').some(m => /Already/.test(m.reason)), 'a socket already in a room cannot join another');
A.send(JSON.stringify({ t: 'state', hello: 1 })); await wait(150);
check(B.msgs.some(m => m.t === 'state' && m.hello === 1), 'host -> guest relay works');
A.send(Buffer.from([0xff, 0xfe])); await wait(200);
const D = await wsOpen(); check(D.readyState === 1, 'server survives an invalid UTF-8 frame');
for (const w of [A, B, C, D]) w.close();
await wait(200);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SERVER CHECKS PASSED');
process.exit(failures ? 1 : 0);
