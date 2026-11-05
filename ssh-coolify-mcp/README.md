# Lumi VPS + Coolify MCP

This is a small, separately deployable MCP Streamable HTTP service for Lumi. It exposes fixed, read-only VPS checks over a forced-command SSH key and allowlisted Coolify read/restart/deploy operations. It never accepts arbitrary shell commands, uploads, file edits, or root access.

## Tools

- `ssh_diagnostics`: uptime, disk, memory, failed systemd units, or recent system errors.
- `coolify_list_apps`, `coolify_application_logs`, `coolify_deployment_history`.
- `coolify_restart_app` and `coolify_deploy_app`, both limited to UUIDs in `COOLIFY_ALLOWED_APP_UUIDS` and requiring the exact confirmation string shown in each tool description.

The Coolify API credentials are separate from the SSH key. SSH access does not automatically authorize Coolify API requests. Use two team-scoped API tokens: `COOLIFY_READ_API_TOKEN` with `read:sensitive` for inventory/logs/history, and `COOLIFY_DEPLOY_API_TOKEN` with `deploy` only for restarts/deployments. Do not use an owner/root token. Coolify creates a deploy-only token when `deploy` is selected, so it cannot be combined with read permissions. Runtime log endpoints require `read:sensitive` or `root` according to Coolify's API reference. Restart and deploy are called only in response to an explicit user request and also validate a tool confirmation field; that field is not an interactive second-factor prompt.

## 1. Add a restricted SSH identity on the VPS

Create an SSH key pair dedicated to this service. Keep its private key only in the MCP service's secret environment variables. Pin the host key fingerprint from a trusted channel; do not trust an unverified `ssh-keyscan` result.

On the VPS, create a non-root account with no sudo and no `docker` group. Install `scripts/lumi-mcp-command` as root-owned and not writable by that account:

```sh
sudo install -o root -g root -m 0755 scripts/lumi-mcp-command /usr/local/sbin/lumi-mcp-command
sudo useradd --create-home --shell /bin/sh lumiops
sudo install -d -o lumiops -g lumiops -m 0700 /home/lumiops/.ssh
```

Put the generated **public** key into `/home/lumiops/.ssh/authorized_keys`, prefixed with this forced command restriction (replace the key placeholder):

```text
command="/usr/local/sbin/lumi-mcp-command",restrict ssh-ed25519 AAAA... lumi-vps-mcp
```

Then set ownership and mode:

```sh
sudo chown lumiops:lumiops /home/lumiops/.ssh/authorized_keys
sudo chmod 0600 /home/lumiops/.ssh/authorized_keys
```

The server-side forced command independently rejects anything except the five fixed diagnostics. Keep the account out of `sudoers` and the Docker group; access to the Docker socket is effectively root access.

## 2. Deploy this folder as its own Coolify application

Use this directory as the build root (Dockerfile). Give the MCP application its own HTTPS domain and set these secrets/configuration in Coolify:

```text
PORT=8788
MCP_ACCESS_TOKEN=<long random secret>
SSH_HOST=<VPS hostname>
SSH_PORT=22
SSH_USER=lumiops
SSH_HOST_FINGERPRINT=SHA256:<pinned host-key fingerprint>
SSH_PRIVATE_KEY_PATH=/run/secrets/lumi-vps-mcp
COOLIFY_API_URL=https://<your-coolify-domain>
COOLIFY_READ_API_TOKEN=<read:sensitive token>
COOLIFY_DEPLOY_API_TOKEN=<deploy-only token>
COOLIFY_ALLOWED_APP_UUIDS=<comma-separated exact application UUIDs>
```

For the Coolify service, mount the host key file read-only at `/run/secrets/lumi-vps-mcp`. The image's `node` user is in GID 1001 (`mcpkey`); set the host file owner to `root:1001` and mode to `0440`. The service reads the file only when running the fixed SSH diagnostics. `SSH_PRIVATE_KEY` remains supported for local development, but prefer the mounted secret file in production.

If the Coolify API is reachable from the service over a trusted private network, `COOLIFY_API_URL` may use its internal HTTP address; otherwise use HTTPS. The API token is sent only to this fixed URL. The service does not accept a URL or arbitrary resource target from tool arguments.

The MCP endpoint is `https://<mcp-domain>/mcp`. Do not expose it without TLS and `MCP_ACCESS_TOKEN`.

## 3. Register it with Lumi

Set these secret environment variables on the Lumi backend in Coolify, then redeploy Lumi:

```text
LUMI_VPS_MCP_URL=https://<mcp-domain>/mcp
LUMI_VPS_MCP_TOKEN=<same MCP_ACCESS_TOKEN>
```

Lumi automatically adds **VPS 与 Coolify** to its MCP server list. Open Lumi → Settings → Tools → MCP 工具, connect/refresh it, and leave it enabled. Connected tools then appear in chat. Never put the SSH private key or Coolify token in the iOS app, chat history, or MCP URL.

## Local run

```sh
cd ssh-coolify-mcp
npm install
MCP_ACCESS_TOKEN=dev-token node src/index.js
```

The SSH key, host fingerprint, Coolify API token, and allowlisted UUIDs must still be set before their corresponding tools can work.

## References

- [Coolify API overview](https://coolify.io/docs/api/overview)
- [Coolify API permissions](https://coolify.io/docs/api/permissions)
- [Coolify application logs](https://coolify.io/docs/api/endpoints/applications/get-application-logs-by-uuid)
- [Coolify deploy endpoint](https://coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid)
- [Coolify restart endpoint](https://coolify.io/docs/api/endpoints/applications/restart-application-by-uuid)
