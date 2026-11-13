# 🔒 Keep It Authentication Guide

## ⚠️ Default Password Warning

> **Default password is `admin`** — CHANGE THIS before exposing to any network!

---

## Overview

Keep It includes simple password protection for single-user deployments. When enabled, users must log in before accessing notes.

- ✅ Single user / self-hosted use
- ✅ Passwords hashed with bcrypt
- ✅ Session-based (7 days default, configurable)

---

## Quick Test (Local Only)

For local testing, authentication is **disabled by default**. To test with auth:

1. Copy `config.example.yaml` to `config.yaml` and set `authentication.enabled: true` in it
2. Restart the app
3. Log in with password: `admin`

⚠️ **Don't use the default password on any network!**

---

## Production Setup

For any deployment exposed to a network, follow these steps:

### Step 1: Generate a Secret Key (optional)

The secret key signs session cookies. If you don't set one, the app generates a random key on first start and keeps it in your notes folder as `.secret-key`, so logins survive restarts. Delete that file to log everyone out.

To set your own instead, for example when the notes folder is shared with others, generate one:

```bash
# Docker
docker exec -it keepit python -c "import secrets; print(secrets.token_hex(32))"

# Local
python -c "import secrets; print(secrets.token_hex(32))"
```

**Save this key** — you'll need it in Step 2.

---

### Step 2: Configure Authentication

Your password is automatically hashed at startup using bcrypt.

**Via Environment Variables (Docker):**
```bash
docker run -d \
  -e AUTHENTICATION_ENABLED=true \
  -e AUTHENTICATION_PASSWORD=your_secure_password \
  -e AUTHENTICATION_SECRET_KEY=your_generated_secret_key \
  ...
```

**Via config.yaml:**
```yaml
authentication:
  enabled: true
  password: "your_secure_password"
  secret_key: "your_generated_secret_key"
```

---

### Step 3: Restart & Test

```bash
# Docker Compose
docker-compose restart

# Docker run
docker restart keepit

# Local
python run.py
```

Navigate to `http://localhost:8000` — you'll be redirected to the login page.

---

## PIN instead of a password

A PIN of 4 to 6 digits is quicker to type on a phone. When one is set, the login page
asks for it, with a number pad on phones, and the password no longer logs in.

```yaml
authentication:
  enabled: true
  pin: "482913"
```

Or `AUTHENTICATION_PIN=482913`. Anything other than 4 to 6 digits is ignored, with an
error in the log. Remove the PIN to go back to the password.

