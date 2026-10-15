# Auto-deploy

A merge to `main` deploys itself to the production box (`hangout-api.3speak.tv`, `hangout.3speak.tv`):

1. GitHub Actions (`.github/workflows/ci.yml`) typechecks and tests the server and builds the SDKs, demo and docs. Its last job, `ci-ok`, passes only if everything did.
2. On the box, `hangouts-autodeploy.timer` runs `autodeploy.sh` every 2 minutes. When `main` has a new commit whose `ci-ok` check passed, it fast-forwards `/opt/hangouts`, rebuilds what `deploy.sh` builds, restarts `hangouts-api` and checks that it answers. If the build or the check fails, it rolls back to the previous commit.

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
- Pause: `sudo systemctl stop hangouts-autodeploy.timer` (`start` to resume)
- A commit whose CI failed, or whose deploy was rolled back, is skipped. The next commit on `main` is tried normally.
- It refuses to deploy if tracked files in `/opt/hangouts` were edited by hand, or the checkout has commits that aren't on `main`.

## Notes

- Every deploy restarts the API. Live OBS streams are taken back over after a restart; recordings running at that moment are lost (same as a manual deploy).
- One-time host setup from `deploy.sh` (the recording dir in `/etc/tmpfiles.d`) is not repeated.
