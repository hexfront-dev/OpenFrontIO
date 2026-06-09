# Deployment Guide — Self-Hosted OpenFront.io on Fly.io

## Architecture

- **Hosting:** Fly.io, 1 machine, `shared-cpu-1x`, 512MB RAM, region `ams`
- **App URL:** https://openfrontio.fly.dev
- **Repo:** https://github.com/hexfront-dev/OpenFrontIO
- **Auto-deploy:** Fly.io GitHub integration — pushes to `main` trigger a rebuild

The app runs in a Docker container (nginx + Node.js + supervisord). Nginx listens on port 80 and proxies to the Node.js game server on port 3000 (master) and 3001 (worker 0).

## Critical Configuration

These settings MUST be correct or the app breaks:

| Setting | Correct Value | Why |
|---------|--------------|-----|
| `internal_port` | `80` | Nginx listens on 80. Fly.io default is 8080 — this breaks routing |
| `GAME_ENV` | `dev` | `prod`/`staging` require the closed-source API for auth |
| `CDN_BASE` | `https://openfrontio.fly.dev` | Web Workers need absolute URLs to fetch map data |
| `NUM_WORKERS` | `1` | Must be set or server crashes |
| `TURNSTILE_SITE_KEY` | `disabled` | Must be set or server crashes |
| `DOMAIN` | `openfrontio.fly.dev` | Used for JWT audience |
| `SUBDOMAIN` | `main` | Used for routing |

## The Correct fly.toml

```toml
app = 'openfrontio'
primary_region = 'ams'

[build]

[env]
  GAME_ENV = "dev"
  DOMAIN = "openfrontio.fly.dev"
  SUBDOMAIN = "main"
  NUM_WORKERS = "1"
  TURNSTILE_SITE_KEY = "disabled"
  CDN_BASE = "https://openfrontio.fly.dev"

[http_service]
  internal_port = 80
  force_https = true
  auto_stop_machines = 'stop'
  auto_start_machines = true
  min_machines_running = 0
  processes = ['app']

[[vm]]
  cpu_kind = 'shared'
  cpus = 1
  memory_mb = 512
```

## Code Modifications (vs upstream)

These files were modified for self-hosting:

| File | Change |
|------|--------|
| `src/server/Turnstile.ts` | Always returns "approved" (no Cloudflare API) |
| `src/server/MasterLobbyService.ts` | `maybeScheduleLobby()` returns immediately (no public games) |
| `src/client/Main.ts` | `getTurnstileToken()` returns dummy token |
| `src/client/GoogleAdElement.ts` | Renders nothing |
| `src/client/HomepagePromos.ts` | Renders nothing |
| `src/client/components/DesktopNavBar.ts` | Removed Sign In and Store buttons |
| `src/client/components/MobileNavBar.ts` | Removed Sign In and Store buttons |

## Common Failure Modes

### 502 Bad Gateway

**Cause 1: Wrong `internal_port`**
Fly.io expects traffic on port 8080 but nginx listens on 80.

Fix:
```bash
# Check current config
fly machines list -a openfrontio --json | python3 -c "
import sys, json
for m in json.load(sys.stdin):
    for s in m.get('config',{}).get('services',[]):
        print(f'internal_port={s.get(\"internal_port\")}')"

# If it shows 8080, the fly.toml wasn't applied. Redeploy:
fly deploy --remote-only -a openfrontio
```

**Cause 2: Server not started yet**
After deploy, tsx transpilation takes ~30-60 seconds. Wait and retry.

**Cause 3: Out of memory**
If machine is 256MB, it will OOM during tsx startup. Must be 512MB.
```bash
fly scale memory 512 -a openfrontio
```

### "unsupported game env: undefined"

`GAME_ENV` not set. Fix:
```bash
fly secrets set GAME_ENV=dev -a openfrontio
```

### "Worker initialization timeout" (client-side)

The browser Web Worker can't fetch map files. Usually means `CDN_BASE` is empty.
```bash
fly secrets set CDN_BASE=https://openfrontio.fly.dev -a openfrontio
```

### "Turnstile error: 400020"

Client-side Turnstile is trying to validate. The code change in `Main.ts` (`getTurnstileToken`) must return a dummy token. If this reappears, the code was overwritten (e.g., by merging upstream).

### Fly.io creates machine with wrong config

This happens when someone runs `fly launch` — it creates a new machine with Fly.io defaults (port 8080, staging env, empty CDN). **Never run `fly launch` on this app.** Use `fly deploy` instead.

If it happens:
1. Destroy the bad machine: `fly machines destroy <ID> -a openfrontio --force`
2. Deploy fresh: `fly deploy --remote-only -a openfrontio`

Or: accept Fly.io's PR, then immediately overwrite `fly.toml` with the correct version above and push.

## Tokens & Access

- **Fly.io token:** stored in `/home/emicjac/.flytoken` (personal access token)
- **GitHub token:** stored in `/home/emicjac/.ghtoken` (fine-grained, expires periodically)
- **Fly.io account:** linked to `mmrsjacobsson@gmail.com`
- **GitHub account:** `hexfront-dev`

## Useful Commands

```bash
# Check app status
fly status -a openfrontio

# View logs
fly logs -a openfrontio --no-tail

# SSH into the container
fly ssh console -a openfrontio -C "ss -tlnp"
fly ssh console -a openfrontio -C "cat /var/log/nginx/error.log"
fly ssh console -a openfrontio -C "tail -20 /var/log/nginx/access.log"

# Check memory
fly ssh console -a openfrontio -C "cat /proc/meminfo"

# Set env vars (restarts machines)
fly secrets set KEY=value -a openfrontio

# Scale memory
fly scale memory 512 -a openfrontio

# Deploy (builds remotely on Fly.io)
fly deploy --remote-only -a openfrontio

# Destroy a broken machine
fly machines destroy <ID> -a openfrontio --force
```

## Adding Custom Maps

1. Create `map-generator/assets/maps/<mapname>/image.png` (terrain from blue channel)
2. Create `map-generator/assets/maps/<mapname>/info.json`
3. Add `{Name: "<mapname>"}` to `map-generator/main.go`
4. Run: `cd map-generator && go run . --maps=<mapname>`
5. Add enum value to `src/core/game/Game.ts` (GameMapType + mapCategories)
6. Add to `resources/lang/en.json` (map translations section)
7. Commit all generated files in `resources/maps/<mapname>/` + source files
8. Push to main → auto-deploys

**Important:** The folder name must be the enum key lowercased (e.g., `SixIslands` → `sixislands`).

## DO NOT

- **Do NOT run `fly launch`** — it overwrites the machine config
- **Do NOT set `GAME_ENV=prod`** — requires closed-source Cloudflare API
- **Do NOT set `CDN_BASE=""`** — breaks Web Worker map loading
- **Do NOT set `internal_port=8080`** — nginx is on port 80
- **Do NOT merge upstream without checking** — upstream has Turnstile, ads, and auth code that will break self-hosting
