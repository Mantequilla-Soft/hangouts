# Examples

Reference configs from an earlier deployment (domain `okinoko.io`) — a worked example of the pattern in `docs/livekit-server-setup.md`, not a copy of what's currently live in production.

- `livekit/` — `docker-compose.yaml` + `livekit-docker.service` + an nginx site for a self-hosted LiveKit stack (LiveKit + egress, host networking).
- `hangouts.okinoko.io.nginx` — nginx reverse proxy in front of the Fastify API.

Production (`3speak.tv`) has since diverged from these — different domains, nginx instead of the Caddy approach the docs describe, Redis as a bare systemd service instead of a compose service, etc. Treat these as a starting template for a fresh self-host, confirm the specifics (ports, domains, whether something's already listening) against your own box, and check `docs/livekit-server-setup.md` for the current step-by-step guide.
