# OAuth connectors + redirect URIs

Captatum is an OAuth-protected MCP server. MCP clients (Claude, ChatGPT, Cursor,
any CLI/desktop/web agent) connect via OAuth 2.1 + Dynamic Client Registration
(RFC 7591): the client registers at `/oauth/register` and runs the authorization
flow at `/oauth/authorize`. Captatum validates the client's `redirect_uri`
against an allowlist so an authorization code can only be delivered to a
trusted origin (no open redirect).

## Default trusted origins (works out of the box)

Captatum ships with these redirect origins built in (`DEFAULT_ALLOWED_REDIRECT_ORIGINS`),
so a fresh deploy accepts the common MCP clients without configuration:

| Origin | Client | Match rule |
|---|---|---|
| `https://claude.ai` | Claude (web) custom connectors | any callback path |
| `https://chatgpt.com` | ChatGPT custom connectors (per-connector `connector_platform_oauth_…` path) | any callback path |
| `http://localhost` | native MCP clients — Claude Code, Cursor, CLI/desktop | **any port** (RFC 8252) |
| `http://127.0.0.1` | numeric loopback variant | **any port** (RFC 8252) |

- **Web clients** match **origin-only** (`scheme://host`, path ignored), so a
  dynamic callback path like ChatGPT's per-connector URL is covered by the
  `https://chatgpt.com` entry.
- **Native clients** (CLI/desktop) redirect to `http://localhost:<ephemeral-port>/…`.
  The port is dynamic and cannot be allowlisted exhaustively, so loopback
  entries match **any port** per [RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252).
  This is safe: loopback is local-only (only the registering app on that machine
  can receive the code), and captatum requires PKCE (`S256`).

The `OAUTH_REDIRECT_ALLOWLIST` env var **adds** to these defaults; it cannot
remove one (they are trusted origins).

## Adding a new connector

- **Web/SaaS client** (its own domain, e.g. `https://theirapp.com`): add the origin to `OAUTH_REDIRECT_ALLOWLIST`:
  ```
  OAUTH_REDIRECT_ALLOWLIST=https://theirapp.com
  ```
  Any callback path on that origin is then accepted.

- **Native/CLI/desktop client**: no configuration needed — covered by the
  built-in `http://localhost` / `http://127.0.0.1` (any port, per RFC 8252).
  Note: because `http://localhost` is a built-in default that the env cannot
  remove, native loopback redirects are accepted on **any** port regardless of
  any other entry you add — you cannot narrow native clients to a single port
  via the allowlist. (This is by design: native-app ports are ephemeral.)

Multiple entries are comma-separated:
```
OAUTH_REDIRECT_ALLOWLIST=https://theirapp.com,https://other.app
```

## Custom callback URLs

Any callback URL a connector uses is supported — it just has to be on an allowlisted origin (or matched exactly):

- **Whole origin** (recommended): allowlist `https://theirapp.com` → **any** callback path on that origin is accepted (`/oauth/callback`, `/auth/return`, a dynamic per-connector path, …). Use this when you trust the domain.
- **Exact URI**: allowlist the full URI `https://theirapp.com/oauth/callback` → only that exact URI matches (path + port + query must match). Use this when you want to scope to one specific callback rather than the whole domain.
- **Custom scheme** (mobile/desktop app, e.g. `myapp://oauth/callback`): allowlist the exact URI. Note custom URL schemes can be registered by other apps on a device — captatum mitigates with mandatory PKCE, but prefer a loopback redirect for native clients where possible.
- **Loopback** (native): covered by the built-in `http://localhost` / `http://127.0.0.1` (any port).

The connector registers its `redirect_uri`(s) via Dynamic Client Registration (`POST /oauth/register`); captatum validates each against the defaults + your allowlist. To find a custom callback a connector is using, check the audit log — `oauth.authorize*` events record the `redirectHost`.

**Deliberately NOT supported** (security): wildcard subdomains (`https://*.app.com`) and path-prefix patterns (`https://app.com/cb/*`) — unanchored/prefix matching is an open-redirect risk. Allowlist each concrete origin (or the exact URI) instead.

## Cloudflare Access + the OAuth flow

In the hosted deployment, Cloudflare Access is the **user**-authentication layer
and captatum's OAuth is the **client/delegated** layer. They cooperate, they
don't conflict — so it matters which paths CF Access protects:

- **Behind CF Access (keep):** `/oauth/authorize`, `/oauth/authorize/approve`,
  `/consent`. The `/oauth/authorize` route calls `resolveSubject()`, which reads
  the `cf-access-jwt-assertion` header CF Access injects after the human logs in
  via SSO. This is how captatum knows *who* is authorizing the connector. The
  connector's browser flow takes the user through CF Access SSO to the consent
  screen — that is intentional, not a block.
- **Bypassed from CF Access (must be reachable by the connector machine):**
  `/oauth/register` (Dynamic Client Registration), `/oauth/token` (the code→token
  exchange), `/.well-known/*` (metadata discovery), `/mcp` (gated by captatum's
  own bearer-token OAuth, not CF Access), `/healthz`.

So: do **not** bypass `/oauth/authorize`. If a connector can't complete the
browser authorize step, the cause is upstream of captatum — e.g. the human's
identity isn't in the CF Access policy, or the connector can't open a browser
(headless) — not the redirect-URI allowlist.

## Security model

- No wildcard (`*`) — explicitly rejected; entries must be exact origins.
- Origin matching is anchored (`scheme://host[:port]`); lookalike hosts like
  `chatgpt.com.evil.com` do not match `chatgpt.com`.
- `userinfo` (`https://user:pass@host`) is rejected.
- Loopback is http-only by default; https-on-localhost is not matched unless
  `https://localhost` is added.
- PKCE (`S256`) is mandatory for every authorization.
