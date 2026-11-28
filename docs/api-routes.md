# OpenPods API routes

Every HTTP route of the API server (`server/`, Fastify). The full table at the end
is generated from the route registrations by `server/scripts/list-routes.ts`, so it
cannot miss a route. The sections above it explain who may call each route and
what it answers.

## Conventions

- **Base URL**: wherever you run the server (production: `https://hangout-api.3speak.tv`
  for 3Speak). Default port `3002`.
- **Session**: `Authorization: Bearer <session JWT>` from `POST /auth/verify`.
  The JWT is HS256, issuer `hive-hangouts`, subject = Hive username, valid 24 h.
  "Session" below means `requireAuth`; "+ban" means `checkBan` also runs (a
  suspended account gets 403).
- **Host**: the route also checks that the caller is the room's `host` in the room
  metadata. "Host or mod" also accepts a moderator from `meta.mods`.
- **Optional session**: the route works without a token, but reads one if it is sent.
- **Rate limits** are per client IP (`@fastify/rate-limit`, not global). The server
  trusts `X-Forwarded-For` only from `127.0.0.1` (nginx on the same box).
- **Errors** are JSON `{ statusCode, error, message }` (from `@fastify/sensible`).
  Some routes add a machine code: `error` (templates, overlays, quotas), `code`
  (battles) or `reason` (captions, rewind). WHIP routes answer plain text, because
  OBS shows the body as is.
- **Pro** means `premium: true` on the user's row in the `embed-users` collection.

To print the current list yourself:

```bash
cd server
npx tsx scripts/list-routes.ts            # Markdown table
npx tsx scripts/list-routes.ts --json     # JSON
npx tsx scripts/list-routes.ts --check ../docs/api-routes.md   # CI: fails when this file is stale
npx tsx scripts/list-routes.ts --write ../docs/api-routes.md   # refresh the table below
```

The script builds the app with dummy settings: it reads no `.env`, opens no
database or LiveKit connection and listens on no port.

