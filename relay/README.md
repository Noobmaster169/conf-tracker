# relay

Live updates for video pages, from the yt-engine VPS instead of Vercel. Each live video's events come over ngrok
**once** and the relay copies them to every viewer, so ngrok and Vercel carry one stream per video, not one per viewer.

```
page load:     browser ─► Vercel ─► ngrok ─► box api            (unchanged)
live updates:  browser ─► https://relay.fiber.ag (VPS k3s) ─► relay ─► ngrok ─► box api   (one per video)
fallback:      relay down, refusing, or silent 10 s ─► /api/sessions/:id/events on Vercel (as before)
```

- The video page (Vercel) checks the password and signs a 12-hour ticket for that one video
  (`frontend/lib/relay-ticket.ts`); the relay only verifies it (`src/ticket.ts`). Both pin the same test vector.
- The relay keeps the last 2,000 events per video in memory to catch reconnecting viewers up. A viewer further
  behind gets its own upstream connection (a passthrough), exactly as before the relay. Nothing is stored on disk.
- It changes nothing on the box: it only reads `GET /sessions/:id/events` with the api's bearer.

## Ship

`relay/ship.sh` builds the image here, imports it into the VPS's k3s over SSH (`../vps/yt-engine.sh`), writes the
`conf-relay-env` Secret from `frontend/.env.prod` and `relay/.env.ship` (made on the first run, holds
`RELAY_SECRET`), applies `k8s/relay.yaml` and waits for the rollout. Namespace `conf-relay`, limit 160 Mi.

Then on Vercel: `RELAY_URL=https://relay.fiber.ag` and `RELAY_SECRET` (the value in `relay/.env.ship`), redeploy.

## Watch and roll back

- `curl https://relay.fiber.ag/healthz`: channels, viewers per video, passthroughs, upstream state.
- Logs: `../vps/yt-engine.sh 'kubectl -n conf-relay logs deploy/relay --tail=100'`.
- Load test: `RELAY_SECRET=… pnpm load --url https://relay.fiber.ag --session <id> --n 500 --minutes 10`.
- Roll back: remove `RELAY_URL` on Vercel and redeploy; every viewer is back on the Vercel route. The relay can
  then be deleted with `kubectl delete ns conf-relay`.
