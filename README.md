# Hunt the Code

QR treasure hunt for IEEE ITS. Cloudflare Worker + D1, no build step.

- `/` participant login (team code, name, registration number) → `/consent` → `/play`
- `/admin` organiser dashboard
- `/s/<token>` what each printed QR points at

## How the hunt works

Every team has its own clues at its own locations. One treasure clue is shared: it is the last stop for every team.
A clue's text leads the team to where that clue's QR is stuck; scanning it unlocks the next clue. Scanning another
team's QR, or the treasure QR early, does nothing.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then set your own values
npm run db:local
npm run dev
```

## Deploy

1. In `wrangler.jsonc`, set `database_name` and `database_id` to the IEEE ITS D1 database.
   All tables are prefixed `hunt_` and migrations are tracked in `hunt_migrations`, so nothing else in that database is touched.
2. Create the tables: `npm run db:remote`
3. Set the secrets: `npx wrangler secret put ADMIN_PASSWORD`, `npx wrangler secret put SESSION_SECRET`
   (and optionally `ADMIN_USER`, default `admin`).
4. `npm run deploy`

## On the day

1. **Teams**: generate the teams, print the code slips.
2. **Clues**: add each team's clues, then the one treasure clue.
3. **Routes**: generate (order as entered, or shuffled per team).
4. **QR codes**: print from the deployed site (the codes embed the site address) and stick them up.
5. **Live**: Start hunt. The leaderboard ranks by who scanned the treasure first.