## Auth

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /auth/challenge` | none, 10/min | `{ username }` | `{ challenge, expires }`. The nonce looks like `hivehangouts:<user>:<ms>:<random>` and is valid 5 minutes, once. |
| `POST /auth/verify` | none, 15/min | `{ username, challenge, signature }` | `{ token, username }`. The signature must come from a posting key of the account, or from an account it granted posting authority to (`posting.account_auths`, e.g. a custodial service account). 400 bad or used challenge, 401 bad signature. |
| `GET /auth/me` | session | | `{ username }`. Use it to check a stored token before acting on it. |

## Rooms and streams

A room is a LiveKit room. `mode: 'conference'` is an audio room with a stage
(host, speakers, listeners). `mode: 'standalone'` is a one-person live stream
driven by the studio (or by OBS, see Templates). Room names are `<host>-<7 chars>`.
Rooms close 300 s after the last participant leaves.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /rooms` | none | | Array of rooms for the lobby, without `unlisted` ones and without `obs-*` connections in `numParticipants`. Fields: `name, title, host, description, backgroundImage, numParticipants, maxParticipants, createdAt, origin, visibility, language, boost, mode, post, liveAt, willPublishVod, collabGuest, broadcasting, portrait` (and `podcast: true` while a podcast recording runs). Cached 3 s. |
| `GET /streams` | none | | Standalone streams for discovery cards: `name, title, host, description, thumbnail, tags, visibility, mode, createdAt, live, viewers`. Live first. `no-store`. |
| `GET /health` | none | | `{ ok, uptime, sessions: { total, conference, standalone, live }, viewers }`, counts only. 503 when LiveKit is down. |
| `GET /rooms/:name` | none | | One room: the `/rooms` fields plus `broadcasting`, `headless`, `watermark` and `boostSummary`. 404 when gone. |
| `POST /rooms` | session+ban, 12/5 min | `{ title*, description, backgroundImage, visibility, language, mode, tags, boost: { enabled, minBoostUsd, creatorPayoutAccount, goal?: { title, targetHbd*, position? } } }` | 201 `{ room, token, isPremium }`. A `goal` (the create form's Boosts step) is checked like `PATCH /rooms/:name/boost`'s, a bad one is 400 before any room exists. The caller is the host and gets a publish token. A free host creating a `standalone` room who already went live in the last 24 h gets 429 `{ error: 'daily_stream_limit', message, retryAt }`. |
| `POST /rooms/:name/join` | session+ban | `{ delivery?: 'webrtc'\|'hls', hlsCapable? }` | `{ token, roomName, identity, isHost, isPremium, delivery, hlsUrl?, hlsFallback?, liveElsewhere? }`. The host and the approved collab guest get publish rights. A host already connected from another device gets the identity `<user>~watch` and `liveElsewhere: true`. |
| `POST /rooms/:name/listen` | optional session, 60/5 min | `{ displayName?, silent?, delivery?, hlsCapable? }` | `{ token, roomName, identity, isHost: false, isGuest, isPremium: false, delivery, hlsUrl?, hlsFallback? }`. Without a session the identity is `guest-<12 chars>` and the participant name is `displayName`; with a valid session it is the Hive account, and the name is the account too (`displayName` is ignored). `silent: true` gives a read-only `obs-*` identity (OBS browser source). 403 for `hive-internal` rooms and banned guest IPs. 409 when the WebRTC guest cap (`MAX_GUESTS_PER_ROOM`, default 50) is full and HLS is not possible. Token TTL 6 h (12 h for `silent`). |
| `PATCH /rooms/:name/layout` | session+ban, host | `{ layout?, focusedIdentity?, suppressScreenAutoFocus?, chatOpen? }` | `{ layout, focusedIdentity, suppressScreenAutoFocus, chatOpen }`. Stored in metadata (`recordLayout` and the view fields) so the recorder shows what the host sees. |
| `PATCH /rooms/:name/boost` | session, host | `{ enabled?, minBoostUsd?, creatorPayoutAccount?, goal?: { title, targetHbd, position? } \| null, tiers?, alerts?: { sound, tts, ttsMinHbd }, presets?: number[] }` | `{ boost }` (the merged `meta.boost`). `position` is where viewers see the goal bar: `top-right` (the default, also for a goal stored without one), `bottom-right` or `bottom-left` (the corners are a small card), `top` or `bottom` (a band); anything else is 400. |
| `GET /rooms/:name/boost/summary` | none | | `boostSummary`: goal progress, totals and top supporters. |
| `PATCH /rooms/:name/post` | session, host | `{ title?, thumbnail?, description?, tags? }` | `{ post }`, the feed post details of a stream (merged into `meta.post`). |
| `PATCH /rooms/:name/live` | session, host | `{ willPublishVod?, portrait? }` | `{ liveAt, willPublishVod, portrait }`. Stamps the go-live time once (server clock) and counts the stream for the free daily limit. 409 for OBS-driven rooms. A free host over the limit gets 429 and the room is closed. |
| `PATCH /rooms/:name/broadcast` | session, host | `{ broadcasting* }` | `{ broadcasting }`. Start/Resume set true, Pause sets false; this is what puts a stream in the live feeds. 409 for OBS-driven rooms. |
| `POST /rooms/:name/ingress` | session, host | `{ transcode?: boolean (default true), source?: 'obs'\|'phone' }` | `{ ingressId, whipUrl, streamKey, participantIdentity }`. Creates (or reuses) a LiveKit WHIP ingress that joins the room as `obs-ingress-<room>`; the studio uses it as a source. `source: 'obs'` is Pro (403 `{ error: 'pro_required' }`); `'phone'` (a phone or tablet screen app such as VDO.Ninja or Larix Screencaster) is free. `transcode` re-encodes to VP8 so every browser can decode it. The phone source is ONE ingress per host (`phone-<host>`, forwarded without transcoding: full resolution, ~0.05 s, almost no CPU; a Firefox without H.264 can't show it): the same address and key for every stream, moved into this room (and into each new room the host creates); 409 while it is sending into another of the host's rooms. An OBS ingress in the room gives way to it and the other way round (one outside feed per room). |
| `DELETE /rooms/:name/ingress` | session, host | | `{ ok: true }`. Deletes the room's OBS ingress; parks the phone's. |
| `PATCH /rooms/:name/vertical` | session, host, 40/min | `{ on, x, w, follow: 'manual'\|'camera'\|'source', track }` | `{ vertical }`. The 9:16 phone crop (fractions of the frame width) kept in `meta.vertical`. |
| `POST /rooms/:name/host` | session+ban, host | `{ newHost* }` | `{ host }`. Conference rooms only (403 for streams); the new host must be in the room. |
| `DELETE /rooms/:name` | session+ban, host | | 204. Ends the room (and, for an OBS stream, its ingress, recordings and WHIP session). A studio room's OBS ingress is deleted and the host's phone ingress parked (`phone-parked-<host>`), so an old address can't stream into an empty room of the same name. |

## Participants and moderation

| Route | Auth | Body | Answer |
|---|---|---|---|
| `PATCH /rooms/:name/participants/:identity/permissions` | session+ban, host | `{ canPublish* }` | `{ identity, canPublish }`. Promote to speaker or demote. In a stream this is the collab guest (one at a time, 409 if another is still there); the approval is kept in `meta.collabGuest` so a reconnect keeps it. |
| `DELETE /rooms/:name/participants/:identity` | session+ban, host or mod | | 204, kicks the participant. |
| `POST /rooms/:name/participants/:identity/ban` | session+ban, host or mod | | 204. Guests only (`guest-*`): bans their IP for this room and removes their chat lines. Hive accounts are banned platform-wide in `embed-users`. |
| `PATCH /rooms/:name/mods/:username` | session+ban, host | `{ isMod* }` | `{ mods }`, stored in `meta.mods`. Only Hive accounts can be mods. |

## Chat backlog

Chat itself travels on the LiveKit data channel (topic `chat`). These routes keep
the last lines so a viewer who joins late (or watches over HLS) sees them, and so
the VOD can replay them.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /rooms/:name/chat?limit=` | optional session, 60/min | | `{ messages }`, newest backlog (default size 300, `CHAT_BACKLOG_SIZE`). Lines of since-suspended accounts are dropped. 403 for `hive-internal` rooms without a session. |
| `POST /rooms/:name/chat` | session OR LiveKit room token, 30/20 s | `{ text*, timestamp?, identity?, name?, livekitToken? }` | 201 (new) or 200 (duplicate) `{ ok: true }`. Guests can chat: they prove their identity with the room token they got from `/listen` (`livekitToken`). The stored name is never the body's `name` (kept only so older clients validate): a session line is named after the account, a guest line after the name in its room token. |
| `DELETE /rooms/:name/chat/:id` | session, host or mod, 60/min | | 204, and a `{ type: 'chat-delete', id }` message on the `chat` topic. |

## Polls, predictions and points

One poll or prediction runs per room at a time. A poll has 2 to 4 options and one
vote per Hive account. A prediction has 2 outcomes; viewers stake channel points
(not money, start balance `POINTS_START` = 1000) and winners split the pot.

Points are ONE balance per Hive account across all streams (`lib/points.ts`).
The server counts what earns them: watching a live stream 10 a minute (signed-in
and connected, WebRTC or HLS, once per account), chat 1 a word (at most 20 a
message and 50 a minute), streaming 100 a minute while live with an audience,
a raid 500 to the raider and a full-time battle 500 to both hosts (once an hour
per pair), a boost 100 plus 100 per HBD (at most 2,000). They are spent on
prediction stakes and on boosts paid with points
(`POST /rooms/:name/boosts/points`, at least `POINTS_BOOST_MIN`; 10,000 points
count as 1 HBD for the alert size and the host's minimum; the points are gone,
nobody is paid, and they count toward no goal or battle). A balance untouched
for `POINTS_TTL_DAYS` (90) starts again at `POINTS_START`, as an `expire`
movement of its own (in the history and on the chain).

Every movement is a row in `points-ledger` (the wallet history) and, batched
every `POINTS_BATCH_MIN` (5) minutes, a custom_json `3speak_points` on Hive
signed by `POINTS_LOG_ACCOUNT` (@threespeak-pro):
`{"v":1,"at":<unix s>,"m":[[user, delta, kind, dt, ref?]]}` with kind `w`
watch, `s` stream, `c` chat, `r` raid, `t` battle, `b` boost, `x` spent on a
points boost, `f` refund, `p` prediction, `e` expire (back to the start), `l` login, `k` rank, `m` remix,
two letters for the later award kinds (`lib/pointsLog.ts` KIND_CODE), and `dt` seconds after `at`. Watching
and chat name no stream (viewing history stays private), and the awards for
watching, tagging, voting, clipping and tipping (`finish`, `premiere`,
`playlist`, `tag`, `pollvote`, `clip`, `tip`) keep their ref in the wallet
history only. With the 3SP token the log changes id at the airdrop: movements
from before it stay `3speak_points` (replayed with `npm run points:replay`
they give exactly the airdropped balances), movements after it are
`3sp_points` (same format), and between setting `POINTS_TOKEN_CONTRACT` and
the airdrop nothing new is logged, so no movement is ever counted twice. The ways to earn beyond watching, chat and streaming are awards
(`lib/pointsAwards.ts`): each has an id that pays once, the amounts and limits
are this server's, and every earning pays x2 inside a double-points window
(`POINTS_DOUBLE_WEEKENDS`, `POINTS_DOUBLE_WINDOWS`). Points also promote a
3Speak video (Discover #1, `POST /points/promote`): the checker says whether it
can be promoted and for how many days (`GET /promote/eligible/:author/:permlink`)
and books it (`PUT /promote/points`, `POINTS_AWARD_SECRET`, once per spend id;
network errors and 5xx are tried again, a refusal refunds). The spend's ref is
`promote:<author>/<permlink>`. Points can be sent to another account
(`POST /points/transfer`, `lib/pointsTransfer.ts`), also as a tip on one of
the receiver's posts (`post`): with the token on it is a Magi `transfer` in the
same spend flow as a burn, and both sides get a `transfer` row marked `chain`
(never minted or burned again). Not an earning: never doubled. `npm run
points:replay` (server) rebuilds every balance from the chain alone. Every change is broadcast on the `poll` data topic, at most about once a second.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /rooms/:name/polls/active` | optional session, 60/min | | `{ poll \| null, myVote?, myStake?, balance? }` |
| `GET /rooms/:name/polls` | none, 30/min | | `{ polls }`, finished polls of the stream (kept a year, for the VOD). |
| `GET /points` | session, 30/min | | `{ balance }` |
| `GET /users/:account/points` | none, 60/min | | `{ account, balance, expiresAt, start, ttlDays, earn, boostMin }`, for a wallet or profile page. |
| `GET /users/:account/points/history` | none, 60/min | `?before=<ms>&limit=` | `{ account, items: [{ id, delta, kind, ref?, at, tx }], next }`, newest first. |
| `GET /points/:channel` | session, 30/min | | `{ channel, balance }`, the same global balance (older clients). |
| `POST /rooms/:name/boosts/points` | session+ban, 10/min | `{ amount*, message*, displayName?, recipient? }` | 201 `{ boost, balance }`; 400 too few points or below the minimum, 403 own stream, 409 boosts off. |
| `POST /points/daily` | session, 10/min | | `{ awarded, points, balance }`: the day's sign-in point, and on the first sign-in of a day the `streak`, `week5` and `anniv` awards. |
| `POST /points/awards` | `x-points-award-secret`, 30/min | `{ awards*: [{ id*, user*, kind*, ref?, units? }] }` (max 200) | `{ results: [{ id, awarded: true, points } \| { id, awarded: false, reason }] }`, reason `invalid`, `account`, `own`, `banned`, `already`, `limit` or `error`. `kind` is one of the checker's kinds (rank, remix, first5, vodtime, finish, listen, premiere, playlist, first, reach, storystreak, challenge, premheld, tag, reply, community, tip, remixed, followers, referral); `units` (integer >= 0) is minutes for vodtime and listen, milli-HBD for tip. 404 without `POINTS_AWARD_SECRET`. |
| `GET /points/awards/config` | none, cached 300 s | | `{ login, rank, remix, remixPerDay, kinds: { <kind>: amount \| { amount?, perUnit?, maxPerDay?, perDay?, maxEver?, perHbd?, max?, minViewers?, amounts? } }, double: { factor }, quests: { points, perWeek }, transfer: { min, max } }` (`transfer`: this server sends points between accounts) |
| `GET /points/events` | none, cached 60 s | | `{ double: { active, until?, next? } }` (ISO times). |
| `GET /points/quests` | none, 60/min | `?user=<account>*` | `{ week: 'YYYY-Www', quests: [{ id, kind, target, progress, done, points: 300, title_key }] }`; a done quest not paid yet pays on this read. 400 not a Hive account. |
| `POST /points/pwa` | session, 5/min | | 200 `{ awarded: true, points: 50, balance }`; 409 claimed already. Once ever, claimed by the installed app. |
| `GET /points/promote/quote` | none, cached 300 s | | `{ per24h, maxDays: 7, enabled }`: what promoting a 3Speak video costs (`PROMOTE_POINTS_PER_24H`, 5,000 a day); `enabled` while `POINTS_AWARD_SECRET` is set. |
| `POST /points/promote` | session+ban, 10/min | `{ author*, permlink*, days*: 1..7, burnTx? }` | 201 `{ promotedUntil, balance }`; 202 `{ pending, spendId }` (poll `GET /points/spends/:id`, which then carries `promotedUntil`); 400 `code: 'too_long', maxDays` or `'insufficient'`; 409 `code: 'ineligible', reason` (the checker's), or `'failed'` when the checker turned the booking down ("Your points are back."); 428 `code: 'sign', op`; 503 checker unreachable; 404 without `POINTS_AWARD_SECRET`. |
| `POST /points/transfer` | session+ban, 10/min | `{ to*, amount*: 1..10,000,000, post?: '<to>/<permlink>', burnTx? }` | 201 `{ balance, to, amount }`; 202 `{ pending, spendId }`; 400 `code: 'invalid'` (yourself, no such account, a tip not to the post's author) or `'insufficient'`; 428 `code: 'sign', op` (the Magi `transfer` for the wallet); 503 Hive or Magi unreachable. |
| `POST /rooms/:name/polls` | session+ban, host, 20/5 min | `{ kind?: 'poll'\|'prediction', question*, options*, durationSec* }` | 201 `{ poll }`. Polls run 15 to 600 s, predictions up to 1800 s. |
| `POST /rooms/:name/polls/:id/vote` | session+ban, 20/min | `{ option* }` | `{ poll, myVote }` |
| `POST /rooms/:name/polls/:id/stake` | session+ban, 20/min | `{ option*, amount* }` | `{ poll, myStake, balance }` |
| `POST /rooms/:name/polls/:id/end` | session+ban, host, 30/min | | `{ poll }` |
| `POST /rooms/:name/polls/:id/resolve` | session+ban, host, 30/min | `{ winner*: 0\|1 }` | `{ poll }` (prediction only). |
| `POST /rooms/:name/polls/:id/cancel` | session+ban, host, 30/min | | `{ poll }` |

`poll` is a `PollView`: `{ id, room, host, kind, question, options: [{ label, votes, points? }], total, pot?, status: 'open'|'locked'|'closed'|'resolved'|'cancelled', createdAt, endsAt, endedAt?, offset, winner? }`.

## Points shop

Every other way to spend 3Speak Points goes through one buy route
(`POST /points/shop/buy`, `lib/pointsShop.ts`): the item checks the request
and names its price, the points are paid (the Mongo balance, or a Magi burn
with purpose `shop` once the token is live), then the item happens. If it
cannot, the points come back ("Your points are back."). The spend's ref is
`shop:<item>:<what>`. Some items are held: paid now, decided later (a host
accepts a suggested poll, a creator delivers a requested video, the spotlight
auction closes). A held order is finished once: done (the points stay spent,
or are paid to the host or creator as `payout`, never doubled) or refunded;
one nobody decided on in time comes back (the shop sweep, every minute).
Points spent on someone's channel (shop orders with a channel, points boosts,
transfers and points tips) add up per month in `points-support`: the channel's
top supporters, its supporter badge (all months, `SHOP_SUPPORTER_MIN`, 10,000)
and the monthly board of who spent most on others.

Items (prices change with `SHOP_<NAME>` in the env):

| Item | Price | Fields | What happens |
|---|---|---|---|
| `highlight` | 500 | `room*, text*` (200) | A chat line that stands out, pinned on top for a minute (`pinnedChat` in the room metadata; chat system kind `highlight`). |
| `readaloud` | 1,000 | `room*, text*` (200) | `{ type: 'readaloud', sender, message }` on the `boost` topic; the stream reads it aloud. 409 `off` when the host set `boost.alerts.readAloud: false`. |
| `suggestpoll` | 2,000 | `room*, question*, options*` (2 to 4) | Held 30 minutes for the host (`poll` topic `poll-suggestion`). Accept runs it; reject, no answer or the stream ending refunds. 3 open per viewer and stream. |
| `reward` | the host's | `room*, rewardId*, input?` | One of the host's channel rewards, queued for the host (`rewards` topic, chat system kind `reward`). Held 24 hours: done keeps it spent, refund or no answer gives it back. |
| `bounty` | 100 and up | `room*, amount*, text` (new) or `bountyId` (add to one) | Viewers pool points on a challenge (`bounty` topic). Done pays every pledge to the host; declined or 6 hours without an answer gives them back. 5 open per stream. |
| `stickers` | 1,000 | `channel*` | The channel's sticker set, for good (`GET /points/shop` `stickers`; chat shows `:st-<id>:` big for owners). |
| `minutes` | 10,000 | | 30 more minutes past the free stream cap, for today (UTC), 4 a day; not for Pro. A running OBS stream gets them at once; the free VOD records that long. |
| `cosmetic` | 2,000 to 10,000 | `id*, to?` | A chat name colour, badge, avatar frame or profile theme (`cosmetics` in `GET /points/shop`), for yourself or a gift. |
| `proday` | 50,000 | `to?` | 24 hours of Pro (`embed-users` `premium_source: 'points'`, `premium_expires_at`), from the end of a pass or trial still running. 409 `already_pro` for Pro from a subscription or given by hand. |
| `audiolong` | 5,000 | | One free audio upload 20 minutes past the cap, within 30 days (`audio_length_grants`, used up by snapieaudio). 3 open at most; not for Pro. |
| `streakfreeze` | 1,000 | `day*` | A missed sign-in day of the last 14 keeps the streak (not the 5-of-7 week). 2 a month. |
| `request` | 1,000 and up | `creator*, text*` (300), `amount*` | Held for the creator 14 days. Delivered (a post of theirs), the asker approves or it is paid in 7 days; declined, taken back or never delivered comes back. |
| `spotlight` | 20,000 and up | `author*, permlink*, bid*` | A bid for next ISO week's home spotlight, at least the top bid + 1,000. The top bid stays and lower ones come back at once; when the week starts the checker books the winner (`spotlight` grant), or it comes back. |
| `publishslot` | 25,000 | `kind*: 'video'\|'short'` | Checker: one more publish of that kind within 24 hours. |
| `story48` | 2,000 | `author*` (you), `permlink*` | Checker: your live Story kept 48 hours. |
| `storyfreeze` | 1,000 | `day*` | Checker: a missed Story day keeps the Story streak (2 a month). |
| `premierefront` | 500 | `owner*, permlink*` | Checker: your name in the premiere's front row. |
| `encode` | 5,000 | `author*` (you), `permlink*` | Checker: your waiting video encodes first. |
| `adcredit` | 10,000 per HBD | `campaignId*, hbd*` | Checker: pays a self-promo ad booking (capped per month by the checker). |

The checker items ask `GET <CHECKER_URL>/points/grant/check` first (a refusal
costs nothing: 409 with the checker's code), then book `PUT /points/grant`
(`x-points-award-secret`, once per spend id; network errors and 5xx are tried
again, a refusal refunds). Without `POINTS_AWARD_SECRET` they, and the
spotlight, are off.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /points/shop` | none, cached 300 s | | `{ items: { <item>: { enabled, price?, min?, max?, ... } }, stickers, cosmetics: { <id>: { kind, price } }, supporterMin }` |
| `POST /points/shop/buy` | session+ban, 20/min | `{ item*, burnTx?, ...the item's fields }` | 201 `{ order, balance }` (`order.status` `done` or `held`, `order.result`); 202 `{ pending, spendId, orderId }` (poll `GET /points/spends/:id`, which then carries `order`); 400 `invalid` or `insufficient`; 403, 404 (no such item, off, stream not live), 409 (the item's code, or "Your points are back."), 429 a limit; 428 `code: 'sign', op`. |
| `GET /points/shop/orders` | session | `?item=` | `{ orders }`, your last 50. |
| `GET /points/shop/orders/:id` | session | | `{ order }`; 404 not yours. |
| `GET /rooms/:name/poll-suggestions` | none | | `{ suggestions: [{ id, from, question, options, at }] }` |
| `POST /rooms/:name/poll-suggestions/:id/accept\|reject` | session, host or mod, 30/min | `{ durationSec? }` (15..600, default 60) | accept 201 `{ poll }`; reject `{ ok }` (refunded). |
| `GET /channels/:owner/rewards` | none, cached 30 s | | `{ rewards: [{ id, title, cost, prompt, enabled }] }` |
| `PUT /channels/rewards` | session+ban, 20/min | `{ rewards*: [{ id?, title*, cost*: 100..1,000,000, prompt?, enabled? }] }` (12 at most) | `{ rewards }`, your channel's, saved whole. |
| `GET /rooms/:name/rewards/queue` | session, host or mod | | `{ queue: [{ id, from, rewardId, title, cost, input?, at }] }` |
| `POST /rooms/:name/rewards/:id/done\|refund` | session, host or mod, 60/min | | `{ ok }` |
| `GET /rooms/:name/bounties` | none | | `{ bounties: [{ id, text, total, backers, createdBy, ... }] }`, open ones. |
| `POST /rooms/:name/bounties/:id/done\|decline` | session, host, 30/min | | `{ bounty }` |
| `GET /points/stream-extra` | session | | `{ extraMs }`, bought for today's streams. |
| `GET /points/streak` | session | | `{ run, today, missed: ['YYYY-MM-DD'], freezesLeft, perMonth }` |
| `GET /points/audio-grants` | session | | `{ grants: [{ extraSeconds, expiresAt }] }` |
| `GET /users/:account/cosmetics` | none, cached 60 s | | `{ owned, equipped: { color?, badge?, frame?, theme? }, stickers: [channel] }` |
| `PUT /points/cosmetics` | session+ban, 30/min | `{ color?, badge?, frame?, theme? }` (an id you own, or null) | the same as above, yours. |
| `GET /channels/:owner/supporters` | none, cached 60 s | `?month=YYYY-MM` | `{ month, top: [{ user, points }], badges: [user], min }` |
| `GET /points/supporters` | none, cached 300 s | `?month=YYYY-MM` | `{ month, top: [{ user, points, channels }] }`, who spent most on others. |
| `GET /points/requests` | session | `?role=from\|creator` | `{ requests: [{ id, from, creator, text, points, state, permlink?, at, until? }] }` |
| `GET /channels/:owner/requests` | none, cached 60 s | | `{ requests }`, open and delivered ones. |
| `POST /points/requests/:id/deliver\|decline\|approve\|cancel` | session+ban, 30/min | `{ permlink }` (deliver) | `{ request }`; 403 not yours to do, 409 the wrong state. |
| `GET /points/spotlight` | optional session | | `{ week, endsAt, min, step, top: { bid, user, author, permlink, mine } \| null }` |

## Raids

A host sends their viewers to another live stream after a countdown
(`RAID_COUNTDOWN_SEC`, default 10). Limits: one raid per host per
`RAID_COOLDOWN_MIN` (default 10), one incoming raid per stream per 2 minutes.
Unlisted and Hive-only streams are not targets.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /rooms/:name/raid/targets` | session, host, 20/min | | `{ targets, cooldownUntil }` |
| `GET /rooms/:name/raid` | none, 60/min | | `{ raid \| null }` |
| `POST /rooms/:name/raid` | session+ban, host, 20/10 min | `{ target* }` (room name) | 201 `{ raid }` with `{ id, from, target, viewers, endsAt, endsInMs }`. 403 when the target does not take raids. |
| `DELETE /rooms/:name/raid` | session, host, 20/min | | 204, sends `raid-cancel`. |
| `GET /raids/settings` | session, 30/min | | `{ acceptRaids }` |
| `PUT /raids/settings` | session+ban, 20/min | `{ acceptRaids* }` | `{ acceptRaids }` |

## Battles

Two browser-studio streams split the screen for 180, 300 or 600 s; the boosts each
side gets in that window decide the winner. Each side keeps its own boosts. The same
`battle` object is written into the metadata of both rooms. OBS streams cannot battle.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /battles/candidates` | session, 60/min | | `{ streams: [{ room, host, title, thumbnail }], durations }` |
| `GET /battles/:room` | none | | `{ battle }` |
| `POST /battles/:room/invite` | session+ban, 10/min | `{ opponent*, durationSec* }` | 201 `{ battle }`. The invite waits 60 s. |
| `POST /battles/:room/respond` | session+ban, 20/min | `{ accept* }` | `{ battle }` |
| `POST /battles/:room/end` | session, 20/min | `{ reason?: 'ended'\|'dropped' }` | `{ battle }`. `dropped` only after the other host has been gone 30 s. |
| `POST /battles/:room/settle` | session, 20/min | | `{ battle }`, decides the winner once the settle time has passed. |
| `POST /battles/:room/link` | session, 20/min | | `{ token, room, host, identity }`: a hidden, subscribe-only token (`obs-battle-*`) for the other room, so the studio can draw the opponent. |

Errors carry `{ code, message }`.

## Live captions

Off unless `CAPTIONS_ENABLED=true`. The host's browser sends its own mic to the
speech server and publishes the text on the `captions` data topic; this server only
hands out slots (at most `CAPTIONS_MAX_STREAMS` at once).

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /captions/status` | none | | `{ enabled, max, active, available }` |
| `POST /rooms/:name/captions/start` | session+ban, host, 12/min | `{ lang? }` (default `en-us`) | `{ ok, lang, renewInSec: 30, expiresInSec, enabled, max, active }`. Call again every 30 s to renew. 503 `reason: 'disabled'`, 429 `reason: 'full'`, 409 `reason` held by another session. Sets `meta.captions = { lang }`. |
| `POST /rooms/:name/captions/stop` | session+ban, 12/min | | `{ ok: true }` |

## Recording, VOD and podcast

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /rooms/:name/record/start` | session+ban, host | `{ mode?: 'audio'\|'video', layout?, publish?, download? }` | `{ egressId, status: 'recording', mode, layout, filepath }`. Recording is Pro, with one exception: a free host may record a standalone stream with `publish: true` (capped at 30 min, no download). A standalone stream records the host's program track straight to MP4. 409 when already recording. |
| `PATCH /rooms/:name/record/layout` | session+ban, host | `{ layout* }` | `{ egressId, layout }`, video recordings only. |
| `POST /rooms/:name/record/stop` | session+ban, host | | `{ egressId, status: 'publishing'\|'stopped', mode, layout, duration, publishStatusUrl?, downloadUrl? }`. With `publish`, the server uploads the file itself as the VOD of the announcement post (embed row `{ owner: host, permlink: roomName }`). |
| `GET /rooms/:name/record/publish-status` | none | | `{ status: 'uploading'\|'processing'\|'published'\|'failed', progress, updatedAt, failed }` |
| `GET /rooms/:name/record/file/:token` | token in path | | The recorded file (MP4 for video, OGG/MP3 for audio). The token is the capability, valid 1 h after stop. |
| `GET /rooms/:name/record/status` | session+ban | | `{ recording, egressId?, mode?, layout? }` |
| `POST /rooms/:name/record/upload` | session+ban, host | `{ filePath*, duration?, title?, tags? }` | `{ success, permlink, cid, playUrl }`. Legacy: uploads an audio recording to `AUDIO_API_URL`. New integrations use the SDK's `onAudioHandoff`. |
| `PATCH /rooms/:name/record/:audioPerm/metadata` | session+ban | `{ title?, description?, tags?, post_permlink? }` | Updates that audio entry on `AUDIO_API_URL`. |
| `POST /rooms/:name/podcast/start` | session+ban, host, Pro, 10/min | | `{ recording: true, startedAt, speakers }`. Audio (conference) rooms only. One track egress per speaker. Off with `PODCAST_RECORDING_ENABLED=false` (503). |
| `POST /rooms/:name/podcast/marker` | session, host, 30/min | `{ title* }` | `{ ok, at }`: a chapter mark (seconds into the recording). |
| `POST /rooms/:name/podcast/stop` | session, host, 10/min | | An episode: `{ token, room, title, status, durationSec, createdAt, mixUrl, tracks: [{ identity, offsetSec, url }], chapters }`. One MP3 mix plus a file per speaker. |
| `GET /rooms/:name/podcast/status` | session | | `{ recording, startedAt?, speakers?, chapters? }` |
| `GET /podcast/recordings` | session | | `{ recordings }`, the caller's episodes of the last day. |
| `GET /podcast/files/:token/:file` | token in path, 60/min | | The mix or a speaker file. Kept one day. |

## Restream to YouTube, Twitch or a custom server

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /rooms/:name/stream/start` | session+ban, host, Pro | `{ platform*: 'youtube'\|'twitch'\|'custom', streamKey*, backgroundImageUrl?, videoEnabled? }` | `{ egressId, status: 'streaming', platform }`. For `custom` the stream key is the whole `rtmp://` or `rtmps://` URL, the platform's server address and key (Restream.io, Kick, ...); it must resolve to a public address, else 400. 402 for non-Pro, 409 already streaming. |
| `POST /rooms/:name/stream/stop` | session+ban, host | | `{ egressId, status }` |
| `GET /rooms/:name/stream/status` | session+ban | | `{ streaming, egressId }` |

## DVR, clips, highlights and rewind

The DVR is a second egress (2 s HLS segments) that keeps the last `DVR_BUFFER_SEC`
(default 600) on disk while a Pro host is live. Off with `DVR_ENABLED=false`.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /rooms/:name/dvr/start` | session+ban, host, Pro | | `{ status: 'recording', egressId }`. Idempotent. 402 for non-Pro, 503 when disabled. |
| `POST /rooms/:name/dvr/stop` | session+ban, host | | `{ status: 'stopped' }` |
| `GET /rooms/:name/dvr/status` | none | | `{ recording }`: show the Clip button only when true. |
| `POST /rooms/:name/dvr/clip` | optional session, 6/min | | `{ path: '/dvr/clips/<file>.mp4', clip? }`. Any viewer can clip the last 30 s. A signed-in clipper is credited and the clip is kept (`clip`). |
| `GET /dvr/clips/:file` | none | | The MP4. Kept `CLIP_KEEP_HOURS` (48), at most `CLIPS_DIR_MAX_MB` on disk. |
| `GET /rooms/:name/highlights` | session, 60/min | | `{ room, host, isHost, liveAt, moments, clips }`. The host sees the chat and boost spikes (`moments`) and every kept clip; others see their own clips. While DVR runs, each moment cuts an automatic clip (`source: 'auto'`). |
| `GET /clips/mine` | session, 60/min | | `{ clips }` |
| `POST /clips/:id/vertical` | session (host or clipper), 6/min | | `{ clip }` with `vertical.path`: a 9:16 copy cut with the host's phone crop, for a Short. 400 when the stream had no crop. |
| `DELETE /clips/:id` | session (host or clipper), 30/min | | `{ deleted: true }` |
| `GET /rooms/:name/dvr/rewind` | optional session, 30/min | | `{ available, playlist?, windowSec?, liveAt? }`. `playlist` is an HLS URL viewers can seek in. 401 `login_required` for Hive-only rooms. |
| `GET /rooms/:name/dvr/hls/:token/:file` | token in path, 600/min | | `live.m3u8` or a `.ts` segment of the rewind playlist. The token is an hourly HMAC. |

A clip is `{ id, room, host, clipper, source: 'viewer'|'host'|'auto', path, offsetSec, durationSec, reasons, vertical: { available, path }, createdAt, expiresAt }`.

## HLS for large audiences

| Route | Auth | Answer |
|---|---|---|
| `GET /rooms/:name/hls/:file` | none, no limit | `live.m3u8` (cache 1 s) or a `.ts` segment (cache a day, immutable). 404 `starting` until the first playlist exists. |

`/join` and `/listen` decide the delivery. See the integrator guide, "HLS delivery".

## Boosts

Boosts are HIVE or HBD transfers to `BOOST_PLATFORM_ACCOUNT` with a JSON memo. The
server watches Hive (`startBoostListener`), validates, pays the host (or the collab
guest) minus `BOOST_PLATFORM_FEE_PERCENT`, refunds what it cannot place, and sends a
`boost` data message to the room.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /boosts/config` | none | | `{ enabled, platformAccount, feePercent }` |
| `GET /boosts/ledger?room=` | none | | Ledger entries kept in memory: `{ id, txId, opIndex, room, sender, message, displayName?, amount, asset, usdAmount?, payoutRecipient?, feeAmount?, payoutAmount?, rejectReason?, ... }` |
| `POST /boosts/ingest` | `x-admin-key: BOOST_INGEST_KEY` | `{ txId, opIndex, blockNum, timestamp, to, amount, memo }` | 202 `{ accepted: true }`. Manual reconciliation only; disabled (403) when the key is empty, 503 when boosts are off. |

## Templates, OBS (headless streams) and the streaming secret

A template is a saved "go live" setup (at most 20 per user). OBS streams to
`${PUBLIC_WHIP_BASE}/<owner>/<slug>` with the user's streaming secret as Bearer
Token; the server then creates the room, joins the ingress as the host, starts
VOD/DVR, posts the Hive announcement and ends it all when OBS stops. OBS is Pro.
Errors carry `error`: `invalid_input` 400, `not_found` 404, `name_taken` 409,
`live` 409, `limit_reached` 409, `storage_unavailable` 503.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /templates` | session+ban | | `{ templates, whipBase, chatOverlayKey }` |
| `POST /templates` | session+ban, 30/5 min | template fields | 201 `{ template }` |
| `PATCH /templates/:id` | session+ban, 60/5 min | any template fields (nested objects merge) | `{ template }`. A rename while live is 409 `live`. |
| `DELETE /templates/:id` | session+ban | | `{ ok: true }` |
| `GET /templates/:id/status` | session+ban | | `{ state, room, startedAt, capSeconds, ingress, announced, lastEnd? }` (`state: 'idle'` when not live). |
| `GET /stream-secret` | session+ban, 30/5 min | | `{ secret }` (created on first call). |
| `POST /stream-secret/reset` | session+ban, 10/5 min | | `{ secret }`. Running streams keep going. |
| `GET /overlay/:key` | key in path, 120/min | | `{ live, room }`, for the OBS chat overlay (browser dock). |
| `POST /whip/:owner/:slug` | `Authorization: Bearer <streaming secret>`, 10/min | SDP offer (`application/sdp`) | 201 SDP answer, `Location: /whip/s/<token>`. |
| `PATCH /whip/s/:token` | token in path, 120/min | trickle ICE | proxied to the ingress |
| `DELETE /whip/s/:token` | token in path, 30/min | | 200, ends the stream |

Template fields: `name*, title*, description, thumbnail (http(s) URL), tags (max 10), language, visibility, boost: { enabled, minBoostUsd, creatorPayoutAccount }, recording: { publishVod, allowClips }, announce: { enabled, community, communityTitle, declineRewards, rewardPowerup, beneficiaries }`. The answer adds `id, owner, slug, whipUrl, createdAt, updatedAt, lastLiveAt`.

## Studio overlays

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /studio/overlays` | session | | `{ templates }` |
| `PUT /studio/overlays` | session+ban, 30/5 min, 64 KB | `{ templates* }` (at most 12) | `{ templates }` (cleaned). Each is `{ id, name, config: { lowerThird: { name, title }, ticker: { text, speed, position }, countdown: { label, minutes }, brb: { message, music, volume }, fade } }`. |

## Pro (premium)

| Route | Auth | Answer |
|---|---|---|
| `GET /premium/:username` | none | `{ premium, premium_source, premium_expires_at, testing_started, testing_available, testing_hours }`. Cached 60 s. |
| `GET /premium?limit=` | none | `{ count, subscribers: [{ username, premium_source, premium_expires_at }] }` |
| `POST /premium/start-testing` | session+ban, 5/min | `{ ok: true, expiresAt, hours }`. The one-time free trial (`PRO_TESTING_HOURS`, 24). 409 already used or already Pro, 403 when trials are off. |

## Events and presence

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /events?status=&host=&limit=` | none | | Array of events. Ended events only when `status=ended`; `live` events whose room is gone flip to `ended`. |
| `GET /events/:id` | none | | One event. |
| `POST /events` | session | `{ title*, scheduledAt* (future ISO), description, coverImage, tags, visibility: 'public'\|'unlisted' }` | 201 event |
| `PATCH /events/:id` | session, event host | same fields | event (scheduled events only) |
| `DELETE /events/:id` | session, event host | | 204 (cancels, or ends a live one) |
| `POST /events/:id/attend` / `DELETE /events/:id/attend` | session | | `{ attendees, attendeeCount }` |
| `POST /events/:id/start` | session, event host | | `{ event, room, token, isPremium }`: creates a conference room with `meta.eventId` and returns a host token. |
| `GET /presence/:username` | none | | `{ online: false }` or `{ online: true, roomName, roomTitle, role: 'host'\|'speaker'\|'listener' }` |
| `POST /presence/bulk` | none, 20/min | `{ usernames* }` (1 to 50) | `{ [username]: presence }` |

An event is `{ id, title, description, hostUsername, scheduledAt, coverImage, tags, attendees, attendeeCount, status: 'scheduled'|'live'|'ended'|'cancelled', roomName, visibility, createdAt, updatedAt }`.

## Games

Built-in plugins: chess, fast draw, word guess. Game state travels on the `game` data topic.

| Route | Auth | Body | Answer |
|---|---|---|---|
| `GET /games` | none | | the registered game plugins |
| `GET /game-collections` | none | | word collections (for word guess) |
| `GET /rooms/:name/game` | session+ban | | `{ gameId, participants, startedAt, state, boardState, isSpectator, serverTime }` |
| `POST /rooms/:name/game/start` | session+ban, host | `{ gameId*, config? }` | 201 `{ gameId, participants, startedAt }` |
| `POST /rooms/:name/game/action` | session+ban, player | `{ action* }` | `{ ended }` |
| `DELETE /rooms/:name/game` | session+ban, host | | 204 |

## All routes (generated)

`preHandler` lists the Fastify hooks: `requireAuth` = session token,
`checkBan` = suspended accounts refused. Host, mod, Pro and token checks happen
inside the handlers and are described above.

<!-- routes:start (generated by server/scripts/list-routes.ts, do not edit by hand) -->
159 routes.

| Method | Path | preHandler | Rate limit | Query | Body (`*` = required) |
|---|---|---|---|---|---|
| POST | `/auth/challenge` | none | 10 / 1 minute |  | username*: string |
| GET | `/auth/me` | requireAuth | none |  |  |
| POST | `/auth/verify` | none | 15 / 1 minute |  | username*: string, challenge*: string, signature*: string |
| GET | `/battles/:room` | none | none |  |  |
| POST | `/battles/:room/end` | requireAuth | 20 / 1 minute |  | reason: ended\|dropped |
| POST | `/battles/:room/invite` | requireAuth, checkBan | 10 / 1 minute |  | opponent*: string, durationSec*: number |
| POST | `/battles/:room/link` | requireAuth | 20 / 1 minute |  |  |
| POST | `/battles/:room/respond` | requireAuth, checkBan | 20 / 1 minute |  | accept*: boolean |
| POST | `/battles/:room/settle` | requireAuth | 20 / 1 minute |  |  |
| GET | `/battles/candidates` | requireAuth | 60 / 1 minute |  |  |
| GET | `/boosts/config` | none | none |  |  |
| POST | `/boosts/ingest` | none | none |  | txId*: string, opIndex*: number, blockNum*: number, timestamp*: number, to*: string, amount*: string, memo*: string |
| GET | `/boosts/ledger` | none | none | room: string |  |
| GET | `/captions/status` | none | none |  |  |
| GET | `/channels/:owner/requests` | none | none |  |  |
| GET | `/channels/:owner/rewards` | none | none |  |  |
| GET | `/channels/:owner/supporters` | none | none |  |  |
| PUT | `/channels/rewards` | requireAuth, checkBan | 20 / 1 minute |  | rewards*: any[] |
| DELETE | `/clips/:id` | requireAuth | 30 / 1 minute |  |  |
| POST | `/clips/:id/vertical` | requireAuth | 6 / 1 minute |  |  |
| GET | `/clips/mine` | requireAuth | 60 / 1 minute |  |  |
| GET | `/dock-key` | requireAuth, checkBan | 30 / 5 minutes |  |  |
| POST | `/dock-key/reset` | requireAuth, checkBan | 10 / 5 minutes |  |  |
| GET | `/dock/clips` | requireAuth | 30 / 1 minute |  |  |
| POST | `/dock/session` | none | 20 / 1 minute |  | key*: string |
| GET | `/dvr/clips/:file` | none | none |  |  |
| GET | `/events` | none | none | status: scheduled\|live\|ended\|cancelled, host: string, limit: integer |  |
| POST | `/events` | requireAuth | none |  | title*: string, description: string, scheduledAt*: string, coverImage: string, tags: string[], visibility: public\|unlisted |
| DELETE | `/events/:id` | requireAuth | none |  |  |
| GET | `/events/:id` | none | none |  |  |
| PATCH | `/events/:id` | requireAuth | none |  | title: string, description: string, scheduledAt: string, coverImage: string, tags: string[], visibility: public\|unlisted |
| DELETE | `/events/:id/attend` | requireAuth | none |  |  |
| POST | `/events/:id/attend` | requireAuth | none |  |  |
| POST | `/events/:id/start` | requireAuth | none |  |  |
| GET | `/game-collections` | none | none |  |  |
| GET | `/games` | none | none |  |  |
| GET | `/health` | none | none |  |  |
| GET | `/overlay/:key` | none | 120 / 1 minute |  |  |
| GET | `/podcast/files/:token/:file` | none | 60 / 1 minute |  |  |
| GET | `/podcast/recordings` | requireAuth | none |  |  |
| GET | `/points` | requireAuth | 30 / 1 minute |  |  |
| GET | `/points/:channel` | requireAuth | 30 / 1 minute |  |  |
| GET | `/points/audio-grants` | requireAuth | none |  |  |
| POST | `/points/awards` | none | 30 / 1 minute |  | awards*: object[] |
| GET | `/points/awards/config` | none | none |  |  |
| PUT | `/points/cosmetics` | requireAuth, checkBan | 30 / 1 minute |  |  |
| POST | `/points/daily` | requireAuth | 10 / 1 minute |  |  |
| GET | `/points/events` | none | none |  |  |
| POST | `/points/promote` | requireAuth, checkBan | 10 / 1 minute |  | author*: string, permlink*: string, days*: integer, burnTx: string |
| GET | `/points/promote/quote` | none | none |  |  |
| POST | `/points/pwa` | requireAuth | 5 / 1 minute |  |  |
| GET | `/points/quests` | none | 60 / 1 minute | user*: string |  |
| GET | `/points/requests` | requireAuth | none |  |  |
| POST | `/points/requests/:id/:action` | requireAuth, checkBan | 30 / 1 minute |  | permlink: string |
| GET | `/points/shop` | none | none |  |  |
| POST | `/points/shop/buy` | requireAuth, checkBan | 20 / 1 minute |  | item*: string, burnTx: string |
| GET | `/points/shop/orders` | requireAuth | none |  |  |
| GET | `/points/shop/orders/:id` | requireAuth | none |  |  |
| GET | `/points/spends/:id` | requireAuth | 60 / 1 minute |  |  |
| GET | `/points/spotlight` | none | none |  |  |
| GET | `/points/streak` | requireAuth | none |  |  |
| GET | `/points/stream-extra` | requireAuth | none |  |  |
| GET | `/points/supporters` | none | none |  |  |
| POST | `/points/transfer` | requireAuth, checkBan | 10 / 1 minute |  | to*: string, amount*: integer, post: string, burnTx: string |
| GET | `/premium` | none | none |  |  |
| GET | `/premium/:username` | none | none |  |  |
| POST | `/premium/start-testing` | requireAuth, checkBan | 5 / 1 minute |  |  |
| GET | `/presence/:username` | none | none |  |  |
| POST | `/presence/bulk` | none | 20 / 1 minute |  | usernames*: string[] |
| GET | `/raids/settings` | requireAuth | 30 / 1 minute |  |  |
| PUT | `/raids/settings` | requireAuth, checkBan | 20 / 1 minute |  | acceptRaids*: boolean |
| GET | `/rooms` | none | none |  |  |
| POST | `/rooms` | requireAuth, checkBan | 12 / 5 minutes |  | title*: string, description: string, backgroundImage: string, visibility: public\|hive-internal\|unlisted, language: string, mode: conference\|standalone, tags: string[], boost: object |
| DELETE | `/rooms/:name` | requireAuth, checkBan | none |  |  |
| GET | `/rooms/:name` | none | none |  |  |
| PATCH | `/rooms/:name/boost` | requireAuth | none |  | enabled: boolean, minBoostUsd: number, creatorPayoutAccount: string, goal: object\|null, tiers: boolean, alerts: object, presets: number[] |
| GET | `/rooms/:name/boost/summary` | none | none |  |  |
| POST | `/rooms/:name/boosts/points` | requireAuth, checkBan | 10 / 1 minute |  | amount*: integer, message*: string, displayName: string, recipient: string, burnTx: string |
| GET | `/rooms/:name/bounties` | none | none |  |  |
| POST | `/rooms/:name/bounties/:id/:action` | requireAuth | 30 / 1 minute |  |  |
| PATCH | `/rooms/:name/broadcast` | requireAuth | none |  | broadcasting*: boolean |
| POST | `/rooms/:name/captions/start` | requireAuth, checkBan | 12 / 1 minute |  | lang: string |
| POST | `/rooms/:name/captions/stop` | requireAuth, checkBan | 12 / 1 minute |  |  |
| GET | `/rooms/:name/chat` | none | 60 / 1 minute | limit: integer |  |
| POST | `/rooms/:name/chat` | none | 30 / 20 seconds |  | text*: string, timestamp: number, identity: string, name: string, livekitToken: string |
| DELETE | `/rooms/:name/chat/:id` | none | 60 / 1 minute |  |  |
| POST | `/rooms/:name/dvr/clip` | none | 6 / 1 minute |  |  |
| GET | `/rooms/:name/dvr/hls/:token/:file` | none | 600 / 1 minute |  |  |
| GET | `/rooms/:name/dvr/rewind` | none | 30 / 1 minute |  |  |
| POST | `/rooms/:name/dvr/start` | requireAuth, checkBan | none |  |  |
| GET | `/rooms/:name/dvr/status` | none | none |  |  |
| POST | `/rooms/:name/dvr/stop` | requireAuth, checkBan | none |  |  |
| DELETE | `/rooms/:name/game` | requireAuth, checkBan | none |  |  |
| GET | `/rooms/:name/game` | requireAuth, checkBan | none |  |  |
| POST | `/rooms/:name/game/action` | requireAuth, checkBan | none |  | action* |
| POST | `/rooms/:name/game/start` | requireAuth, checkBan | none |  | gameId*: string, config |
| GET | `/rooms/:name/highlights` | requireAuth | 60 / 1 minute |  |  |
| GET | `/rooms/:name/hls/:file` | none | none |  |  |
| POST | `/rooms/:name/host` | requireAuth, checkBan | none |  | newHost*: string |
| DELETE | `/rooms/:name/ingress` | requireAuth | none |  |  |
| POST | `/rooms/:name/ingress` | requireAuth | none |  | transcode: boolean, source: obs\|phone |
| POST | `/rooms/:name/join` | requireAuth, checkBan | none |  | delivery: webrtc\|hls, hlsCapable: boolean |
| PATCH | `/rooms/:name/layout` | requireAuth, checkBan | none |  | layout: speaker\|grid\|single, focusedIdentity: string\|null, suppressScreenAutoFocus: boolean, chatOpen: boolean |
| POST | `/rooms/:name/listen` | none | 60 / 5 minutes |  | displayName: string, silent: boolean, delivery: webrtc\|hls, hlsCapable: boolean |
| PATCH | `/rooms/:name/live` | requireAuth | none |  | willPublishVod: boolean, portrait: boolean |
| PATCH | `/rooms/:name/mods/:username` | requireAuth, checkBan | none |  | isMod*: boolean |
| DELETE | `/rooms/:name/participants/:identity` | requireAuth, checkBan | none |  |  |
| POST | `/rooms/:name/participants/:identity/ban` | requireAuth, checkBan | none |  |  |
| PATCH | `/rooms/:name/participants/:identity/permissions` | requireAuth, checkBan | none |  | canPublish*: boolean |
| POST | `/rooms/:name/podcast/marker` | requireAuth | 30 / 1 minute |  | title*: string |
| POST | `/rooms/:name/podcast/start` | requireAuth, checkBan | 10 / 1 minute |  |  |
| GET | `/rooms/:name/podcast/status` | requireAuth | none |  |  |
| POST | `/rooms/:name/podcast/stop` | requireAuth | 10 / 1 minute |  |  |
| GET | `/rooms/:name/poll-suggestions` | none | none |  |  |
| POST | `/rooms/:name/poll-suggestions/:id/:action` | requireAuth | 30 / 1 minute |  | durationSec: integer |
| GET | `/rooms/:name/polls` | none | 30 / 1 minute |  |  |
| POST | `/rooms/:name/polls` | requireAuth, checkBan | 20 / 5 minutes |  | kind: poll\|prediction, question*: string, options*: string[], durationSec*: integer |
| POST | `/rooms/:name/polls/:id/cancel` | requireAuth, checkBan | 30 / 1 minute |  |  |
| POST | `/rooms/:name/polls/:id/end` | requireAuth, checkBan | 30 / 1 minute |  |  |
| POST | `/rooms/:name/polls/:id/resolve` | requireAuth, checkBan | 30 / 1 minute |  | winner*: integer |
| POST | `/rooms/:name/polls/:id/stake` | requireAuth, checkBan | 20 / 1 minute |  | option*: integer, amount*: integer, burnTx: string |
| POST | `/rooms/:name/polls/:id/vote` | requireAuth, checkBan | 20 / 1 minute |  | option*: integer |
| GET | `/rooms/:name/polls/active` | none | 60 / 1 minute |  |  |
| PATCH | `/rooms/:name/post` | requireAuth | none |  | title: string, thumbnail: string, description: string, tags: string[] |
| DELETE | `/rooms/:name/raid` | requireAuth | 20 / 1 minute |  |  |
| GET | `/rooms/:name/raid` | none | 60 / 1 minute |  |  |
| POST | `/rooms/:name/raid` | requireAuth, checkBan | 20 / 10 minutes |  | target*: string |
| GET | `/rooms/:name/raid/targets` | requireAuth | 20 / 1 minute |  |  |
| POST | `/rooms/:name/recap` | requireAuth | 3 / 1 minute |  | ids*: string[], vertical: boolean |
| PATCH | `/rooms/:name/record/:audioPerm/metadata` | requireAuth, checkBan | none |  | title: string, description: string, tags: string[], post_permlink: string |
| GET | `/rooms/:name/record/file/:token` | none | none |  |  |
| PATCH | `/rooms/:name/record/layout` | requireAuth, checkBan | none |  | layout*: speaker\|grid\|single |
| GET | `/rooms/:name/record/publish-status` | none | none |  |  |
| POST | `/rooms/:name/record/start` | requireAuth, checkBan | none |  | mode: audio\|video, layout: speaker\|grid\|single, publish: boolean, download: boolean |
| GET | `/rooms/:name/record/status` | requireAuth, checkBan | none |  |  |
| POST | `/rooms/:name/record/stop` | requireAuth, checkBan | none |  |  |
| POST | `/rooms/:name/record/upload` | requireAuth, checkBan | none |  | filePath*: string, duration: number, title: string, tags: string[] |
| POST | `/rooms/:name/rewards/:id/:action` | requireAuth | 60 / 1 minute |  |  |
| GET | `/rooms/:name/rewards/queue` | requireAuth | none |  |  |
| POST | `/rooms/:name/stream/start` | requireAuth, checkBan | none |  | platform*: youtube\|twitch\|custom, streamKey*: string, backgroundImageUrl: string, videoEnabled: boolean |
| GET | `/rooms/:name/stream/status` | requireAuth, checkBan | none |  |  |
| POST | `/rooms/:name/stream/stop` | requireAuth, checkBan | none |  |  |
| PATCH | `/rooms/:name/vertical` | requireAuth | 40 / 1 minute |  | on: boolean, x: number, w: number, follow: string, track: boolean |
| GET | `/stream-secret` | requireAuth, checkBan | 30 / 5 minutes |  |  |
| POST | `/stream-secret/reset` | requireAuth, checkBan | 10 / 5 minutes |  |  |
| GET | `/streams` | none | none |  |  |
| GET | `/studio/overlays` | requireAuth | none |  |  |
| PUT | `/studio/overlays` | requireAuth, checkBan | 30 / 5 minutes |  | templates*: any[] |
| GET | `/templates` | requireAuth, checkBan | none |  |  |
| POST | `/templates` | requireAuth, checkBan | 30 / 5 minutes |  |  |
| DELETE | `/templates/:id` | requireAuth, checkBan | none |  |  |
| PATCH | `/templates/:id` | requireAuth, checkBan | 60 / 5 minutes |  |  |
| GET | `/templates/:id/status` | requireAuth, checkBan | none |  |  |
| GET | `/users/:account/cosmetics` | none | none |  |  |
| GET | `/users/:account/points` | none | 60 / 1 minute |  |  |
| GET | `/users/:account/points/history` | none | 60 / 1 minute | before: integer, limit: integer |  |
| POST | `/whip/:owner/:slug` | none | 10 / 1 minute |  |  |
| DELETE | `/whip/s/:token` | none | 30 / 1 minute |  |  |
| PATCH | `/whip/s/:token` | none | 120 / 1 minute |  |  |
<!-- routes:end -->