A PIN has few combinations, so wrong tries are slowed down (see
[Wrong tries](#wrong-tries)), but a 4-digit PIN reachable from the internet is still
weak. Use 6 digits, and put something like Cloudflare Access in front if you can.

---

## Remember this device

The login page has a **Remember this device** checkbox:

- **Ticked:** the login lasts `session_max_age` (7 days by default) and is renewed
  whenever you use the app, so a phone you use daily stays logged in. Raise it, e.g.
  to `7776000` (90 days), for fewer logins.
- **Not ticked:** the login ends `short_session_hours` (12 by default) after it began,
  however much the app is used. For a computer that isn't yours.

---

## Wrong tries

Wrong passwords and PINs make the next try wait, per client (its address and browser):

- the first 3 are free;
- then 30 s, 1 min, 2 min, 4 min, 8 min, and 15 min from then on;
- a successful login, or 24 hours without a wrong try, starts the count again.

Tries during a wait are turned away without being checked. The login page shows how
long is left.

Changing browsers makes a new client, so there's also a limit for everyone: after 20
wrong tries in an hour, nobody can log in until the oldest are an hour old. Devices
already logged in carry on. The log shows a warning when this happens.

The counts are kept in memory, so a restart clears them.

### Behind a proxy or Cloudflare tunnel

Behind a proxy, every request comes from the proxy's address, so all visitors would
count as one client. List the proxy in `trusted_proxies` and the client's own address is
taken from `CF-Connecting-IP`, or else `X-Forwarded-For`:

```yaml
authentication:
  trusted_proxies: ["172.16.0.0/12"]   # cloudflared in a Docker network
```

List only proxies: anyone at a listed address can claim to be any client.

---

## Cloudflare Access

Behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
with an [Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) application
in front, you've already logged in to Cloudflare, so Keep It can skip its own login:

- **Through Access:** straight in, no PIN or password.
- **Anything else**, such as `http://192.168.0.10:8000` at home: the login page.

Cloudflare adds a signed token (`Cf-Access-Jwt-Assertion`) to every request it lets
through. Keep It checks its signature against your team's keys, that it was issued
for this application, and that it hasn't expired. A forged or copied header from
someone reaching the port directly doesn't get in.

```yaml
authentication:
  enabled: true
  pin: "482913"                     # for when you're not coming through Access
  cloudflare_access:
    team_domain: "myteam.cloudflareaccess.com"
    aud: "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2"
    allowed_emails: ["you@example.com"]
```

- **`team_domain`:** in Zero Trust, *Settings → Custom Pages*, or the address of your
  Access login page.
- **`aud`:** in Zero Trust, *Access → Applications →* your app *→ Overview*,
  **Application Audience (AUD) Tag**.
- **`allowed_emails`:** optional. Empty lets in anyone your Access policy lets in,
  [service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
  included. To list a service token, which has no email, add its Client ID
  (`….access`).

**Log out** in Keep It also logs you out of Access, since Access would otherwise log
you straight back in.

Things to set in the Access application:

- A **Bypass** policy for `/share/*`, or people you send share links to can't open them.
- Scripts and MCP clients can't do the browser login: give them a service token
  (`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers) and a Service Auth
  policy. That alone gets them in, as long as `allowed_emails` is empty or lists the
  token's Client ID. A wrong token gets a 401/403 from Cloudflare, not the login page.

### Checking in cloudflared too (optional)

cloudflared can also check the token before passing a request on ("Protect with
Access"). It's a second lock: a request that somehow skipped Access never reaches Keep It.
Two things to know:

- Set it on **each ingress rule**, not as a top-level `originRequest`: at the top level
  it is currently ignored without warning
  ([cloudflared#1695](https://github.com/cloudflare/cloudflared/pull/1695)).
- Requests let through by a Bypass policy carry no token, so `/share/*` needs its own
  rule without it, placed first:

```yaml
ingress:
  - hostname: notes.example.com
    path: ^/share/
    service: http://keepit:8000
  - hostname: notes.example.com
    service: http://keepit:8000
    originRequest:
      access:
        required: true
        teamName: myteam
        audTag: ["<AUD tag>"]
  - service: http_status:404
```

On cloudflared 2026.10.0 or later, turn on its URL normalization so paths such as
`/share/../api` can't slip past the rule order.

The keys are fetched from `https://<team_domain>/cdn-cgi/access/certs`, so the server
must be able to reach it. If it can't, the login page still works.

---

## Configuration Priority

Environment variables override config.yaml:

| Priority | Source |
|----------|--------|
| 1st | `AUTHENTICATION_PASSWORD` env var |
| 2nd | `password` in config.yaml |

`AUTHENTICATION_PIN` overrides `pin` the same way.

**Example:** If you set `AUTHENTICATION_PASSWORD` as an env var, it overrides config.yaml.

---

## Security Considerations

### ✅ What This Protects

- Unauthorized access to your notes
- All API endpoints
- Viewing, creating, editing, deleting notes

### ⚠️ What This Doesn't Protect

This is a **simple single-user** system. NOT suitable for:

- ❌ Multi-user environments
- ❌ Public internet without HTTPS
- ❌ Compliance requirements (HIPAA, GDPR, etc.)

### 🛡️ Best Practices

1. **Use HTTPS** — Run behind a reverse proxy (Traefik, nginx, Caddy)
2. **Strong password** — At least 12 characters, mixed case, numbers, symbols
3. **Unique secret key** — Never reuse across applications
4. **Keep config secure** — Don't commit credentials to version control

---

## API Key Authentication

For external integrations (MCP servers, scripts, automation), use an API key instead of session cookies.

### Setup

```bash
# Generate a secure key
python -c "import secrets; print(secrets.token_hex(32))"
```

**Via Environment Variable:**
```bash
docker run -e AUTHENTICATION_API_KEY=your_api_key ...
```

**Via config.yaml:**
```yaml
authentication:
  api_key: "your_64_character_hex_key"
```

### Usage

```bash
# Option 1: Bearer token
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:8000/api/notes

# Option 2: X-API-Key header
curl -H "X-API-Key: YOUR_API_KEY" http://localhost:8000/api/notes
```

Both session auth (web UI) and API key auth work simultaneously when enabled.

---

## Disabling Authentication

```yaml
authentication:
  enabled: false
```

Restart the app to apply.
