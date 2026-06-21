// The wire protocol — a single source of truth for message types so client and
// server can't drift. The MECCHA CHAMELEON client speaks exactly this.
//
// JSON messages are { t: <type>, ...fields }. Voice is sent as BINARY frames
// (not JSON): client → server uploads a raw Opus packet; server → others sends
// [u8 idLen][idLen bytes ascii sender id][opus bytes].

// server → client
export const S = {
  WELCOME: 'welcome',     // { id, room, spawn, peers:{id:{x,y,z,ry,anim,name,role,tex}}, phase:{phase,deadline,roles,result} }
  STATE: 'state',         // { peers:{id:{x,y,z,ry,anim}} }  (positions only, 20Hz)
  PEER_JOIN: 'peer_join', // { id, name, role, state }
  PEER_LEAVE: 'peer_leave', // { id }
  PHASE: 'phase',         // { phase, deadline, roles, result }
  PEER_PAINT: 'peerPaint', // { id, tex }
  TAGGED: 'tagged',       // { id }
  CHAT: 'chat',           // { id, name, text }
  SERVER_FULL: 'serverFull',
  PONG: 'pong',           // { t0 }
}

// client → server
export const C = {
  SET_PROFILE: 'setProfile', // { name }
  STATE: 'state',            // { x, y, z, ry, anim }
  PAINT: 'paint',            // { tex }  (one-shot data:image/* dataURL at lock-in)
  TAG: 'tag',                // { target }
  CHAT: 'chat',              // { text }
  PING: 'ping',              // { t0 }
}

export const PHASES = ['PREP', 'HUNT', 'RESULTS']
export const ROLES = { HIDER: 'hider', SEEKER: 'seeker', OUT: 'out' }
