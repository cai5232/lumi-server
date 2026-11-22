# Lumi companion MCP services

Deployment sources checked on 2026-11-22:

- Night Ferry: `cai5232/night-ferry` at `24ad0cee1d63e812a7c11cd34f9ff473be1ab3b8` (MIT).
- Munch Kitchenette: `tsuru0805/munch-kitchenette` at `e6edaf36fafd71ba3a84438a431903f9f35e9efb` (PolyForm Noncommercial; assets have their own noncommercial attribution).

For each Docker build context, place the pinned upstream source in `upstream/` beside this directory's Dockerfile. Night Ferry also needs `http.cjs`. The adapter exposes the upstream writing tool through stateless HTTP MCP and protects both MCP and the upstream reader/API with a required bearer token. It does not create a schedule or invoke an LLM. Image generation is explicitly disabled (`NIGHT_FERRY_LLM=none`). Do not run the upstream paid example writer as an installation check.

Runtime containers are `lumi-night-ferry` and `lumi-kitchenette` on the existing `coolify` Docker network, with **no published host ports**. Use `--restart unless-stopped`, non-root image users, `--cap-drop ALL`, and `--security-opt no-new-privileges`. Persistent host directories are `/var/lib/lumi-companion-services/{night-ferry,kitchenette}/data` (UID 1000). Root-only `service.env` files hold `NIGHT_FERRY_TOKEN` and `KITCHENETTE_SERVER_TOKEN`. Back up these directories, including the SQLite journal/WAL consistently; never replace them during builds. Existing Lumi/Nocturne databases are independent.

Configure these runtime environment variables in Coolify:

```
LUMI_NIGHT_FERRY_MCP_URL=http://lumi-night-ferry:3210/mcp
LUMI_NIGHT_FERRY_MCP_TOKEN=<private service token>
LUMI_KITCHENETTE_MCP_URL=http://lumi-kitchenette:8765/mcp
LUMI_KITCHENETTE_MCP_TOKEN=<private service token>
```

Only these exact, explicitly configured ID/URL pairs are permitted over internal HTTP. Other MCP URLs keep the existing public HTTPS validation. Existing MCP switches and discovered schemas survive reads and deployments; URL/token changes invalidate the corresponding discovery snapshot.

Kitchen settings: default role 沈屿, human name 言言, Asia/Shanghai timezone. MCP tools are enabled; bracket-marker processing, webhook wakeups, other-tool coupon earning, and Lumi emotion synchronization are not enabled by this installation. The upstream queue/standard tool behavior remains intact. No additional background model requests are scheduled.

Validate using `initialize`, `tools/list`, `night_ferry` with `action:read`, and `kitchen_status`. These require no model calls, article creation, groceries, or paid image API.
