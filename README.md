# Ember Swarm

An endless arena survival game. You're an ember in the dark — move to survive,
weapons fire on their own, collect shards to level up and build an arsenal, and
bank ember to forge permanent upgrades between runs. Self-contained: no build
step, no dependencies.

## Run locally

```bash
npm start
```

Then open http://localhost:3000

The game itself is a single file (`index.html`) — you can also just open that
file directly in a browser with no server at all.

## Deploy

Hosted on Railway. `server.js` is a tiny zero-dependency static server that
listens on `PORT`; Railway builds with Nixpacks and runs `npm start`.

## Controls

- **WASD / arrow keys** to move (or drag on touchscreens)
- Everything fires automatically — the game is all positioning
- **P** pause · **M** sound
