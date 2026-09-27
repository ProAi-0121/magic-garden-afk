# magic-garden-afk

A small AFK squad for [Magic Garden](https://magicgarden.gg). It spins up a few
guest accounts, drops all of them into one room, and keeps them there — auto
reconnects on disconnects and respawns a fresh guest when the server ends the
session for good.

## Features

- Multiple guest accounts, staggered login so they don't all hit at once
- Reconnect with backoff, including reclaiming a superseded session (4250/4300)
- Respawns a new guest on fatal close codes (kicked, banned, session expired, …)
- Live TUI dashboard: per-account state, uptime, reconnect/respawn counters, recent log
- Keyboard controls: `g` dumps guest cookies, `q` quits cleanly

## Requirements

- Node.js 18+ (uses global `fetch`)
- npm

## Setup

```bash
npm install
cp .env.example .env
```

## Configuration

| Variable    | Default | Description              |
| ----------- | ------- | ------------------------ |
| `AFK_ROOM`  | `B86C`  | Room code to idle in     |
| `AFK_COUNT` | `5`     | Number of guest accounts |

No credentials needed — guests are created through the game's device-account
endpoint and are temporary by design.

## Usage

```bash
npm start
```

Keys: `q` quit, `g` save account cookies to `dumps/afk_accounts.json`.

## Project Structure

```
├── afk.js             # Entry point: provisioning + AFK squad manager
├── connection.js      # WebSocket connection (handshake, keepalive, reconnect)
├── utils/version.js   # Resolves the room's game version
└── dumps/             # Cookie dumps (generated, gitignored)
```

## Troubleshooting

- **Version expired / mismatch** — handled automatically; the room's version is
  re-fetched before every reconnect.
- **Guest accounts keep getting kicked** — that's the game enforcing one active
  session per guest; the squad reclaims the session after 30s by default.
- **Weird characters in the dashboard** — needs a terminal with UTF-8 and
  ANSI support (Windows Terminal works fine).
