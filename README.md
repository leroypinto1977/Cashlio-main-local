# Cashlio — Main Local (App B)

The Electron desktop application installed on the shop's server PC. Runs a local Express API on the LAN that both the Manager UI (built-in) and billing terminals (App C) connect to. Manages the local PostgreSQL database, handles license activation, cashier auth, and device pairing.

## Tech Stack

- **Desktop**: Electron 39
- **Renderer**: React 19 + Vite (electron-vite)
- **Local API**: Express 5 (port `52001`, all interfaces `0.0.0.0`)
- **Database**: PostgreSQL (local) via Prisma ORM
- **Auth**: JWT (jsonwebtoken) — cashier session tokens
- **Passwords**: bcryptjs
- **UI**: Tailwind CSS + Shadcn UI

## Prerequisites

- Node.js 20+
- A locally running PostgreSQL instance
- App A (admin-saas) running and reachable for license activation

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DATABASE_URL` | Local PostgreSQL connection string |
| `LOCAL_SERVER_PORT` | Port for the Express API (default: `52001`) |
| `SAAS_API_URL` | URL of App A — used to proxy license activation |
| `JWT_SECRET` | Signs cashier session JWTs — **must match `JWT_SECRET` in `admin-saas`** |
| `VITE_LOCAL_API_URL` | Renderer-facing API URL (e.g. `http://127.0.0.1:52001`) |

### 3. Run database migrations

```bash
npx prisma migrate deploy
```

## Development

```bash
npm run dev
```

Starts the Vite renderer dev server and launches the Electron window. DevTools open automatically as a detached window.

## Build

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

## First-Launch Flow

1. **Splash** — 3-second loading screen while the app checks setup status
2. **License Activation** — Enter the license key provided by the admin; the app proxies activation to App A and stores the signed JWT locally
3. **Shop Profile Setup** — Set shop name, branch name, location, GST/Tax ID, and create the Super Admin account
4. **Manager Dashboard** — Sidebar with Overview, Devices (App C terminals), and Settings tabs

## Express API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/system/status` | Returns setup status and shop info |
| `POST` | `/api/v1/system/save-config` | Activates license (proxies to App A) |
| `POST` | `/api/v1/system/setup-profile` | Creates Super Admin and saves shop details |
| `POST` | `/api/v1/system/pair-client` | Registers an App C terminal (checks license slot limit) |
| `GET` | `/api/v1/system/authorized-clients` | Lists all paired billing terminals |
| `POST` | `/api/v1/auth/login` | Authenticates a cashier, returns a JWT |

## Project Structure

```
src/
├── main/
│   ├── index.ts         # Electron main process (window, IPC, MAC address)
│   └── server.ts        # Express API server
├── preload/
│   └── index.ts         # Context bridge (exposes ipcRenderer to renderer)
└── renderer/
    └── src/
        └── App.tsx      # All UI screens (Splash → License → Profile → Dashboard)
prisma/
└── schema.prisma        # Local DB schema (ShopConfig, User, AuthorizedClient, Invoice)
```
