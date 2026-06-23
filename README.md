# MECCHA CHAMELEON — Multiplayer Server

Authoritative, horizontally-shardable WebSocket game server for **MECCHA CHAMELEON**
(a paint-and-hide party game). It owns the game truth — presence, round flow, roles,
tagging, and the voice bus — so clients can't cheat the outcome, and it's built to
scale to many concurrent rooms on a single Node process.

> Replaces the original single-file prototype server. Dependency-light (only `ws`),
> ESM, Node ≥ 18.

## Why this exists / what's "scalable" about it
- **Multi-room with matchmaking + private codes.** Players auto-fill public rooms or
  join a friend's room by code (`?room=ABCD`). Each room runs its own round.
- **One set of master loops for the whole server** (not per-room timers): presence
  (20 Hz), round advance (4 Hz), phase heartbeat (1 Hz), socket heartbeat. A thousand
  rooms cost their data, not a thousand intervals.
- **Server-relayed voice (SFU-style), not a WebRTC mesh.** Each client uploads **one**
  Opus stream; the server fans it out within the room. Per-client cost is O(1) upstream
  regardless of room size — the mesh's O(N²) uplink (which melts big lobbies) is gone.
  Voice is **VAD-gated by the client** (silence = no traffic), **speaker-capped**, and
  **backpressure-aware** (a slow client's voice is dropped, never stalls the room).
- **Positions-only 20 Hz snapshot.** Names/roles/textures are pushed on change, not
  resent every tick.
- **Hardened:** per-client rate limits (messages / paint / voice / chat), paint blobs
  size-capped + `data:image/`-validated, positions clamped + NaN-guarded, one live
  connection per identity, WS heartbeat reaps zombies, empty rooms reaped.
- **Ops-ready:** HTTP `/health` + `/metrics` (JSON **and** Prometheus), graceful
  shutdown (SIGTERM), env-driven config, Dockerfile, Railway/Fly configs, CI.

## Run
```bash
npm install
npm start            # ws + http on :8787   (npm run dev for --watch)
npm test             # unit (round logic) + integration (real WS) tests
npm run loadtest 200 # 200 bot players hammering the server
```
Local config: copy `.env.example` → `.env`. Speed rounds up for demos with `MC_TIME_SCALE=0.1`.

## Connecting the game client
Point the [MECCHA CHAMELEON](../) client's `PROD_WS` (in `src/net/wsUrl.js`) at this
server's `wss://…` URL after deploying. The protocol is unchanged, so the existing
client works as-is; passing `?room=CODE` opts into private rooms.

## HTTP endpoints
| Path | Purpose |
|------|---------|
| `GET /health` | liveness + live `{rooms, players, uptime, counters}` (JSON) |
| `GET /metrics` | Prometheus text (or JSON with `Accept: application/json`) |
| `GET /` | server name + current room/player counts |

## Architecture
```
src/
  index.js        bootstrap: load .env, start server, graceful shutdown
  env.js          dependency-free .env loader (imported first)
  config.js       all tunables from env, with defaults
  log.js          leveled logger
  protocol.js     the wire contract (message types, phases, roles)
  util.js         sanitize / clamp / rate-limiter / ids / room codes
  metrics.js      counters + /health + Prometheus snapshot
  server.js       GameServer: HTTP + WS, connection routing, heartbeat, shutdown
  roomManager.js  matchmaking, room codes, capacity, reaping, master tick loops
  room.js         one room: presence, chat, paint relay, voice bus
  round.js        authoritative round state machine: PREP→HUNT→RESULTS, roles, tag, win
test/
  round.test.mjs     unit tests for round logic (roles, tagging, win)
  protocol.test.mjs  integration tests over real WebSockets
  loadtest.mjs       bot swarm for stress testing
```

## Protocol (summary)
Connect: `wss://host/?name=<name>&key=<persistent-secret>&room=<optional CODE>`.

JSON messages are `{ t, ... }`. **Voice is binary**: client → server uploads a raw Opus
packet; server → others sends `[u8 idLen][id ascii][opus]`.

**Client → server:** `setProfile{name}` · `state{x,y,z,ry,anim,q?}` · `paint{tex}` ·
`tag{target}` · `shoot{target}` · `spectate{on}` · `chat{text}` · `ping{t0}` · *(binary)* voice.
**Server → client:** `welcome{id,room,spawn,peers,phase}` · `state{peers}` ·
`peer_join` · `peer_leave` · `phase{phase,deadline,roles,result}` · `peerPaint{id,tex}` ·
`tagged{id}` · `shot{id,x,y,z}` · `chat` · `serverFull` · `pong` · *(binary)* voice.

See [`src/protocol.js`](src/protocol.js) for the authoritative list.

## Round flow
`PREP` (paint & hide) → `HUNT` (seekers tag hiders) → `RESULTS` (reveal) → loop.
Roles are assigned each PREP (~1 seeker per `SEEKER_PER` players); spectators sit out
and are never dealt a role. A tag is accepted only if the sender is a live seeker, in
HUNT, within `TAG_RADIUS` of a live hider; a `shoot` is the ranged version, validated
in 3D within `SHOOT_RANGE` and relayed to peers as a positional `shot` SFX (hit or
miss). All checks are server-side. A player's painted body and spectator choice are
persisted by identity, so a refresh/reconnect restores them. Hiders win if any survive
the timer; seekers win if all are tagged.

## Deploy
- **Docker:** `docker build -t mc-server . && docker run -p 8787:8787 mc-server`
- **Railway:** push the repo; `railway.json` sets start + `/health` check.
- **Fly:** edit the app name in `fly.toml`, then `fly launch` / `fly deploy`.
Set env vars (`MAX_PLAYERS_PER_ROOM`, phase timings, `ALLOW_ORIGINS`, …) on the host.

## Horizontal scale-out (beyond one process)
Rooms are independent, so the path to multiple instances is: a sticky-by-room router
(or a shared Redis pub/sub so a room's events fan out across instances). The room/
manager boundary is where that adapter slots in — single-instance is the default here.

MIT licensed.
