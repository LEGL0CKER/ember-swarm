# Ember Swarm

A 3D arena survival game. You're an ember in the dark — move to survive, weapons fire on
their own, collect shards to level up and build an arsenal, and bank ember to forge
permanent upgrades between runs. Self-contained: no build step.

## Run locally

```bash
npm install && npm start
```

Then open http://localhost:3000. Without a `DATABASE_URL` the `/api/*` endpoints return
`503 db_unavailable` (expected); everything else works offline.

## Biomes

Every world the swarm lives in is one row of the `BIOMES` table in `index.html`: palette,
fog, lights, ambient particles, decor, mob roster (with the tier each type joins at), boss
list (classic boss first, the biome's finale boss last), hazards and tips. Adding a biome is
additive — nothing else needs to know about it.

| Biome | Signature mobs | Bosses | Hazards |
|---|---|---|---|
| Ember Wastes | Cinder Bomber (bursts on death) | Warden → **Pyre Lord** | magma vents |
| Frost Reach | Rime Bulwark (frontal block), Rime Spitter (chilling kiter) | Golem → **Rime Sovereign** | icefall, chill zones |
| Verdant Hollow | Root Burrower (surfaces under you), Spore Mender (heals/hastes) | Colossus → **Verdant Monarch** | drifting spores, vine lashes |
| Voidspire | Void Mote (splits twice), Void Anchor (gravity pull) | Trickster / Overlord → **Void Archon** | gravity wells, void rain |
| Bone Desert | Revenant (rises from its bone pile), Bone Impaler (marked charge lane) | Shaman → **Ossuary King** | sandstorms, quicksand |

- **Campaign**: five chapters of three named levels; the third level of each chapter is the
  finale against that biome's new boss. Level numbers are stable, so existing progress
  (`SAVE.campaign.unlocked`) carries over.
- **Free Play**: the biome changes every level (5 waves) in the order above, cycling with
  rising difficulty. The switch is announced during the post-boss break with a cross-fade.
- Every hazard and boss attack is a filled disc or ring on the ground: the visible area is
  the damage area, exactly.

## Weapons

Three starting abilities (Ember Bolt, Frost Lance, Spark Chain) plus Cinder Ring, Ash Nova,
Ember Scatter, Cinder Lash, **Brimstone Mine** (drop mines behind you) and **Kiln Beam** (a
rotating blade of light). You can carry three. In Duos the partner has a fully independent
build and can wield every weapon.

## Tests

```bash
npm test                          # server: accounts, rate limits, score checks, crash vectors, relay (in-memory pg stub)
npm run test:e2e                  # headless WebGL run-through of every biome, mob, boss, weapon, campaign, Duos
npm run test:e2e:mobile           # the same at 375×812 with touch (MAXE=46 path)
```

The end-to-end suite needs Playwright's Chromium: `npm i -D playwright` or point
`PLAYWRIGHT_PATH` at an existing `node_modules/playwright`. It drives the game through the
`window.__*` debug hooks (`__startRun`, `__update`, `__spawn`, `__spawnBoss`, `__setBiome`,
`__hazard`, `__giveWeapon`, `__fakeCoopHost`, …) — keep those when editing.

## Deploy

Hosted on Railway (`railway up --ci --service ember-swarm`). `server.js` serves the static
files with long cache headers for `/models`, `/vendor`, `/fonts`, and exposes the leaderboard,
accounts, feedback and the `/duo` WebSocket relay. Postgres tables auto-create on boot.
Set `ADMIN_TOKEN` (16+ chars) to enable `GET /api/admin/feedback` with
`Authorization: Bearer <token>` for reading player feedback; without it the route is a 404.

## Credits

Monster models are CC0 from Quaternius' *Ultimate Monsters* packs. Fonts: Barlow, Chakra
Petch (OFL).

## Controls

- **WASD / arrow keys** to move, or drag on touchscreens
- Everything fires automatically — the game is all positioning
- **P** pause · **M** sound · **1/2/3** pick an upgrade
