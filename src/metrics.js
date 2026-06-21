// Lightweight metrics: counters + a live snapshot, exposed over HTTP (/health,
// /metrics JSON, /metrics in Prometheus text format).

const startedAt = Date.now()

export const counters = {
  connections_total: 0,
  disconnections_total: 0,
  rooms_created_total: 0,
  messages_in_total: 0,
  voice_packets_relayed_total: 0,
  paint_syncs_total: 0,
  tags_total: 0,
  rejected_full_total: 0,
}
export const inc = (k, n = 1) => { counters[k] = (counters[k] || 0) + n }

// `live` is set by the GameServer so metrics can report current room/player counts.
let live = () => ({ rooms: 0, players: 0 })
export const setLiveSource = (fn) => { live = fn }

export function snapshot() {
  return {
    status: 'ok',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    ...live(),
    counters: { ...counters },
  }
}

export function prometheus() {
  const s = snapshot()
  const lines = [
    `# HELP mc_uptime_seconds Server uptime`,
    `mc_uptime_seconds ${s.uptimeSec}`,
    `mc_rooms ${s.rooms}`,
    `mc_players ${s.players}`,
  ]
  for (const [k, v] of Object.entries(s.counters)) lines.push(`mc_${k} ${v}`)
  return lines.join('\n') + '\n'
}
