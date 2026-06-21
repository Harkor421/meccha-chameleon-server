// Minimal .env loader (no dependency). MUST be imported BEFORE any module that
// reads config (config.js reads process.env at import time), so index.js imports
// this first. Real env vars always win over the file.
import { readFileSync, existsSync } from 'node:fs'

const path = process.env.ENV_FILE || '.env'
if (existsSync(path)) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
