# LiveKit Server Setup Guide

Deploy a production-ready LiveKit server on an OVH VPS using Docker Compose + Caddy. LiveKit is the SFU (Selective Forwarding Unit) that handles all real-time audio distribution for Hive Hangouts.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [DNS Setup](#dns-setup)
4. [Generate Configuration](#generate-configuration)
5. [Deploy to VPS](#deploy-to-vps)
6. [Firewall / Port Rules](#firewall--port-rules)
7. [Verify the Deployment](#verify-the-deployment)
8. [Install the LiveKit CLI](#install-the-livekit-cli)
9. [Testing the Server](#testing-the-server)
10. [Recording & Egress Setup](#recording--egress-setup)
11. [Monitoring & Logs](#monitoring--logs)
12. [Upgrading](#upgrading)
13. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
Client (browser/app)
        │
        │  wss://  (WebSocket signaling)
        ▼
   Caddy :443/TCP  ──► LiveKit Server :7880
                        │
                        │  WebRTC/UDP (media)
                        ▼
                   LiveKit RTC :50000-60000/UDP
                               :7881/TCP (fallback)
                               :443/UDP (TURN/TLS)
                               :3478/UDP (TURN)
```

- **Caddy :443/TCP** — reverse proxy with automatic TLS (Let's Encrypt). Handles HTTPS + WebSocket signaling.
- **LiveKit :443/UDP** — TURN/TLS for clients behind strict firewalls. Shares port 443 with Caddy (different protocol: UDP vs TCP), so no separate TURN subdomain or certificate is needed.
- **Ports 50000–60000 UDP** — the actual audio data flows here, directly from LiveKit.
- **Port 7881 TCP** — TCP fallback when UDP is blocked.

### What changed from the old Nginx approach

The previous setup required Nginx + manual certbot + a separate TURN subdomain with its own certificate. The Docker Compose + Caddy approach eliminates all of that:

- Caddy auto-provisions and renews TLS certificates
- No Nginx configuration needed
- No separate TURN subdomain or certificate — TURN uses 443/UDP alongside Caddy's 443/TCP
- Everything runs in Docker — one command to start, one to stop
- Redis is included in the compose stack

---

## Prerequisites

- Ubuntu 22.04+ on OVH VPS (2+ vCPU, 4+ GB RAM recommended)
- A domain name you control (e.g., `yourproject.com`)
- Root or sudo access
- Docker and Docker Compose installed on the VPS

### Install Docker (if not already present)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Log out and back in for group change to take effect
```

---

## DNS Setup

Create **one** A record pointing to your OVH server's public IP:

| Subdomain                  | Type | Value            |
|----------------------------|------|------------------|
| `livekit.yourproject.com`  | A    | `YOUR_SERVER_IP` |

That's it — no separate TURN subdomain needed.

Allow 5–10 minutes for DNS propagation. Verify with:

```bash
host livekit.yourproject.com
```

---

## Generate Configuration

On your **local machine** (not the VPS), run the LiveKit config generator:

```bash
docker pull livekit/generate
docker run --rm -it -v$PWD:/output livekit/generate
```

The interactive wizard will ask for:
- Your domain (e.g., `livekit.yourproject.com`)
- Whether to enable TURN
- Whether to enable egress/ingress

It generates a folder named after your domain containing:

```
livekit.yourproject.com/
  caddy.yaml            # Reverse proxy + auto-TLS
  docker-compose.yaml   # All services (LiveKit, Caddy, Redis)
  livekit.yaml          # LiveKit server config
  redis.conf            # Redis config
  init_script.sh        # Deployment script for the VPS
```

### Review and note your API credentials

Open `livekit.yaml` and find the `keys:` section:

```yaml
keys:
  YOUR_API_KEY: YOUR_API_SECRET
```

Save these — you'll need them for the Hangouts server `.env` file.

---

## Deploy to VPS

### Option A: Using the init script (recommended)

1. Copy the generated folder to your VPS:

```bash
scp -r livekit.yourproject.com/ user@YOUR_SERVER_IP:/tmp/
```

2. SSH into the VPS and run the init script:

```bash
ssh user@YOUR_SERVER_IP
cd /tmp/livekit.yourproject.com
sudo bash init_script.sh
```

The script installs Docker (if needed), copies configs to `/opt/livekit/`, and starts everything as a systemd service called `livekit-docker`.

### Option B: Manual deployment

If you prefer to set things up yourself:

```bash
ssh user@YOUR_SERVER_IP
sudo mkdir -p /opt/livekit
```

Copy the generated files to the VPS:

```bash
scp caddy.yaml docker-compose.yaml livekit.yaml redis.conf user@YOUR_SERVER_IP:/opt/livekit/
```

Then on the VPS:

```bash
cd /opt/livekit
sudo docker compose up -d
```

To run as a systemd service:

```bash
sudo tee /etc/systemd/system/livekit-docker.service > /dev/null <<EOF
[Unit]
Description=LiveKit Server (Docker Compose)
Documentation=https://docs.livekit.io
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/livekit
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable livekit-docker
sudo systemctl start livekit-docker
```

---

## Firewall / Port Rules

Open these ports in the **OVH Control Panel** firewall and/or via `ufw`:

| Port / Protocol   | Purpose                              |
|--------------------|--------------------------------------|
| `80/TCP`           | TLS certificate issuance (Caddy)     |
| `443/TCP`          | HTTPS / WebSocket signaling (Caddy)  |
| `443/UDP`          | TURN/TLS (LiveKit, for strict NATs)  |
| `7881/TCP`         | WebRTC TCP fallback                  |
| `3478/UDP`         | TURN/STUN UDP                        |
| `50000–60000/UDP`  | WebRTC media (ICE/UDP)               |

### Using UFW

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 7881/tcp
sudo ufw allow 3478/udp
sudo ufw allow 50000:60000/udp
sudo ufw enable
sudo ufw status
```

---

## Verify the Deployment

### Check services are running

```bash
sudo systemctl status livekit-docker

# Or check containers directly
cd /opt/livekit && sudo docker compose ps
```

You should see containers for `livekit`, `caddy`, and `redis` all running.

### Check Caddy got a TLS certificate

```bash
cd /opt/livekit && sudo docker compose logs caddy | grep "certificate obtained"
```

If you see `"certificate obtained successfully"`, TLS is working.

### Health check

```bash
curl https://livekit.yourproject.com/
```

Should return a response (might be empty or a simple status — that's fine, it means Caddy is proxying to LiveKit).

---

## Install the LiveKit CLI

The `lk` CLI is used to test the server, generate tokens, manage rooms, and run load tests. Install it on your **local machine**:

```bash
curl -sSL https://get.livekit.io/cli | bash
```

Verify:

```bash
lk version
```

---

## Testing the Server

### 1. Generate a Test Token

```bash
lk token create \
  --api-key YOUR_API_KEY \
  --api-secret YOUR_API_SECRET \
  --join \
  --room test-room \
  --identity test-user-1 \
  --valid-for 1h
```

Copy the JWT output.

### 2. Join via the LiveKit Meet Demo

1. Open `https://meet.livekit.io` in your browser
2. In the connection settings, enter:
   - **Server URL**: `wss://livekit.yourproject.com`
   - **Token**: the JWT from step 1
3. Click connect
4. Open a second browser tab, generate a second token with `--identity test-user-2`, and join the same `test-room`
5. You should hear audio between the two tabs

### 3. List Active Rooms

```bash
lk room list \
  --url wss://livekit.yourproject.com \
  --api-key YOUR_API_KEY \
  --api-secret YOUR_API_SECRET
```

### 4. List Participants in a Room

```bash
lk room list-participants \
  --url wss://livekit.yourproject.com \
  --api-key YOUR_API_KEY \
  --api-secret YOUR_API_SECRET \
  --room test-room
```

### 5. Load Test

Simulate 50 listeners and 2 speakers:

```bash
lk load-test \
  --url wss://livekit.yourproject.com \
  --api-key YOUR_API_KEY \
  --api-secret YOUR_API_SECRET \
  --room test-room \
  --publishers 2 \
  --subscribers 50 \
  --duration 60s
```

Monitor the server during the test:

```bash
# On the VPS
htop
```

---

## Recording & Egress Setup

> **Note:** Skip this for MVP. Egress (recording) is useful later for podcast export, but it's not needed to get hangouts working.

If you enabled egress during the `livekit/generate` step, the egress service is already in your `docker-compose.yaml`. If not, add it manually:

```yaml
# Add to docker-compose.yaml under services:
egress:
  image: livekit/egress:latest
  restart: unless-stopped
  network_mode: host
  environment:
    - EGRESS_CONFIG_FILE=/etc/egress.yaml
  volumes:
    - ./egress.yaml:/etc/egress.yaml
    - /tmp/livekit-recordings:/tmp/livekit-recordings
```

Create `egress.yaml` alongside your other config files:

```yaml
api_key: YOUR_API_KEY
api_secret: YOUR_API_SECRET
ws_url: wss://livekit.yourproject.com

redis:
  address: localhost:6379

file_output:
  local: /tmp/livekit-recordings

log_level: info
```

Restart:

```bash
cd /opt/livekit && sudo docker compose up -d
```

### Record a Room

```bash
lk egress start \
  --url wss://livekit.yourproject.com \
  --api-key YOUR_API_KEY \
  --api-secret YOUR_API_SECRET \
  room-composite \
  --room test-room \
  --audio-only \
  --filepath /tmp/livekit-recordings/test-room-{time}.mp3
```

---

## Monitoring & Logs

### View all logs

```bash
cd /opt/livekit && sudo docker compose logs -f
```

### View LiveKit logs only

```bash
cd /opt/livekit && sudo docker compose logs -f livekit
```

### View Caddy logs (TLS issues)

```bash
cd /opt/livekit && sudo docker compose logs -f caddy
```

### Systemd service logs

```bash
sudo journalctl -u livekit-docker -f
```

### Prometheus Metrics (Optional)

Add to `livekit.yaml`:

```yaml
prometheus_port: 6789
```

Then expose port 6789 and scrape `http://YOUR_SERVER_IP:6789/metrics`. Key metrics:
- `livekit_rooms_total` — active rooms
- `livekit_participants_total` — connected participants
- `livekit_bytestransmitted_total` — bandwidth usage

---

## Upgrading

Edit `/opt/livekit/docker-compose.yaml` and update the LiveKit image tag:

```yaml
services:
  livekit:
    image: livekit/livekit-server:v1.10.0  # or :latest
```

Then:

```bash
cd /opt/livekit
sudo docker compose pull
sudo docker compose up -d
```

Check the [LiveKit releases page](https://github.com/livekit/livekit/releases) before upgrading in production.

---

## Troubleshooting

### Participants can connect but can't hear audio

- **Most likely cause**: UDP ports `50000–60000` are blocked.
- Check: `sudo ufw status` and your OVH control panel firewall.
- Also check `443/UDP` is open (needed for TURN/TLS fallback).

### WebSocket connection fails

- Check Caddy got a certificate: `docker compose logs caddy | grep "certificate"`
- Check LiveKit is running: `docker compose ps`
- Check DNS resolves: `host livekit.yourproject.com`

### "use_external_ip" ICE failures on OVH

OVH uses 1:1 NAT on some VPS configurations. If ICE fails, confirm `use_external_ip: true` in `livekit.yaml`. If that doesn't work, set the IP explicitly:

```yaml
rtc:
  ips:
    includes:
      - YOUR_SERVER_IP/32
```

Then restart: `cd /opt/livekit && sudo docker compose restart livekit`

### TURN not working

- Confirm port `443/UDP` and `3478/UDP` are open
- Confirm `turn.enabled: true` in `livekit.yaml`
- Check that `turn.domain` matches your DNS record exactly

### Check all containers

```bash
cd /opt/livekit && sudo docker compose ps
cd /opt/livekit && sudo docker compose logs --tail=50
```

---

## Summary Checklist

- [ ] DNS A record created for `livekit.yourproject.com`
- [ ] Docker installed on VPS
- [ ] Config generated with `livekit/generate`
- [ ] Files deployed to `/opt/livekit/`
- [ ] `livekit-docker` systemd service running
- [ ] Caddy obtained TLS certificate (check logs)
- [ ] Firewall ports open (443/TCP+UDP, 80, 7881, 3478, 50000-60000)
- [ ] `lk` CLI installed locally
- [ ] Health check passes
- [ ] Test room joined via LiveKit Meet demo — audio works
- [ ] Load test run successfully

---

*Sources: [LiveKit Self-Hosting Docs](https://docs.livekit.io/home/self-hosting/) · [LiveKit VM Guide](https://docs.livekit.io/home/self-hosting/vm/) · [Ports & Firewall](https://docs.livekit.io/home/self-hosting/ports-firewall/) · [config-sample.yaml](https://github.com/livekit/livekit/blob/master/config-sample.yaml)*
