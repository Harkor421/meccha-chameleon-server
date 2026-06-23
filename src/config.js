// All server tuning via environment variables, with sane defaults. Copy
// .env.example → .env for local overrides (loaded by index.js if present).

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d)
const str = (v, d) => (v !== undefined && v !== '' ? String(v) : d)

const TIME_SCALE = num(process.env.MC_TIME_SCALE, 1) // <1 speeds rounds up for tests
const ms = (v) => Math.max(1000, Math.round(v * TIME_SCALE))

export const config = {
  host: str(process.env.HOST, '0.0.0.0'),
  port: num(process.env.PORT, 8787),
  logLevel: str(process.env.LOG_LEVEL, 'info'), // debug | info | warn | error
  // CSV of allowed Origins for the WS upgrade ('' = allow all, fine for game clients)
  allowOrigins: str(process.env.ALLOW_ORIGINS, '').split(',').map((s) => s.trim()).filter(Boolean),

  // rooms / capacity
  maxPlayersPerRoom: num(process.env.MAX_PLAYERS_PER_ROOM, 16),
  maxRooms: num(process.env.MAX_ROOMS, 200),
  roomEmptyGraceMs: num(process.env.ROOM_EMPTY_GRACE_MS, 30000), // reap empty rooms after this

  // presence
  tickHz: num(process.env.TICK_HZ, 20),
  heartbeatMs: num(process.env.HEARTBEAT_MS, 30000),
  maxWsBuffered: num(process.env.MAX_WS_BUFFERED, 1 << 20), // skip non-critical sends past this backpressure

  // round
  // LOBBY = pregame warm-up (roam + chat + paint yourself, no seekers/hunting).
  phase: {
    LOBBY: ms(num(process.env.PHASE_LOBBY_MS, 120000)),
    PREP: ms(num(process.env.PHASE_PREP_MS, 30000)),
    HUNT: ms(num(process.env.PHASE_HUNT_MS, 90000)),
    RESULTS: ms(num(process.env.PHASE_RESULTS_MS, 8000)),
  },
  seekerPer: num(process.env.SEEKER_PER, 4), // ~1 seeker per N players
  tagRadius: num(process.env.TAG_RADIUS, 2.8),
  shootRange: num(process.env.SHOOT_RANGE, 50), // 3D range a seeker's gun can hit a hider
  arenaBound: num(process.env.ARENA_BOUND, 80),
  footstepMinMs: num(process.env.FOOTSTEP_MIN_MS, 150), // per-player cap on relayed footsteps
  whistleMs: ms(num(process.env.WHISTLE_MS, 40000)), // HUNT: spatial whistle hint cadence

  // anti-abuse
  msgMaxPerSec: num(process.env.MSG_MAX_PER_SEC, 80),
  paintMaxPerSec: num(process.env.PAINT_MAX_PER_SEC, 4),
  paintMaxLen: num(process.env.PAINT_MAX_LEN, 120000),

  // voice relay
  voice: {
    maxPerSec: num(process.env.VOICE_MAX_PER_SEC, 70),
    maxSpeakers: num(process.env.VOICE_MAX_SPEAKERS, 16),
    activeWindowMs: num(process.env.VOICE_ACTIVE_WINDOW_MS, 500),
  },

  maxPayloadBytes: num(process.env.MAX_PAYLOAD_BYTES, 1 << 20),
}
