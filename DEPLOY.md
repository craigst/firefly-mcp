# firefly-mcp — deployment record (2026-11-06)

Repo: <https://github.com/craigst/firefly-mcp> (public, tag `v1.0.1`)
Runs as a **managed stdio server** on the MCP gateway (`us-vps`, `10.10.1.4`).

| | |
|---|---|
| Server id | `srv_9d8e0da273124c12` (name `firefly`) |
| Work dir | `/data/repos/firefly` (inside the gateway container) |
| Config profile | `cfg_db88c9c8adb147f0` (`firefly-api`, encrypted) |
| Tools | 12 |
| Style | **read-only** — the server never writes to Firefly |

## Granted to

`key_cb15596c45c44de1` (`omb-cleo`, last used 2026-11-06) — **Cleo only**.
12 server grants now, `srv_9d8e0da273124c12` among them.

⚠ There is a **second, stale `omb-cleo` key** (`key_6605b76facb747a0`, created
2026-10-31, **never used**, 10 grants). It was deliberately NOT granted. It should
probably be deleted so it cannot become a way in.

## How it was installed

```bash
# on us-vps, master key from /opt/mcp-gateway/gateway.env
POST /mcp/v1/admin/catalog/import-url
{"url":"https://github.com/craigst/firefly-mcp.git","ref":"v1.0.0","name":"firefly","start":false}

POST /mcp/v1/admin/config-profiles           # entries is an ARRAY of {key,value}
{"name":"firefly-api","entries":[{"key":"FIREFLY_TOKEN","value":"…"}, …],"headers":[]}

POST /mcp/v1/admin/config-profiles/{id}/apply
{"serverIds":["srv_9d8e0da273124c12"],"restart":true,"test":true}

PATCH /mcp/v1/admin/keys/key_cb15596c45c44de1
{"serverGrants":[ …existing…, {"serverId":"srv_9d8e0da273124c12"} ]}
```

Gotchas that cost time:

- **Private repo fails**: `git clone` uses HTTPS and the gateway's SSH key is not on
  GitHub. A read-only deploy key is useless because `assertAllowedCloneUrl` only
  accepts the HTTPS prefixes. The repo was made public (code only, no secrets).
- **`entries` must be an array** of `{key, value}` objects, not a mapping.
- The gateway does **not** accept `env` on update; only a config profile or import.
- **Updating** is `POST /admin/updates/servers/{id}/update {"ref":"v1.0.1"}` — it
  re-clones, rebuilds and restarts.

## Keeping the data fresh

The MCP server holds no cache: every call reads Firefly live. Freshness therefore
depends entirely on the **Lunch Flow sync** on zeus, which was moved from once to
**twice daily**:

```
10 6,18 * * *  python3 sync.py; bash categorise.sh
```

Persisted in `/boot/config/firefly/firefly-import.cron` (survives reboot; `/boot/config/go`
copies it to `/etc/cron.d/`). Backup of the old file:
`firefly-import.cron.bak-20261106`. Verified by running `sync.py` by hand: exit 0.

## Bug found during build

`GET /api/v1/accounts?limit=200` returns the **first 200 accounts**, and Firefly
auto-creates an expense account per merchant — so 200 rows were all
expense/revenue and the real accounts were past page one, returning `count: 0`
after filtering. Fixed by querying `?type=asset`, `?type=liabilities`, `?type=cash`
explicitly. Also: the card lives under `liabilities`/`debt`, not `creditcard`.
