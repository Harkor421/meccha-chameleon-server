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
  room.js         one room: presence, chat, paint relay, voice bus, host assignment
  round.js        authoritative round state machine: LOBBY→PREP→HUNT→RESULTS, roles, tag, win, min-players gate
test/
  round.test.mjs     unit tests for round logic (roles, tagging, win)
  protocol.test.mjs  integration tests over real WebSockets
  loadtest.mjs       bot swarm for stress testing
```

## Protocol
Connect: `wss://host/?name=<name>&key=<persistent-secret>&room=<optional CODE>`.
`key` is a per-browser secret (one live connection per key; a 2nd tab/refresh replaces
the old). JSON messages are `{ t, ... }`. **Voice is binary**: client → server uploads a
raw Opus packet; server → others sends `[u8 idLen][id ascii][opus]`.

### Client → server
| `t` | fields | meaning |
|-----|--------|---------|
| `setProfile` | `{name}` | set/rename your display name |
| `state` | `{x,y,z,ry,anim,q?}` | your position/anim (`q` = optional orientation quaternion) |
| `paint` | `{tex}` | one-shot `data:image/*` painted-body sync (hiders only) |
| `tag` | `{target}` | melee-tag a hider (seeker, in HUNT, in range) |
| `shoot` | `{target}` | fire your gun (`target` null = a miss); relays SFX + validates 3D range |
| `spectate` | `{on}` | sit out of the match / rejoin |
| `chat` | `{text}` | room chat (≤140 chars) |
| `startMatch` | `{}` | **host-only**: skip the lobby countdown (LOBBY/RESULTS → fresh PREP), gated on `MIN_PLAYERS` |
| `footstep` | `{run}` | walk vs run; server attaches your position for peers' SFX |
| `reveal` | `{}` | self-report buried in geometry; server broadcasts your position |
| *(binary)* | Opus packet | one upstream voice stream |

### Server → client
| `t` | fields | meaning |
|-----|--------|---------|
| `welcome` | `{id,room,spawn,peers,phase}` | your id + roster; `phase` includes `host` |
| `state` | `{peers:{id:{x,y,z,ry,anim,q?}}}` | 20 Hz positions-only snapshot |
| `peer_join` | `{id,name,role,state}` | a peer joined/renamed |
| `peer_leave` | `{id}` | a peer left |
| `phase` | `{phase,deadline,roles,result,host}` | round phase; **`host`** = id allowed to start, `roles` may include `waiting` |
| `peerPaint` | `{id,tex}` | a peer's painted body |
| `clearPaint` | `{}` | **fresh round** — wipe every peer's synced painted body |
| `tagged` | `{id}` | a hider was downed (or someone went spectator) |
| `shot` | `{id,x,y,z}` | positional gunshot SFX (hit OR miss) |
| `footstep` | `{id,x,y,z,run}` | positional footstep SFX |
| `reveal` | `{id,x,y,z}` | anti-mesh-clip give-away |
| `whistle` | `{}` | HUNT hint cadence |
| `chat` | `{id,name,text}` | room chat |
| `serverFull` | `{}` | rejected — at capacity |
| `pong` | `{t0}` | latency reply |
| *(binary)* | `[idLen][id][opus]` | a peer's voice packet |

See [`src/protocol.js`](src/protocol.js) for the authoritative list.

### Roles
`hider` · `seeker` · `out` (eliminated) · `waiting` (joined mid-round; not eliminated —
folded into the next PREP, rendered invisible by the client) · `spectator` (sitting out).

### Host
Each room has a **host** — the first non-spectator to join, reassigned when they leave.
Only the host's `startMatch` begins a match (anti-grief). The host id rides in every
phase payload (`welcome.phase.host` and `phase.host`).

## Round flow
`LOBBY` (warm-up: roam/chat/paint, no hunting) → `PREP` (paint & hide) → `HUNT`
(seekers tag hiders) → `RESULTS` (reveal) → loop.

- **Min-players gate:** a room never enters PREP with fewer than `MIN_PLAYERS` (default 2)
  non-spectators — it keeps warming up in LOBBY so a lone player never sits through a
  seeker-less HUNT. Both the auto-advance and `startMatch` enforce this.
- **Roles** are assigned each PREP (~1 seeker per `SEEKER_PER` players). Spectators sit
  out; `waiting` players (mid-round joiners) are folded in.
- **Tag/shoot** are server-validated: a tag needs a live seeker in HUNT within
  `TAG_RADIUS` of a live hider; a `shoot` is the ranged version (3D `SHOOT_RANGE`),
  relayed to peers as a positional `shot` SFX (hit or miss).
- **Win:** the HUNT ends when all hiders are caught (**seekers win**) **or** no live
  seekers remain — e.g. every seeker disconnected (**hiders win**); both resolve from
  the surviving-hider count. Hiders also win if any survive the timer.
- **Fresh-round paint clear:** entering LOBBY/PREP clears painted bodies server-side and
  broadcasts `clearPaint` so every client wipes peers' synced camo.
- **Persistence:** a player's painted body and spectator choice are persisted by identity,
  so a refresh/reconnect restores them (cleared at each fresh round).

## Deploy
- **Docker:** `docker build -t mc-server . && docker run -p 8787:8787 mc-server`
- **Railway:** push the repo; `railway.json` sets start + `/health` check.
- **Fly:** edit the app name in `fly.toml`, then `fly launch` / `fly deploy`.
Set env vars (`MAX_PLAYERS_PER_ROOM`, `MIN_PLAYERS`, phase timings, `ALLOW_ORIGINS`, …) on the host.

## Horizontal scale-out (beyond one process)
Rooms are independent, so the path to multiple instances is: a sticky-by-room router
(or a shared Redis pub/sub so a room's events fan out across instances). The room/
manager boundary is where that adapter slots in — single-instance is the default here.

MIT licensed.

## See also

- [Meccha Chameleon Atlas](https://mecchachameleon.art/) — Fan-maintained hide-spots reference, paint-match notes, and seeker counter-tips for the paint-based hide-and-seek game Meccha Chameleon. Unofficial, not affiliated with the developer.
