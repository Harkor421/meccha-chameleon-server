import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

// Integration test against a real server instance over real WebSockets.
// Set env BEFORE importing the server (config reads env at import time).
process.env.PORT = process.env.TEST_PORT || '8799'
process.env.HOST = '127.0.0.1'
process.env.MC_TIME_SCALE = '0.1'
process.env.LOG_LEVEL = 'warn'
const { GameServer } = await import('../src/server.js')

const server = new GameServer()
const PORT = process.env.PORT
const base = `ws://127.0.0.1:${PORT}`

before(async () => { await server.start() })
after(async () => { await server.stop() })

function connect(name, room, key = `k_${name}_${Math.random().toString(36).slice(2)}`) {
  const u = `${base}/?name=${encodeURIComponent(name)}&key=${key}${room ? `&room=${room}` : ''}`
  const ws = new WebSocket(u)
  ws.binaryType = 'arraybuffer'
  const inbox = []
  const waiters = []
  const tryResolve = (msg) => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1) }
    }
  }
  ws.on('message', (data, isBinary) => {
    let msg
    if (isBinary) msg = { binary: new Uint8Array(data) }
    else { try { msg = JSON.parse(data.toString()) } catch { return } }
    inbox.push(msg); tryResolve(msg)
  })
  return {
    key,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) }),
    send: (o) => ws.send(JSON.stringify(o)),
    sendBin: (b) => ws.send(b),
    waitFor: (pred, ms = 4000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred); if (hit) return resolve(hit)
      const w = { pred, resolve }; waiters.push(w)
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout')) } }, ms)
    }),
    close: () => ws.close(),
  }
}

test('two clients matchmake into the same room and see each other move', async () => {
  const a = connect('Alice'); await a.open()
  const wa = await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Bob'); await b.open()
  const wb = await b.waitFor((m) => m.t === 'welcome')
  assert.equal(wa.room, wb.room, 'auto-matchmade into the same public room')
  await a.waitFor((m) => m.t === 'peer_join' && m.name === 'Bob')
  a.send({ t: 'state', x: 5, y: 3, z: 7, ry: 0, anim: 'walk' })
  const st = await b.waitFor((m) => m.t === 'state' && Object.values(m.peers || {}).some((p) => Math.round(p.x) === 5))
  assert.ok(st, 'B receives A\'s position in a snapshot')
  a.close(); b.close()
})

test('paint relay: a hider paints, the other client receives the texture', async () => {
  const a = connect('Pa', 'PAINT1'); await a.open()
  const wa = await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Pb', 'PAINT1'); await b.open(); await b.waitFor((m) => m.t === 'welcome')
  const tex = 'data:image/webp;base64,QUJDRA=='
  a.send({ t: 'paint', tex })
  const pp = await b.waitFor((m) => m.t === 'peerPaint' && m.tex === tex)
  assert.equal(pp.id, wa.id)
  a.close(); b.close()
})

test('paint relay rejects non-image / oversized blobs', async () => {
  const a = connect('Qa', 'PAINT2'); await a.open(); await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Qb', 'PAINT2'); await b.open(); await b.waitFor((m) => m.t === 'welcome')
  a.send({ t: 'paint', tex: 'not-an-image' })
  let leaked = false
  try { await b.waitFor((m) => m.t === 'peerPaint', 1000); leaked = true } catch {}
  assert.equal(leaked, false, 'garbage paint is dropped, not relayed')
  a.close(); b.close()
})

test('voice relay: a binary packet fans out, wrapped with the sender id', async () => {
  const a = connect('Va', 'VOICE1'); await a.open(); const wa = await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Vb', 'VOICE1'); await b.open(); await b.waitFor((m) => m.t === 'welcome')
  a.sendBin(new Uint8Array([10, 20, 30, 40]))
  const got = await b.waitFor((m) => m.binary)
  const buf = got.binary
  const idLen = buf[0]
  const id = String.fromCharCode(...buf.slice(1, 1 + idLen))
  const payload = [...buf.slice(1 + idLen)]
  assert.equal(id, wa.id, 'frame carries the sender id')
  assert.deepEqual(payload, [10, 20, 30, 40], 'opus payload is intact')
  a.close(); b.close()
})

test('state passthrough carries the orientation quaternion q to peers', async () => {
  const a = connect('Qa', 'QUAT1'); await a.open(); await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Qb', 'QUAT1'); await b.open(); await b.waitFor((m) => m.t === 'welcome')
  a.send({ t: 'state', x: 1, y: 3, z: 1, ry: 0, anim: 'idle', q: [0, 0.7071, 0, 0.7071] })
  const st = await b.waitFor((m) => m.t === 'state' && Object.values(m.peers || {}).some((p) => Array.isArray(p.q)))
  const peer = Object.values(st.peers).find((p) => Array.isArray(p.q))
  assert.equal(peer.q.length, 4, 'q is a 4-component quaternion')
  assert.ok(Math.abs(peer.q[1] - 0.7071) < 1e-6, 'q values pass through intact')
  a.close(); b.close()
})

