// The wire protocol — a single source of truth for message types so client and
// server can't drift. The MECCHA CHAMELEON client speaks exactly this.
//
// JSON messages are { t: <type>, ...fields }. Voice is sent as BINARY frames
// (not JSON): client → server uploads a raw Opus packet; server → others sends
// [u8 idLen][idLen bytes ascii sender id][opus bytes].

// server → client
export const S = {
  WELCOME: 'welcome',     // { id, room, spawn, peers:{id:{x,y,z,ry,anim,name,role,tex}}, phase:{phase,deadline,roles,result,host} }
  STATE: 'state',         // { peers:{id:{x,y,z,ry,anim}} }  (positions only, 20Hz)
  PEER_JOIN: 'peer_join', // { id, name, role, state }
  PEER_LEAVE: 'peer_leave', // { id }
  PHASE: 'phase',         // { phase, deadline, roles, result, host }  (host = id of the player allowed to start matches)
  PEER_PAINT: 'peerPaint', // { id, tex }
  CLEAR_PAINT: 'clearPaint', // {}  (fresh round: wipe every peer's synced painted body)
  TAGGED: 'tagged',       // { id }
  SHOT: 'shot',           // { id, x, y, z }  (positional gunshot SFX for hit OR miss)
  FOOTSTEP: 'footstep',   // { id, x, y, z, run }  (positional footstep SFX so peers hear you move)
  REVEAL: 'reveal',       // { id, x, y, z }  (anti-mesh-clip give-away: positional whistle at the buried player)
  WHISTLE: 'whistle',     // {}  (HUNT hint: seekers play a spatial whistle at each hider)
  CHAT: 'chat',           // { id, name, text }
  SERVER_FULL: 'serverFull',
  PONG: 'pong',           // { t0 }
}

// client → server
export const C = {
  SET_PROFILE: 'setProfile', // { name }
  STATE: 'state',            // { x, y, z, ry, anim, q }  (q = optional orientation quaternion)
  PAINT: 'paint',            // { tex }  (one-shot data:image/* dataURL at lock-in)
  TAG: 'tag',                // { target }
  SHOOT: 'shoot',            // { target }  (seeker fires; server relays SFX + validates range)
  SPECTATE: 'spectate',      // { on }  (sit out of the match / rejoin)
  CHAT: 'chat',              // { text }
  PING: 'ping',              // { t0 }
  START_MATCH: 'startMatch', // {}  (skip the lobby countdown: LOBBY/RESULTS → fresh PREP)
  FOOTSTEP: 'footstep',      // { run }  (walk vs run; server attaches the sender's position)
  REVEAL: 'reveal',          // {}  (self-report buried in geometry; server broadcasts your position)
}

export const PHASES = ['LOBBY', 'PREP', 'HUNT', 'RESULTS']
// Roles. WAITING = joined mid-round (HUNT/RESULTS); not eliminated (OUT) — folded into
// the next PREP by assignRoles. The client renders WAITING (like SPECTATOR) as invisible.
export const ROLES = { HIDER: 'hider', SEEKER: 'seeker', OUT: 'out', WAITING: 'waiting', SPECTATOR: 'spectator' }
