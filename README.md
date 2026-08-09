<div align="center">

# meccha-chameleon-server

### El servidor autoritativo que escala el escondite

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white) ![WebSocket](https://img.shields.io/badge/WebSocket-1F2937?style=for-the-badge&logo=socketdotio&logoColor=white) ![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white) ![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white) ![Fly.io](https://img.shields.io/badge/Fly.io-24175B?style=for-the-badge&logo=flydotio&logoColor=white)

[**📦 Repositorio**](https://github.com/Harkor421/meccha-chameleon-server)

</div>

---

## 📖 Sobre el proyecto

Servidor de juego WebSocket autoritativo y escalable horizontalmente para **MECCHA CHAMELEON**. Es dueño de la verdad del juego —presencia, flujo de rondas, roles, tagging y el bus de voz— para que los clientes no puedan hacer trampa, y está hecho para sostener muchas salas en un solo proceso Node.

## ✨ Qué hace

- Autoritativo: el servidor decide roles, rondas y resultados
- Multi-sala con gestor de salas y sharding horizontal
- Relay de voz estilo SFU
- Métricas y protocolo versionado, con tests y load test
- Dependencia única (`ws`) · Docker, Railway y Fly.io

## 🧰 Stack

| | |
|---|---|
| **Lenguajes y runtime** | ![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white) |
| **Backend** | ![WebSocket](https://img.shields.io/badge/WebSocket-1F2937?style=for-the-badge&logo=socketdotio&logoColor=white) |
| **Infraestructura** | ![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white) ![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white) ![Fly.io](https://img.shields.io/badge/Fly.io-24175B?style=for-the-badge&logo=flydotio&logoColor=white) |

## 🚀 Empezar

```bash
git clone https://github.com/Harkor421/meccha-chameleon-server.git
cd meccha-chameleon-server
npm install
npm run dev
```

## ⚙️ Variables de entorno

Copia `.env.example` a `.env` y completa los valores:

| Variable | Ejemplo / valor por defecto |
|---|---|
| `HOST` | `0.0.0.0` |
| `PORT` | `8787` |
| `LOG_LEVEL` | `info               # debug | info | warn | error` |
| `MAX_PLAYERS_PER_ROOM` | `16` |
| `MAX_ROOMS` | `200` |
| `ROOM_EMPTY_GRACE_MS` | `30000` |
| `TICK_HZ` | `20` |
| `HEARTBEAT_MS` | `30000` |
| `MAX_WS_BUFFERED` | `1048576       # drop voice to a client whose send buffer exc` |
| `PHASE_LOBBY_MS` | `120000        # pregame warm-up: roam + chat + paint yoursel` |
| `PHASE_PREP_MS` | `30000` |
| `PHASE_HUNT_MS` | `90000` |
| `PHASE_RESULTS_MS` | `8000` |
| `MC_TIME_SCALE` | `1              # <1 speeds rounds up (e.g. 0.1 for tests/dem` |
| `MIN_PLAYERS` | `2                # min non-spectators to start a round (else` |
| `SEEKER_PER` | `4                 # ~1 seeker per N players` |

## 📜 Scripts

| Comando | Qué hace |
|---|---|
| `npm run start` | Arranca la aplicación |
| `npm run dev` | Servidor de desarrollo con recarga en caliente |
| `npm run test` | Ejecuta la suite de tests |
| `npm run loadtest` | `node test/loadtest.mjs` |

## ☁️ Despliegue

- **Railway** (`railway.json` / `nixpacks.toml`)
- **Fly.io**
- **Docker**

---

<div align="center">

Hecho por [**Samir González**](https://github.com/Harkor421)

</div>
