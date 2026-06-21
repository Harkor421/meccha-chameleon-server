// Small shared helpers: input sanitization, a token-bucket-ish rate limiter,
// id/room-code generation, and numeric guards.

export function sanitizeName(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9 _\-\[\]]/g, '').slice(0, 20) || 'Player'
}

// finite clamp; NaN/Inf → 0. Used on all client-reported positions.
export function clampNum(v, lim) {
  const n = +v
  return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0
}

// Fixed-window rate limiter. limiter() returns true if the action is allowed.
export function rateLimiter(maxPerSec) {
  let since = Date.now()
  let count = 0
  return function allow(now = Date.now()) {
    if (now - since >= 1000) { since = now; count = 0 }
    return ++count <= maxPerSec
  }
}

let _seq = 0
export function nextId(prefix = 'p') { return `${prefix}${++_seq}` }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
export function roomCode(len = 4) {
  let s = ''
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return s
}

// Real client IP behind a proxy (Railway/Fly/nginx set x-forwarded-for).
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim()
  return (req.socket && req.socket.remoteAddress) || ''
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
