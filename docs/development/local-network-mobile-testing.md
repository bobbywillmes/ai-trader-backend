# Local Network and Mobile Device Testing

This guide explains how to open the local AI Trader web application on a phone, tablet, or another computer connected to the same private network.

## Architecture

During local-network testing, the request flow is:

```text
Mobile device
  |
  | http://<DEV_PC_LAN_IP>:5173
  v
Vite development server
  |
  | /api proxy
  v
Backend at http://127.0.0.1:3000
```

Only the Vite development server is exposed to the local network. The backend continues listening locally and is reached through the Vite proxy.

## Repository configuration

The Vite development server is configured in:

```text
apps/web/vite.config.ts
```

```ts
server: {
  host: "0.0.0.0",
  port: 5173,
  proxy: {
    "/api": {
      target: "http://127.0.0.1:3000",
      changeOrigin: true,
    },
  },
},
```

The web API client uses relative API URLs by default:

```ts
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() || "";
```

The local web environment should therefore contain:

```env
VITE_API_BASE_URL=
```

This causes requests such as `/api/auth/login` to reach Vite first. Vite then proxies them to the local backend.

## Find the development PC's LAN address

On Windows, run:

```powershell
ipconfig
```

Under the active Wi-Fi adapter, locate the IPv4 address:

```text
IPv4 Address . . . . . . . . . . : 192.168.1.102
```

Ignore addresses associated with Docker, WSL, Hyper-V, VPNs, or disconnected network adapters.

The LAN address may change because it is normally assigned by the router through DHCP. Always verify it when connecting from a different network.

## Configure the backend CORS allowlist

In the root `.env`, append the complete Vite origin:

```env
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:4173,http://192.168.1.102:5173
```

Replace `192.168.1.102` with the PC's current Wi-Fi IPv4 address.

Do not hardcode a personal LAN address into `.env.example`. The example file should use a placeholder or explanatory comment instead.

Restart the backend after changing the root `.env`.

## Start the development servers

Start the backend from the repository root:

```bash
npm run dev
```

Start the web application from `apps/web`:

```bash
npm run dev
```

Because `host` is configured in `vite.config.ts`, the `--host` command-line argument is not required.

Vite should display a network URL similar to:

```text
Network: http://192.168.1.102:5173/
```

## Open the application on another device

Connect the device to the same Wi-Fi network and visit:

```text
http://192.168.1.102:5173
```

Use the exact address displayed by Vite.

Do not use `localhost` from the mobile device. On the mobile device, `localhost` refers to the mobile device itself.

## Windows Firewall

Allow Node.js through Windows Firewall for **Private networks**.

Do not enable the rule for Public networks unless there is a specific, temporary reason to do so.

## Troubleshooting

### The page does not load

Confirm that:

1. Both devices are connected to the same Wi-Fi network.
2. Vite displays the expected LAN address.
3. Node.js is allowed through the Windows Private network firewall.
4. The Wi-Fi network does not use client isolation or guest-device isolation.
5. Port `5173` is still the active Vite port.

### Login returns `CORS origin not allowed`

Add the exact mobile-facing Vite origin to the root `.env`:

```env
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:4173,http://<DEV_PC_LAN_IP>:5173
```

Then restart the backend.

The origin must include:

- Protocol: `http://`
- LAN address
- Vite port: `5173`

### Vite reports `ECONNREFUSED`

Confirm that the backend is running at:

```text
http://127.0.0.1:3000
```

Test it from the development PC:

```bash
curl http://127.0.0.1:3000/health
```

If the backend uses another port, update the Vite proxy target accordingly.

### The address worked previously but stopped working

Run `ipconfig` again. The router may have assigned the PC a different DHCP address.

Update the root `.env`, restart the backend, and use the new Vite network URL.

## Security notes

Use this setup only on a trusted private network.

The Vite server listens on all local interfaces while it is running. Stop the development server when testing is complete, and keep the Windows Firewall permission limited to Private networks.

## Files to commit

A clean commit can include:

```text
apps/web/vite.config.ts
apps/web/src/lib/api.ts
.env.example
docs/development/local-network-mobile-testing.md
```

The actual root `.env` and its machine-specific LAN address should remain local and uncommitted.
