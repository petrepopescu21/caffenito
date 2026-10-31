# Caffenito: the Awake Coffee Discord bot

Caffenito runs the **Awake Coffee Community** Discord server. It welcomes people, handles moderation, announces when the shop opens and closes, and roasts members with `/bully`, using Claude.

It runs on **Fly.io** as the app `awake-discord-bot`. Its public HTTPS API is at <https://awake-discord-bot.fly.dev>.

---

## What it does

| Feature | Commands / endpoints | Who can use it |
|---|---|---|
| **Welcome + auto-role** | (automatic) | The bot welcomes new members in `#welcome` and gives them the default role |
| **Moderation** | `/kick`, `/ban`, `/timeout`, `/purge` (all logged to the mod-log channel) | People with the matching Discord permission |
| **Shop status** | `/shop open\|closed [note]` | Staff: Robert, Admin, Barista, or anyone with Manage Messages |
| | `POST /api/shop/status` | Anyone with the API token |
| | `GET /api/shop/status` | Public |
| **Roasts** | `/bully @someone` | Roles allowed in Integrations (see [Discord settings](#discord-settings)) |
| **Profiles** | `/dossier @someone`, `/intel add\|remove`, right-click a message → **Apps → Add to dossier**, `/backfill` | `/dossier`: as allowed in Integrations; `/intel` and Add to dossier: staff; `/backfill`: Manage Server |

**A shop status change**, whether from `/shop` or the API:
- posts an announcement in the status channel and pings the `@matinali` role
- renames that channel to `🟢┃awake-deschis` or `🔴┃awake-închis`
- swaps the server banner (`assets/banner-open.png` or `banner-closed.png`)
- sets the bot's own Discord status
- is saved, so it survives restarts

Repeating the same status does nothing.

**`/bully` learns who people are from conversations:**
- Each channel keeps a transcript of new messages, including who replied to whom.
- Every 6 hours, or once a channel has 60 new messages, Claude (`claude-opus-5-5`, high effort) revises the profiles of the people who spoke. A profile holds traits (with evidence and confidence), a role in the group, relationships, humour style, contradictions and roast angles. There's also a summary of the group as a whole.
- Processed messages are then dropped, so Claude never re-reads old history.
- A roast uses the target's profile, staff facts, and their latest ~15 lines of conversation.
- Profiles never record health, appearance, religion, ethnicity, sexuality, politics, money or contact details.

---

## Set up a new machine

### 1. Install the tools

| Tool | Why | Install |
|---|---|---|
| **Git** | Get the code | <https://git-scm.com/downloads> |
| **Node.js 22 or newer** (includes npm) | Run scripts and test locally | <https://nodejs.org> (LTS) |
| **flyctl** | Deploy and manage the bot on Fly.io | See below |
| *Python 3.10+* (optional) | Only to regenerate the banners or QR codes | <https://www.python.org/downloads/> |

Install **flyctl**:

```powershell
# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

```bash
# macOS
brew install flyctl
```

```bash
# Linux (or macOS without Homebrew)
curl -L https://fly.io/install.sh | sh
```

Open a new terminal afterwards so `fly` is on your PATH, and check it with `fly version`. On Windows the binary is `%USERPROFILE%\.fly\bin\flyctl.exe`.

### 2. Get the code and log in to Fly

```bash
git clone <this repo's URL> awakediscordbot
```

```bash
cd awakediscordbot
```

```bash
npm install
```

```bash
fly auth login
```

```bash
fly status -a awake-discord-bot
```

`fly auth login` opens your browser; sign in with the Fly account that owns the app. `fly status` should show one machine in `ams` in the `started` state.

### 3. Create `.env` (only for local runs and the scripts)

**You don't need `.env` to deploy.** Fly keeps its own copy of every secret. You need it only to run the bot locally or to run the `scripts/` and `src/deploy-commands.js` from your machine.

Copy `.env.example` to `.env`. These values aren't secret and are the current ones:

```ini
CLIENT_ID=1564700464187048105
GUILD_ID=1564678482657681572
WELCOME_CHANNEL_ID=1564703115230449674
DEFAULT_ROLE_ID=1564703509218070629
MOD_LOG_CHANNEL_ID=1564702984686936164
SHOP_CHANNEL_ID=1566057550993035427
SHOP_PING_ROLE_ID=1564702836585930762
SHOP_NAME=Awake Coffee
STAFF_ROLE_IDS=1564702651608735754,1564702720273686628,1564706244269309983
```

The **secrets** aren't in git, and **neither Fly nor Discord will show them to you again**. Fly secrets can be written but not read back, and Discord shows a bot token only once. So:

| Secret | Where to get it |
|---|---|
| `DISCORD_TOKEN` | Copy it from the old machine's `.env`, ideally through a password manager. If it's lost, reset it in the [Developer Portal](https://discord.com/developers/applications) (Caffenito → Bot → **Reset Token**). The old token stops working **immediately**, so the live bot goes offline until you also run `fly secrets set DISCORD_TOKEN=<new token> -a awake-discord-bot`. |
| `SHOP_API_TOKEN` | Only needed if you call the API from this machine. Copy it from wherever the register tablet's app stores it, or rotate it (see [Shop API](#shop-api)) and update the tablet too. |
| `ANTHROPIC_API_KEY` | Only for testing `/bully` **locally**. The live bot uses Workload Identity Federation and has no key (see [Claude](#claude-workload-identity-federation)). |

### 4. Check that everything works

```bash
fly logs -a awake-discord-bot --no-tail
```

You should see `Logged in as Caffenito#2927` and `/bully enabled: learning from chat.` You're set up.

---

## Deploying changes

```bash
fly deploy --ha=false
```

- **Always pass `--ha=false`.** The bot must run as **exactly one machine**. Two would welcome everyone twice, answer every command twice, and fight over the saved state.
- The image is built on Fly's servers, so you don't need Docker locally.
- On every start, the bot registers its slash commands with Discord automatically, so new or changed commands appear after a deploy.
- Watch it come up with `fly logs -a awake-discord-bot`.

### Running locally

**Don't run a second copy while the live one is running**: both would answer everything. Either test with a separate Discord application and test server, or pause production first:

```bash
fly scale count 0 -a awake-discord-bot --yes
```

```bash
npm start
```

```bash
fly scale count 1 -a awake-discord-bot --yes
```

Locally, the data goes to `./data/` (git-ignored). `/bully` needs `ANTHROPIC_API_KEY` in `.env`.

---

## Operations cheat sheet

| Task | Command |
|---|---|
| Live logs | `fly logs -a awake-discord-bot` |
| Status / machine | `fly status -a awake-discord-bot` |
| Shell in the machine | `fly ssh console -a awake-discord-bot` |
| List secrets (names only) | `fly secrets list -a awake-discord-bot` |
| Change a secret (restarts the bot) | `fly secrets set NAME=value -a awake-discord-bot` |
| Back up the bot's memory | `fly ssh sftp get /data/state.json state-backup.json -a awake-discord-bot` |
| Rebuild all profiles from history | `/backfill` in Discord (Manage Server) |
| Health check | <https://awake-discord-bot.fly.dev/health> |

**Storage:** everything the bot remembers is in `/data/state.json`, on the Fly volume `caffenito_data` (1 GB, `ams`): profiles, staff facts, unprocessed chat, the shop status and schedules. Fly takes daily snapshots, kept for 5 days (`fly volumes snapshots list`). The volume ties the machine to `ams`.

---

## Configuration reference

| Variable | Where it's set | What it does |
|---|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` | Fly secret | Bot login and server |
| `WELCOME_CHANNEL_ID`, `DEFAULT_ROLE_ID` | Fly secret | Welcome message and auto-role (leave blank to turn off) |
| `MOD_LOG_CHANNEL_ID` | Fly secret | Where moderation actions are logged |
| `SHOP_CHANNEL_ID` | Fly secret | The status channel (`🟢┃awake-deschis`) |
| `SHOP_PING_ROLE_ID` | Fly secret | Role pinged on status changes (`@matinali`) |
| `SHOP_NAME` | Fly secret | Name used in announcements |
| `SHOP_API_TOKEN` | Fly secret | Bearer token for `POST /api/shop/status` |
| `STAFF_ROLE_IDS` | `fly.toml` `[env]` | Roles allowed to use `/shop` and `/intel` (Robert, Admin, Barista) |
| `DATA_DIR` | `fly.toml` `[env]` | `/data`, the volume |
| `FLY_OIDC_AUDIENCE`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_WORKSPACE_ID` | `fly.toml` `[env]` | Claude via Workload Identity Federation (not secrets) |
| `BULLY_CHANNEL_IDS` | optional | Only learn from these channels (default: every channel the bot can see) |
| `ANTHROPIC_API_KEY` | local `.env` only | Claude for local testing |
| `PORT` | default `8080` | HTTP API port inside the container |

---

## Shop API

Base URL: `https://awake-discord-bot.fly.dev`. Interactive docs are at [`/docs`](https://awake-discord-bot.fly.dev/docs) and the OpenAPI 3.1 schema at [`/openapi.json`](https://awake-discord-bot.fly.dev/openapi.json).

```
GET  /api/shop/status        public → {"status": "open"|"closed", "since", "note", "by"}
POST /api/shop/status        Authorization: Bearer <SHOP_API_TOKEN>
                             {"status": "open"|"closed", "note"?: "max 500 chars"}
                             → 200 {"changed": true|false, ...state}
```

- **Errors:** `400` bad body · `401` wrong token · `429` more than 10 changes a minute · `503` bot reconnecting (retry shortly).
- **Always use `https://`.** Plain HTTP is redirected, but by then the token has already been sent unencrypted.
- **Who uses it:** the automation app on the register tablet.
- **Rotate the token** (prints the new one once, then update the tablet):

  ```powershell
  $t = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; fly secrets set SHOP_API_TOKEN=$t -a awake-discord-bot; "New token: $t"
  ```

---

## Claude (Workload Identity Federation)

The live bot has **no Anthropic API key**. For each token exchange, it asks its Fly machine for a fresh OIDC token (`src/fly-oidc.js`) and trades it with Anthropic for a Claude token that lasts an hour (`src/claude.js`). Each Fly token can be used only once.

These resources are set up in the [Claude Console](https://platform.claude.com):

| Resource | Value |
|---|---|
| Service account | `caffenito-bot` (`svac_01ARkUB9kQtFHArRQEd3oMon`) |
| Federation issuer | `https://oidc.fly.io/petre-popescu`, JWKS: discovery |
| Federation rule | `caffenito-on-fly` (`fdrl_01FBMok1AxzEL5oA5gwu4tJv`): subject `petre-popescu:awake-discord-bot:*`, audience `https://api.anthropic.com`, claim `org_id=1566447`, scope `workspace:inference` |
| Workspace | `wrkspc_01Jcuze1H4N8FWLy8BCKNGHZ` (required, because the rule covers several workspaces) |

- **If Claude calls fail with 401:** the reason is in the Console under **Workload identity federation → Authentication history**.
- **If you rename the Fly app or move it to another Fly org:** update the rule's subject and `org_id`.

---

## Discord settings

- **Developer Portal → Caffenito → Bot:** both **Server Members Intent** and **Message Content Intent** must be on. Without Message Content, the bot can't log in, because it asks for that intent whenever `/bully` is configured.
- **Bot role permissions:**
  - **Manage Server**, for the banner
  - Kick, Ban, Timeout, Manage Roles, Manage Messages, View Channels, Send Messages, Embed Links, Read History, Create Events
- **On the status channel itself:** the bot also has **Manage Channels** there, so it can rename it.
- **Role order** (top first): Admin, Robert, Caffenito, Barista, Server Booster, matinali, cafengiu. The bot can only manage roles below its own, which also means no command can ever act on Admin or Robert.
- **Channels:**
  - `🟢┃awake-deschis` is at the very top, and only the bot can post there.
  - `#anunturi` allows posts only from Robert, Admin and the bot.
  - Re-apply both with `scripts/setup-status-channel.js`.
- **Command visibility (Server Settings → Integrations → Caffenito):**
  - The current app-wide rows are @everyone ✕ and Barista / Robert / Admin / Server Booster ✓. That makes `/bully` and `/dossier` usable only by those roles.
  - `/shop` and `/intel` additionally check staff roles in the bot's code.
  - The moderation commands keep their built-in permission requirement.
  - Discord doesn't let you reset the @everyone row to neutral once it's set; you can only switch it between ✕ and ✓.
- **Invite link**, if the bot ever needs re-adding:
  `https://discord.com/oauth2/authorize?client_id=1564700464187048105&scope=bot+applications.commands&permissions=1099780156422`
  Then re-grant Manage Server.

---

## Repository layout

| Path | What |
|---|---|
| `src/index.js` | Startup: Discord client, events, API server |
| `src/commands.js` | All slash commands and the message menu |
| `src/shop.js` | Shop status: announcement, channel name, banner, saved state |
| `src/api.js`, `src/openapi.js` | HTTP API and its OpenAPI schema |
| `src/learning.js` | Transcripts, 6-hour sweep, history import (`/backfill`) |
| `src/claude.js` | Claude calls (profile updates, roasts) and federation client |
| `src/fly-oidc.js` | Mints Fly OIDC tokens |
| `src/store.js` | `state.json` persistence |
| `src/welcome.js`, `src/config.js`, `src/deploy-commands.js` | Welcome flow, env config, manual command registration |
| `scripts/setup-roles.js` | One-off role setup (Barista role, role order); dry run unless `--apply` |
| `scripts/setup-status-channel.js` | Creates and locks the status channel and locks `#anunturi`; dry run unless `--apply` |
| `assets/` | Banners, the logo source (`awake-logotype.pdf`) and `make_banners.py` |
| `qr/` | Discord invite QR codes (`https://discord.gg/qKDz6xvwkT`, permanent) and `make_qr.py` |
| `fly.toml`, `Dockerfile` | Fly app config and container |

### Regenerating the banners or QR codes (optional)

```bash
python -m venv .venv
```

```powershell
.venv\Scripts\activate
```

```bash
pip install pypdfium2 pillow numpy segno opencv-python-headless zxing-cpp
```

```bash
python assets/make_banners.py --preview
```

```bash
python qr/make_qr.py
```

- **Banners** keep the status word inside Discord's visible strip; `--preview` writes mock-ups of the sidebar crop to check before publishing. The banner script uses the Segoe UI Black font, which comes with Windows; on another OS, point `FONT` at a heavy sans `.ttf`.
- **After changing the banners,** run `fly deploy --ha=false`. The new image is used from the next status change.
- **The QR script** checks that every code still decodes.
- **Brand colour:** Awake orange `#E18409` (CMYK 10 55 100 0).

**Don't delete the invite `qKDz6xvwkT`** (Server Settings → Invites, created by Caffenito). The printed QR codes point to it.