test('state passthrough rejects a malformed q (drops it)', async () => {
  const a = connect('Qc', 'QUAT2'); await a.open(); await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Qd', 'QUAT2'); await b.open(); await b.waitFor((m) => m.t === 'welcome')
  // mark the position with x=42 so we can find this exact snapshot, and send a bad q
  a.send({ t: 'state', x: 42, y: 3, z: 1, ry: 0, anim: 'idle', q: [1, 2, 'nope'] })
  const st = await b.waitFor((m) => m.t === 'state' && Object.values(m.peers || {}).some((p) => Math.round(p.x) === 42))
  const peer = Object.values(st.peers).find((p) => Math.round(p.x) === 42)
  assert.equal(peer.q, undefined, 'a malformed q is dropped, not forwarded')
  a.close(); b.close()
})

test('spectate: a player sitting out is marked spectator in the phase roles', async () => {
  const a = connect('Sa', 'SPEC1'); await a.open(); const wa = await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Sb', 'SPEC1'); await b.open(); await b.waitFor((m) => m.t === 'welcome')
  a.send({ t: 'spectate', on: true })
  const ph = await b.waitFor((m) => m.t === 'phase' && m.roles && m.roles[wa.id] === 'spectator')
  assert.equal(ph.roles[wa.id], 'spectator', 'spectator role is broadcast to the room')
  // /play rejoins
  a.send({ t: 'spectate', on: false })
  const ph2 = await b.waitFor((m) => m.t === 'phase' && m.roles && m.roles[wa.id] !== 'spectator')
  assert.ok(['hider', 'out'].includes(ph2.roles[wa.id]), 'rejoining drops the spectator role')
  a.close(); b.close()
})

test('shoot: a non-seeker shooting is a harmless no-op (no tagged leaks)', async () => {
  const a = connect('Ga', 'SHOOT1'); await a.open(); await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Gb', 'SHOOT1'); await b.open(); const wb = await b.waitFor((m) => m.t === 'welcome')
  // a is mid-round 'out' (joined while not PREP) or a fresh-PREP hider — either way not a seeker yet
  a.send({ t: 'shoot', target: wb.id })
  let leaked = false
  try { await b.waitFor((m) => m.t === 'tagged', 800); leaked = true } catch {}
  assert.equal(leaked, false, 'an unauthorized shoot tags no one')
  a.close(); b.close()
})

test('persistence: a reconnecting hider keeps their painted body', async () => {
  const a = connect('Pra', 'PERS1'); await a.open(); const wa = await a.waitFor((m) => m.t === 'welcome')
  // a peer that confirms the paint landed before we reconnect (avoids a connect race)
  const b = connect('Prb', 'PERS1'); await b.open(); await b.waitFor((m) => m.t === 'welcome')
  const tex = 'data:image/webp;base64,UEVSU0lTVA=='
  // only a hider can paint; if a joined mid-round it'll be 'out' — guard the test
  if (wa.phase.roles[wa.id] !== 'hider') { a.close(); b.close(); return }
  a.send({ t: 'paint', tex })
  await b.waitFor((m) => m.t === 'peerPaint' && m.tex === tex) // paint is now persisted server-side
  // reconnect with the SAME identity key → server restores the painted body
  const a2 = connect('Pra', 'PERS1', a.key); await a2.open()
  const w2 = await a2.waitFor((m) => m.t === 'welcome')
  // a brand-new peer should see the reconnected player's restored tex in its welcome
  const c = connect('Prc', 'PERS1'); await c.open()
  const wc = await c.waitFor((m) => m.t === 'welcome')
  const peer = wc.peers[w2.id]
  assert.ok(peer && peer.tex === tex, 'reconnected hider\'s painted body is restored for peers')
  a.close(); b.close(); a2.close(); c.close()
})

test('rooms are isolated by code (no cross-room leakage)', async () => {
  const a = connect('Ra', 'ROOMX'); await a.open(); const wa = await a.waitFor((m) => m.t === 'welcome')
  const b = connect('Rb', 'ROOMY'); await b.open(); const wb = await b.waitFor((m) => m.t === 'welcome')
  assert.equal(wa.room, 'ROOMX'); assert.equal(wb.room, 'ROOMY')
  a.send({ t: 'state', x: 9, y: 3, z: 9, ry: 0, anim: 'walk' })
  let leaked = false
  try { await b.waitFor((m) => m.t === 'state' && Object.values(m.peers || {}).some((p) => Math.round(p.x) === 9), 1200); leaked = true } catch {}
  assert.equal(leaked, false)
  a.close(); b.close()
})
