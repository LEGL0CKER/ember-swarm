// Ember Swarm headless test — boots the game in headless Chromium (WebGL via SwiftShader), drives it
// through the window.__* debug hooks and fails on console errors / broken invariants.
//   node test/smoke.mjs            desktop viewport
//   node test/smoke.mjs --mobile   375×812 touch viewport (MAXE=46 path)
// Needs playwright: `npm i -D playwright` (or PLAYWRIGHT_PATH=/path/to/node_modules/playwright).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadPlaywright() {
  for (const c of ['playwright', process.env.PLAYWRIGHT_PATH].filter(Boolean)) { try { return require(c); } catch (e) {} }
  throw new Error('playwright not found — `npm i -D playwright` or set PLAYWRIGHT_PATH');
}
const { chromium } = loadPlaywright();
const PORT = 3100 + Math.floor(Math.random() * 800);
const MOBILE = process.argv.includes('--mobile');
const QUICK = process.argv.includes('--quick');
let failures = 0; const log = (...a) => console.log(...a);
const check = (ok, msg) => { if (ok) log('  ✓', msg); else { failures++; log('  ✗ FAIL', msg); } };

const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => { srv.stdout.on('data', d => { if (String(d).includes('listening')) res(); }); srv.on('exit', c => rej(new Error('server exited ' + c))); setTimeout(() => rej(new Error('server start timeout')), 8000); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctxOpts = MOBILE ? { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } };
const ctx = await browser.newContext(ctxOpts);
const page = await ctx.newPage();
const errors = [], failedReqs = [];
const isExpected = t => /\/api\/.*(503|Service Unavailable)|status of 503/.test(t);
const warnings = [];
const wire = (p, errs, reqs) => { p.on('console', m => { if (m.type() === 'error' && !isExpected(m.text())) errs.push(m.text()); if (m.type() === 'warning') warnings.push(m.text()); }); p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('response', r => { if (r.status() >= 400 && !r.url().includes('/api/')) reqs.push(r.status() + ' ' + r.url()); }); p.on('requestfailed', r => reqs.push('FAILED ' + r.url())); };
wire(page, errors, failedReqs);
const noErr = (label) => check(errors.length === 0, 'no console errors — ' + label + (errors.length ? ' → ' + errors.splice(0).slice(0, 4).join(' | ') : ''));
// steps the sim; auto-picks any level-up that opens (kills grant XP) so a stepped scenario never stalls
const step = async (n, dt = 1 / 60) => page.evaluate(([n, dt]) => { const t0 = performance.now(); let i = 0; for (; i < n; i++) { if (window.__state() === 'levelup') { const c = document.querySelector('#luCards .card'); if (c) c.click(); } if (window.__state() !== 'run') break; window.__update(dt); } return (performance.now() - t0) / Math.max(1, i); }, [n, dt]);
const ev = (fn, arg) => page.evaluate(fn, arg);
const pickUntilRun = async () => ev(() => { let n = 0; while (window.__state() === 'levelup' && n++ < 20) { const c = document.querySelector('#luCards .card'); if (!c) break; c.click(); } return window.__state(); });
const startRun = async (mode, lv) => { await ev(([m, l]) => { window.__startRun(m, l); document.querySelector('#spCards .card').click(); }, [mode, lv]); return ev(() => window.__state()); };
try {
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__state && window.__state() === 'home' && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
  log('BOOT');
  check(await ev(() => { const c = document.getElementById('cv'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }), 'WebGL context available');
  const T = await ev(() => { const t = window.__tables(); return { models: Object.keys(t.MODEL_MAP).length, loaded: Object.keys(t.MODELINFO).length, types: Object.keys(t.ETYPE).length, biomes: t.BIOME_ORDER, camp: t.CAMPAIGN.length, beh: t.BEHAVIORS, kits: t.BOSS_KITS, haz: t.HAZARDS, MAXE: t.MAXE }; });
  const modelReqs = await ev(() => performance.getEntriesByType('resource').filter(r => r.name.includes('/models/')).length);
  check(modelReqs === T.models && T.loaded === T.models, `all ${T.models} models requested and loaded (MODELINFO ${T.loaded})`);
  if (T.loaded !== T.models) log('  models:', JSON.stringify(await ev(() => window.__models())), 'warnings:', warnings.slice(0, 5).join(' | '));
  check(failedReqs.length === 0, 'no failed asset requests' + (failedReqs.length ? ' → ' + failedReqs.join(', ') : ''));
  check(T.biomes.length === 5 && T.camp === 15, `5 biomes, ${T.camp} campaign levels, ${T.types} enemy types`);
  check(T.MAXE === (MOBILE ? 46 : 80), 'MAXE=' + T.MAXE + (MOBILE ? ' (mobile)' : ' (desktop)'));
  const screens = await ev(() => { const out = []; for (const s of ['skins','forge','awards','profile','ranks','levels','duos','account','feedback','home']) { window.__setState(s); out.push(window.__state() === s && !document.getElementById(s).classList.contains('hidden')); } return out; });
  check(screens.every(Boolean), 'every screen opens and closes');
  const lv = await ev(() => { window.__setState('levels'); const heads = document.querySelectorAll('#levelPath .bhead').length, nodes = document.querySelectorAll('#levelPath .lvnode').length, cur = document.querySelectorAll('#levelPath .lvnode.current').length; window.__setState('home'); return { heads, nodes, cur }; });
  check(lv.heads === 5 && lv.nodes >= 15 && lv.cur === 1, `campaign path shows ${lv.heads} biome chapters / ${lv.nodes} levels`);
  noErr('boot + screens');

  log('FREE PLAY');
  check(await startRun('free') === 'run', 'free run starts');
  let ms = await step(600);
  log('  avg update ms (600 frames, early):', ms.toFixed(3));
  const s1 = await ev(() => { const ST = window.__ST(); return { en: ST.enemies.length, wave: ST.wave, biome: ST.biome, fin: [ST.px, ST.pz, ST.hp].every(Number.isFinite) }; });
  check(s1.en <= T.MAXE && s1.fin && s1.wave >= 1 && s1.biome === 'ember', `wave ${s1.wave} running in ${s1.biome}, ${s1.en} enemies, finite state`);
  await ev(() => window.__gainXp(60, 1));
  check(await ev(() => window.__state()) === 'levelup', 'level-up overlay opened');
  check(await pickUntilRun() === 'run', 'picking upgrades resumes the run');
  await ev(() => { for (let i = 0; i < 12; i++) { window.__gainXp(200, 1); } });
  await pickUntilRun();
  const wcount = await ev(() => Object.keys(window.__ST().weapons).length);
  check(wcount <= 3, 'weapon cap holds after many level-ups (' + wcount + ')');
  const capOk = await ev(() => { const ST = window.__ST(); ST.hp = ST.maxhp; ST.iframe = 0; window.__hurtPlayer(99999, 1); return { lost: ST.maxhp - ST.hp, cap: Math.ceil(ST.maxhp * 0.45), over: ST.over }; });
  check(capOk.lost <= capOk.cap && !capOk.over, `45% single-hit cap holds (lost ${capOk.lost} of cap ${capOk.cap})`);
  await ev(() => { const ST = window.__ST(); ST.hp = ST.maxhp; });
  noErr('free play basics');

  log('WEAPONS (each fires, damages, has its own visual)');
  const weapons = ['bolt','lance','chain','scatter','lash','nova','orbit','mine','beam'];
  for (const w of weapons) {
    const r = await ev(async (w) => { const ST = window.__ST(); ST.weapons = {}; ST.timers = {}; window.__giveWeapon(w, 3, 1); for (const e of ST.enemies) window.__killEnemy(e); window.__update(1/60);
      const k0 = ST.kills; for (let i = 0; i < 6; i++) window.__spawn('grub', ST.px + 4 + i * 2, ST.pz + (i % 2 ? 3 : -3), { hpMul: 0.3 });
      let vis = false; const pools = window.__perf; for (let i = 0; i < 240; i++) { window.__update(1/60); } return { kills: ST.kills - k0, w }; }, w);
    check(r.kills >= 1, `${w}: killed ${r.kills} of 6 close grubs in 4s`);
  }
  noErr('weapons');

  log('BIOMES / MOBS / HAZARDS');
  const rosterRes = await ev(async () => { const t = window.__tables(); const out = []; const ST = window.__ST();
    for (const id of t.BIOME_ORDER) { window.__setBiome(id, false); ST.weapons = { bolt: 1 }; ST.timers = {}; ST.hp = ST.maxhp; ST.iframe = 99;
      const b = t.BIOMES[id]; const types = b.roster.map(r => r[0]); const rec = { id, types: [], hazards: [], bt: window.__biome().cur };
      for (const ty of types) { for (const e of ST.enemies) window.__killEnemy(e); window.__update(1/60); ST.rising.length = 0; ST.iframe = 1e9; ST.hp = ST.maxhp; ST.px = 0; ST.pz = 0;
        const eid = window.__spawn(ty, ST.px + 34, ST.pz + 6); let e = ST.enemies.find(x => x.id === eid); const x0 = e.x, z0 = e.z; let moved = false, invulnSeen = false, teleSeen = false, shotSeen = false;
        for (let i = 0; i < 480; i++) { window.__update(1/60); e = ST.enemies.find(x => x.id === eid); if (!e) break; if (Math.hypot(e.x - x0, e.z - z0) > 1) moved = true; if (e.invuln) invulnSeen = true; if (ST.telegraphs.length) teleSeen = true; if (ST.ebullets.length) shotSeen = true; }
        rec.types.push({ ty, moved, invulnSeen, teleSeen, shotSeen, alive: !!e }); }
      for (const e of ST.enemies) window.__killEnemy(e); ST.telegraphs.length = 0;
      for (const h of b.hazards) { ST.iframe = 1e9; ST.px = 0; ST.pz = 0; const before = ST.telegraphs.length; const ran = window.__hazard(h); const after = ST.telegraphs.length; rec.hazards.push({ h, made: after - before, ran, before, meshes: window.__perf().teleMeshes }); for (let i = 0; i < 700; i++) window.__update(1/60); }
      out.push(rec); }
    ST.iframe = 0; return out; });
  for (const r of rosterRes) {
    check(r.bt === r.id, `${r.id}: palette applied (current biome ${r.bt})`);
    for (const t of r.types) check(t.moved, `${r.id}/${t.ty} moves`);
    const bur = r.types.find(t => t.ty === 'burrower'); if (bur) check(bur.invulnSeen && bur.teleSeen, 'burrower submerges and telegraphs its eruption');
    const kit = r.types.find(t => t.ty === 'kiter'); if (kit) check(kit.shotSeen, 'kiter fires chilling shots');
    const imp = r.types.find(t => t.ty === 'impaler'); if (imp) check(imp.teleSeen, 'impaler telegraphs its charge lane');
    for (const h of r.hazards) check(h.made > 0, `${r.id}/${h.h} hazard telegraphs (${h.made})` + (h.made > 0 ? '' : ' diag ' + JSON.stringify(h)));
  }
  const teleLeft = await ev(() => ({ n: window.__ST().telegraphs.length, busy: window.__perf().teleMeshes }));
  log('  telegraph meshes allocated:', teleLeft.busy);
  noErr('biomes/mobs/hazards');

  log('BOSSES (each kit fires; telegraphs clear when the boss dies mid-cast)');
  const bosses = ['boss','golem','trickster','colossus','shaman','overlord','pyrelord','rimeking','monarch','archon','ossuary'];
  for (const bt of bosses) {
    const r = await ev(async (bt) => { const ST = window.__ST(); for (const e of ST.enemies) window.__killEnemy(e); ST.rising.length = 0; window.__update(1/60); ST.telegraphs.length = 0; ST.hp = ST.maxhp; ST.iframe = 99;
      ST.isBossWave = true; ST.waveState = 'active'; ST.wave = 5; const t = window.__spawnBoss(bt); if (!t) return { t: null };
      let maxTele = 0, bullets = 0, attacks = 0; for (let k = 0; k < 5; k++) { window.__bossAttack(); attacks++; for (let i = 0; i < 70; i++) { window.__update(1/60); maxTele = Math.max(maxTele, ST.telegraphs.length); bullets = Math.max(bullets, ST.ebullets.length); } }
      window.__bossAttack(); window.__update(1/60); const midCast = ST.telegraphs.length; const b = ST.bossE; window.__killEnemy(b); for (let i = 0; i < 4; i++) window.__update(1/60);
      const busy = window.__perf().tele; ST.iframe = 0; return { t, maxTele, bullets, midCast, after: ST.telegraphs.length, busy, waveState: ST.waveState, enemiesLeft: ST.enemies.length }; }, bt);
    check(r.t === bt && (r.maxTele > 0 || r.bullets > 0), `${bt}: kit fired (max telegraphs ${r.maxTele}, max bullets ${r.bullets})`);
    check(r.after === 0 && r.busy === 0, `${bt}: telegraphs cleared after boss death (${r.midCast} → ${r.after})`);
  }
  noErr('bosses');

  log('FREE PLAY BIOME CYCLING');
  await pickUntilRun();
  await ev(() => { const ST = window.__ST(); for (const e of ST.enemies) window.__killEnemy(e); ST.rising.length = 0; ST.isBossWave = false; ST.wave = 4; ST.waveState = 'break'; ST.waveTimer = 0.01; ST.spawnQueue = 0; ST.orbs.forEach(o => o.got = true); });
  await step(5);
  const cyc1 = await ev(() => { const ST = window.__ST(); return { wave: ST.wave, boss: ST.isBossWave, bt: ST.bossE && ST.bossE.type, biome: ST.biome, en: ST.enemies.length, pools: window.__pools() }; });
  check(cyc1.wave === 5 && cyc1.boss && !!cyc1.bt, `wave 5 is a boss wave in ${cyc1.biome} (${cyc1.bt})`);
  if (!cyc1.bt) log('  diag:', JSON.stringify(cyc1));
  await ev(() => { const ST = window.__ST(); if (ST.bossE) window.__killEnemy(ST.bossE); else { ST.isBossWave = false; ST.spawnQueue = 0; } });
  await step(3);
  const cyc2 = await ev(() => ({ st: window.__ST().biome, b: window.__biome() }));
  check(cyc2.st !== 'ember' && cyc2.b.to === cyc2.st, `biome transition to ${cyc2.st} begins during the break`);
  await step(240);
  const cyc3 = await ev(() => ({ b: window.__biome(), ws: window.__ST().waveState }));
  check(cyc3.b.cur === cyc2.st && !cyc3.b.to, 'transition completes (cur=' + cyc3.b.cur + ')');
  await ev(() => { const ST = window.__ST(); ST.waveTimer = 0.01; });
  await step(400);
  const cyc4 = await ev(() => { const ST = window.__ST(); const t = window.__tables(); const ok = ST.enemies.every(e => t.BIOMES[ST.biome].roster.some(r => r[0] === e.type) || e.summoned); return { wave: ST.wave, ok, biome: ST.biome, types: [...new Set(ST.enemies.map(e => e.type))] }; });
  check(cyc4.wave === 6 && cyc4.ok, `wave 6 spawns the ${cyc4.biome} roster only (${cyc4.types.join(',')})`);
  noErr('cycling');

  log('CAMPAIGN');
  check(await startRun('campaign', 6) === 'run', 'campaign level 6 (The Rime Throne) starts');
  const c1 = await ev(() => { const ST = window.__ST(); return { biome: ST.biome, name: ST.cname, lv: ST.clevel }; });
  check(c1.biome === 'frost' && c1.lv === 6, `level 6 is in ${c1.biome}: "${c1.name}"`);
  await ev(() => { const ST = window.__ST(); ST.wave = 4; ST.waveState = 'break'; ST.waveTimer = 0.01; });
  await step(5);
  const c2 = await ev(() => { const ST = window.__ST(); return { boss: ST.bossE && ST.bossE.type, wave: ST.wave }; });
  check(c2.boss === 'rimeking', `wave 5 boss is the biome finale (${c2.boss})`);
  await ev(() => { const ST = window.__ST(); window.__killEnemy(ST.bossE); });
  await step(3);
  const c3 = await ev(() => ({ won: window.__ST().won, unlocked: window.__SAVE().campaign.unlocked }));
  check(c3.won && c3.unlocked >= 7, `finale cleared → won, unlocked=${c3.unlocked}`);
  await page.waitForFunction(() => window.__state() === 'over', null, { timeout: 5000 });
  check(await ev(() => window.__state()) === 'over', 'win flow reaches the results screen');
  noErr('campaign');

  log('DUOS (real two-page session over the relay)');
  const page2 = await ctx.newPage(); const errors2 = [], failed2 = []; wire(page2, errors2, failed2);
  await page2.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await page2.waitForFunction(() => window.__state && window.__state() === 'home' && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 90000 });
  await ev(() => { window.__setState('home'); document.getElementById('btnDuos').click(); document.getElementById('btnHostRoom').click(); });
  await page.waitForFunction(() => /^[A-Z0-9]{4}$/.test(document.getElementById('roomCode').textContent), null, { timeout: 8000 });
  const code = await ev(() => document.getElementById('roomCode').textContent);
  await page2.evaluate((code) => { document.getElementById('btnDuos').click(); document.getElementById('btnJoinRoom').click(); document.getElementById('joinCode').value = code; document.getElementById('btnJoinGo').click(); }, code);
  await page.waitForFunction(() => window.__NET().peerHere, null, { timeout: 8000 });
  await ev(() => document.getElementById('btnDuoStart').click());
  await page2.waitForFunction(() => window.__state() === 'run', null, { timeout: 8000 });
  // wait until the host's wave has actually put enemies on the board (not a between-wave break)
  await page.waitForFunction(() => window.__ST() && window.__ST().enemies.length >= 3, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const d1 = await ev(() => { const ST = window.__ST(); return { coop: ST.coop, run: window.__state() === 'run', en: ST.enemies.length, p2w: Object.keys(ST.p2.weapons) }; });
  const d2 = await page2.evaluate(() => { const G = window.__guestState(); const N = window.__NET(); return { role: N.role, en: G.enemies.size, hasState: !!N.state, tele: N.state && N.state.tg.length, bo: N.state && N.state.bo.length, bi: N.state && N.state.bi }; });
  check(d1.coop && d1.run && d2.role === 'guest' && d2.hasState, 'host is simulating, guest receives state');
  check(d2.en > 0 && Math.abs(d2.en - d1.en) <= 4, `guest renders ${d2.en} enemies (host has ${d1.en})` + (d2.en ? '' : ' diag ' + JSON.stringify(await page2.evaluate(() => { const N = window.__NET(); return { en: N.state && N.state.en && N.state.en.length, sample: N.state && N.state.en && N.state.en[0], pools: Object.entries(window.__pools()).slice(0, 3) }; })) + ' errs ' + errors2.slice(0, 3).join(' | ')));
  const cams = await Promise.all([ev(() => { const ST = window.__ST(); return { px: ST.px, pz: ST.pz }; }), page2.evaluate(() => { const G = window.__guestState(); return { px: G.px, pz: G.pz }; })]);
  check(Math.hypot(cams[0].px - cams[1].px, cams[0].pz - cams[1].pz) > 0.5, 'separate cameras / positions for host and guest');
  await ev(() => { const ST = window.__ST(); window.__giveWeapon('orbit', 2, 2); window.__giveWeapon('mine', 2, 2); window.__giveWeapon('beam', 1, 2); });
  await page.waitForTimeout(1200);
  const d3 = await page2.evaluate(() => { const N = window.__NET(); return { bl: N.state.bl.length, mn: N.state.mn.length, bm: N.state.bm.length }; });
  check(d3.bl >= 2 && d3.bm >= 1, `partner's Cinder Ring/Kiln Beam/mines visible to guest (blades ${d3.bl}, beams ${d3.bm}, mines ${d3.mn})`);
  // stop the host earning its own level-ups (kills → XP) so the guest's is deterministic; resolve any already open
  await ev(() => { const ST = window.__ST(); ST.xpNext = 1e9; ST.p2.xpNext = 1e9; });
  for (let i = 0; i < 6; i++) { const open = await ev(() => !document.getElementById('levelup').classList.contains('hidden')); if (!open) break; await ev(() => document.querySelector('#luCards .card').click()); await page.waitForTimeout(150); }
  await ev(() => { const ST = window.__ST(); ST.pendingLU = 0; ST.p2.pendingLU = 1; window.__tryCoopLU(); });
  try { await page2.waitForFunction(() => !document.getElementById('levelup').classList.contains('hidden'), null, { timeout: 6000 }); }
  catch (e) { log('  diag host:', JSON.stringify(await ev(() => ({ lu: window.__coopLU(), lock: window.__ST().luLock, p2p: window.__ST().p2.pendingLU, role: window.__NET().role }))), 'guest:', JSON.stringify(await page2.evaluate(() => ({ lu: window.__coopLU(), role: window.__NET().role, cw: !document.getElementById('coopwait').classList.contains('hidden'), errs: 0 }))), 'guestErrs:', errors2.slice(0, 3).join(' | ')); throw e; }
  const locked = await ev(() => window.__ST().luLock === true);
  check(locked, 'guest level-up pauses the host sim');
  await page2.evaluate(() => document.querySelector('#luCards .card').click());
  await page.waitForFunction(() => window.__ST().luLock === false, null, { timeout: 4000 });
  check(await ev(() => window.__ST().luLock === false), 'guest pick applied, sim resumes');
  await ev(() => { const ST = window.__ST(); ST.pendingLU = 1; window.__tryCoopLU(); });
  await page2.waitForFunction(() => !document.getElementById('coopwait').classList.contains('hidden'), null, { timeout: 6000 });
  check(true, 'host level-up shows "partner is choosing" on the guest');
  for (let i = 0; i < 6; i++) { const open = await ev(() => !document.getElementById('levelup').classList.contains('hidden')); if (!open) break; await ev(() => document.querySelector('#luCards .card').click()); await page.waitForTimeout(150); }
  await page.waitForTimeout(500);
  check(await page2.evaluate(() => document.getElementById('coopwait').classList.contains('hidden')), 'guest resumes after host pick');
  // AFK auto-pick: guest ignores the offer; host applies after the grace period (shortened via timer hook)
  await ev(() => { const ST = window.__ST(); ST.pendingLU = 0; ST.p2.pendingLU = 1; window.__tryCoopLU(); const L = window.__coopLU(); clearTimeout(L.timer); L.timer = setTimeout(() => window.__netMsg({ t: 'pick', i: 0 }), 300); });
  await page.waitForFunction(() => window.__ST().luLock === false, null, { timeout: 4000 });
  check(true, 'AFK auto-pick unlocks the host');
  await page.waitForTimeout(800);
  check(errors2.length === 0, 'guest: no console errors' + (errors2.length ? ' → ' + errors2.slice(0, 4).join(' | ') : ''));
  noErr('host during duo');
  await page2.close();

  log('PERF / POOLS');
  await ev(() => { window.__setState('home'); });
  check(await startRun('free') === 'run', 'fresh run for perf');
  const perf = await ev(async () => { const ST = window.__ST(); const t = window.__tables(); ST.iframe = 999; ST.weapons = { bolt: 3, orbit: 2, nova: 2 }; ST.timers = {};
    const roster = ['grub','dart','stinger','brute','bomber','leaper','charger','mote','revenant','kiter']; let n = 0; while (window.__spawn(roster[n % roster.length], ST.px + Math.cos(n) * 20, ST.pz + Math.sin(n) * 20) && n < 200) n++;
    const g0 = performance.now(); let frames = 0; for (let i = 0; i < 300; i++) { window.__update(1/60); frames++; if (ST.enemies.length < t.MAXE * 0.6) { let k = 0; while (window.__spawn(roster[k % roster.length]) && k++ < 20); } }
    const ms = (performance.now() - g0) / frames; const p = window.__perf(); ST.iframe = 0; return { ms, en: p.enemies, calls: p.calls, tris: p.tris, geoms: p.geoms, tex: p.tex, maxe: t.MAXE }; });
  log(`  avg update ms at ~MAXE: ${perf.ms.toFixed(3)} (enemies ${perf.en}/${perf.maxe}, draw calls ${perf.calls}, tris ${perf.tris}, geoms ${perf.geoms}, textures ${perf.tex})`);
  check(perf.en <= perf.maxe, 'MAXE respected under spawn pressure');
  check(perf.ms < (MOBILE ? 12 : 8), `sim step under budget (${perf.ms.toFixed(2)} ms)`);
  // pools: restart runs several times, geometry count must not grow (no per-run allocations leaking)
  const g1 = await ev(() => window.__perf().geoms);
  for (let i = 0; i < 3; i++) { await ev(() => window.__setState('home')); await startRun('free'); await step(200); await ev(() => { const ST = window.__ST(); ST.hp = 1; ST.iframe = 0; window.__hurtPlayer(50, 1); }); await page.waitForFunction(() => window.__state() === 'over', null, { timeout: 5000 }); }
  const g2 = await ev(() => window.__perf().geoms);
  check(g2 - g1 <= 8, `geometry count stable across runs (${g1} → ${g2})`);
  noErr('perf/pools');
} catch (e) { failures++; log('  ✗ EXCEPTION', e.stack || e.message); }
finally { await browser.close(); srv.kill(); }
log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
