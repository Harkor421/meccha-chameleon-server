// Load/stress bot: spawns N fake players that walk randomly and occasionally
// "talk" (binary voice packets), to exercise the server at scale.
//
//   node test/loadtest.mjs [count=100] [roomsMode]
//     roomsMode: omit/"mm" = matchmake into public rooms;
//                a CODE      = everyone piles into one room;
//                "spread:K"  = K players per private room
//
// Watch live load at GET http://<host>/health while it runs.
import { WebSocket } from 'ws'

const WS = process.env.URL || 'ws://127.0.0.1:8787'
const HTTP = WS.replace(/^ws/, 'http')
const COUNT = +(process.argv[2] || 100)
const MODE = process.argv[3] || 'mm'
const DURATION_MS = +(process.env.DURATION_MS || 20000)

function roomFor(i) {
  if (MODE === 'mm') return ''
  if (MODE.startsWith('spread:')) { const k = +MODE.split(':')[1] || 8; return `LT${Math.floor(i / k)}` }
  return MODE
}

let connected = 0, failed = 0
const bots = []
for (let i = 0; i < COUNT; i++) {
  const room = roomFor(i)
  const u = `${WS}/?name=Bot${i}&key=bot_${i}_${Math.random().toString(36).slice(2)}${room ? `&room=${room}` : ''}`
  const ws = new WebSocket(u)
  ws.binaryType = 'arraybuffer'
  ws.on('open', () => {
    connected++
    let a = Math.random() * Math.PI * 2
    const move = setInterval(() => {
      if (ws.readyState !== 1) return clearInterval(move)
      a += (Math.random() - 0.5) * 0.4
      ws.send(JSON.stringify({ t: 'state', x: Math.cos(a) * 10, y: 1.4, z: Math.sin(a) * 10, ry: a, anim: 'walk' }))
      if (Math.random() < 0.15) ws.send(new Uint8Array(60)) // ~15% of bots "talk"
    }, 50) // 20Hz
    ws._move = move
  })
  ws.on('error', () => { failed++ })
  bots.push(ws)
}

const stats = setInterval(async () => {
  let health = ''
  try { health = await (await fetch(`${HTTP}/health`)).text() } catch {}
  console.log(`connected=${connected} failed=${failed} ${health}`)
}, 2000)

setTimeout(() => {
  clearInterval(stats)
  for (const ws of bots) { try { clearInterval(ws._move); ws.close() } catch {} }
  console.log('load test done')
  setTimeout(() => process.exit(0), 500)
}, DURATION_MS)
