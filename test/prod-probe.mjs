// Read-only production probe: boot health + a real two-tab Duos session over the live relay.
// Posts nothing to the leaderboard (tabs close before any run ends).  node test/prod-probe.mjs [url]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = (() => { for (const c of ['playwright', process.env.PLAYWRIGHT_PATH].filter(Boolean)) { try { return require(c); } catch (e) {} } throw new Error('playwright not found'); })();
const URL = process.argv[2] || 'https://ember-swarm-production.up.railway.app/';
let failures = 0; const check = (ok, m) => { console.log((ok ? '  OK   ' : '  FAIL ') + m); if (!ok) failures++; };
const browser = await pw.chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const mk = async () => { const p = await ctx.newPage(); p.errs = []; p.bad = []; p.on('console', m => { if (m.type() === 'error') p.errs.push(m.text()); }); p.on('pageerror', e => p.errs.push(e.message)); p.on('response', r => { if (r.status() >= 400) p.bad.push(r.status() + ' ' + r.url()); }); return p; };
const boot = async (p) => { await p.goto(URL, { waitUntil: 'load' }); await p.waitForFunction(() => window.__state && window.__state() === 'home' && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 }); };
try {
  const host = await mk(); const t0 = Date.now(); await boot(host); const bootMs = Date.now() - t0;
  const m = await host.evaluate(() => ({ models: window.__models().info.length, reqs: performance.getEntriesByType('resource').filter(r => r.name.includes('/models/')).length, sw: !!navigator.serviceWorker.controller || 'pending', biomes: window.__tables().BIOME_ORDER.length }));
  check(m.models === 30 && m.reqs === 30, `production boot: ${m.models}/30 models loaded in ${bootMs} ms, ${m.biomes} biomes`);
  check(host.errs.length === 0 && host.bad.length === 0, 'no console errors / failed requests on boot' + (host.errs.length ? ' → ' + host.errs.slice(0, 3).join(' | ') : '') + (host.bad.length ? ' → ' + host.bad.join(', ') : ''));
  await host.evaluate(() => { document.getElementById('btnDuos').click(); document.getElementById('btnHostRoom').click(); });
  await host.waitForFunction(() => /^[A-Z0-9]{4}$/.test(document.getElementById('roomCode').textContent), null, { timeout: 15000 });
  const code = await host.evaluate(() => document.getElementById('roomCode').textContent);
  const guest = await mk(); await boot(guest);
  await guest.evaluate((code) => { document.getElementById('btnDuos').click(); document.getElementById('btnJoinRoom').click(); document.getElementById('joinCode').value = code; document.getElementById('btnJoinGo').click(); }, code);
  await host.waitForFunction(() => window.__NET().peerHere, null, { timeout: 15000 });
  await host.evaluate(() => document.getElementById('btnDuoStart').click());
  await guest.waitForFunction(() => window.__state() === 'run', null, { timeout: 15000 });
  check(true, `duo room ${code} created, joined and started over the live relay`);
  await host.evaluate(() => { const ST = window.__ST(); ST.iframe = 1e9; ST.p2.iframe = 1e9; ST.xpNext = 1e9; ST.p2.xpNext = 1e9; window.__giveWeapon('orbit', 2, 2); window.__giveWeapon('beam', 1, 2); });
  await host.waitForFunction(() => window.__ST().enemies.length >= 3, null, { timeout: 20000 }).catch(() => {});
  await host.waitForTimeout(1500);
  // round trip: guest input seq → host ack in the next snapshot
  const rtt = await guest.evaluate(async () => { const G = window.__guestState(); const N = window.__NET(); const s0 = G.seq; const t0 = performance.now(); return await new Promise(r => { const iv = setInterval(() => { if (N.state && N.state.p2[7] >= s0 + 1) { clearInterval(iv); r(performance.now() - t0); } if (performance.now() - t0 > 5000) { clearInterval(iv); r(-1); } }, 5); }); });
  check(rtt > 0 && rtt < 800, `input → acknowledged state round trip: ${rtt.toFixed(0)} ms`);
  await guest.keyboard.down('d'); await host.waitForTimeout(1200); await guest.keyboard.up('d'); await host.waitForTimeout(500);
  const pos = await Promise.all([host.evaluate(() => ({ x: window.__ST().p2.px, z: window.__ST().p2.pz })), guest.evaluate(() => ({ x: window.__guestState().px, z: window.__guestState().pz }))]);
  check(pos[0].x > 8 && Math.hypot(pos[0].x - pos[1].x, pos[0].z - pos[1].z) < 2.5, `guest prediction vs host after a 1.2 s move: host x=${pos[0].x.toFixed(1)}, guest x=${pos[1].x.toFixed(1)}`);
  const g = await guest.evaluate(() => ({ en: window.__guestState().enemies.size, timer: document.getElementById('timer').textContent, chips: document.getElementById('chips').textContent.trim(), bl: window.__NET().state.bl.length, bm: window.__NET().state.bm.length, daily: document.getElementById('dailyModal').classList.contains('hidden') }));
  const h = await host.evaluate(() => window.__ST().enemies.length);
  check(g.en > 0 && Math.abs(g.en - h) <= 4, `guest renders ${g.en} enemies (host ${h})`);
  check(g.timer !== '00:00', `guest clock runs (${g.timer})`);
  check(/Cinder Ring/.test(g.chips) && g.bl >= 2 && g.bm >= 1, `guest sees its weapons: chips "${g.chips}", blades ${g.bl}, beams ${g.bm}`);
  check(g.daily, 'no Daily modal over the guest run');
  await guest.screenshot({ path: process.env.SHOT || '/tmp/prod-guest.png' });
  check(guest.errs.length === 0 && host.errs.length === 0, 'no console errors on either side during the duo' + (guest.errs.concat(host.errs).slice(0, 3).join(' | ') ? ' → ' + guest.errs.concat(host.errs).slice(0, 3).join(' | ') : ''));
} catch (e) { failures++; console.log('  FAIL exception', e.message); }
finally { await browser.close(); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nPRODUCTION PROBE PASSED'); process.exit(failures ? 1 : 0);
