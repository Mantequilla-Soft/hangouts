# Auto-deploy

A merge to `main` deploys itself to the production box (`hangout-api.3speak.tv`, `hangout.3speak.tv`):

1. GitHub Actions (`.github/workflows/ci.yml`) typechecks and tests the server, builds the SDKs, demo and docs, and tests the deploy script (`deploy/test-autodeploy.sh`). Its last job, `ci-ok`, passes only if everything did.
2. On the box, `hangouts-autodeploy.timer` runs `autodeploy.sh` every 2 minutes. When `main` has a new commit whose `ci-ok` check passed, it fast-forwards `/opt/hangouts`, rebuilds the SDKs, the demo, the docs and the server (`npm run build`: `server/dist` is not in git), restarts `hangouts-api` and checks that it answers. If the build or the check fails, it rolls back to the previous commit.

The same script deploys `live.3speak.tv` with a systemd drop-in (see below).

Nothing is pushed into the box and no secrets live in GitHub: the box pulls the public repo over HTTPS.

## Install (once, as root)

```bash
cd /opt/hangouts
sudo install -m 755 deploy/autodeploy.sh /usr/local/sbin/hangouts-autodeploy
sudo install -m 644 deploy/hangouts-autodeploy.service deploy/hangouts-autodeploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hangouts-autodeploy.timer
```

The script is copied, not linked, so a merge can't change the deployer itself. Re-run the `install` lines after changing `autodeploy.sh`.

## Operate

- Logs: `journalctl -u hangouts-autodeploy -f`
- Deploy now instead of waiting: `sudo systemctl start hangouts-autodeploy`
- Deploy without checking for live rooms (also a cancelled commit): `sudo touch /var/lib/hangouts-autodeploy/force` (then the line above)
- Pause: `sudo systemctl stop hangouts-autodeploy.timer` (`start` to resume)
- A commit whose CI failed, or whose deploy was rolled back, is skipped. The next commit on `main` is tried normally.
- It refuses to deploy if tracked files in `/opt/hangouts` were edited by hand, or the checkout has commits that aren't on `main`.

## Settings

Set with a systemd drop-in (`/etc/systemd/system/hangouts-autodeploy.service.d/*.conf`, `Environment=` lines). The defaults are the production box above.

| Variable | Default | |
|---|---|---|
| `DEMO_BUILD` | `site` | `site`: the demo site with `DEMO_API_URL` / `DEMO_LIVEKIT_URL`. `egress`: the LiveKit egress recording template (`--base /egress-template/`, no `VITE_*` URLs). `none`: skip. |
| `DOCS_BUILD` | `1` | `0` skips the docs site. |
| `QUIET_WAIT_MAX_MIN` | `0` (off) | Never deploy while someone is live: wait until no LiveKit room has anyone in it, at most this many minutes. Still busy after that, the deploy of that commit is **cancelled**: it is not retried on its own; the next merge starts a fresh wait, or the force file deploys it. Each tick asks once and exits, so the timer is never blocked. A newer merge during the wait does not restart it. |
| `LIVEKIT_HTTP` | `http://127.0.0.1:7880` | LiveKit for that check. |
| `LIVEKIT_KEYS_FILE` | `/opt/livekit/lk.env` | Holds `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`; the script signs a 5-minute room-list token with them and never prints them. If LiveKit can't be asked, that counts as busy: it never deploys blind. |

The check asks LiveKit itself, not `/rooms` or `/streams`, because those leave out unlisted rooms.

## live.3speak.tv

```bash
cd /opt/hangouts
sudo install -m 755 deploy/autodeploy.sh /usr/local/sbin/hangouts-autodeploy
sudo install -m 644 deploy/hangouts-autodeploy.service deploy/hangouts-autodeploy.timer /etc/systemd/system/
sudo install -D -m 644 deploy/live.3speak.tv.conf /etc/systemd/system/hangouts-autodeploy.service.d/live.conf
sudo systemctl daemon-reload
sudo systemctl enable --now hangouts-autodeploy.timer
```

`live.conf` builds the demo as the egress template, skips the docs, and never deploys while someone is live: it waits up to 4 hours for streams and rooms to end, then cancels that deploy.

## Notes

- Every deploy restarts the API. Live OBS streams are taken back over after a restart; recordings running at that moment are lost (same as a manual deploy).
- One-time host setup from `deploy.sh` (the recording dir in `/etc/tmpfiles.d`) is not repeated.
