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

function connect(name, room) {
  const key = `k_${name}_${Math.random().toString(36).slice(2)}`
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
