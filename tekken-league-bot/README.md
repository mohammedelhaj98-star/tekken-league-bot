# Tekken Ramadan League Bot (Beginner Template)

This is a starter Discord bot (discord.js) that supports:
- Player registration with required fields: **Real Name, Tekken Tag, Email, Phone**
- Stores Discord identity automatically
- Daily **/checkin** tracking (for your 15/20 rule)
- Admin **/admin_generate_fixtures** to create missing double round robin fixtures (2 legs) without duplicating history
- **/ready** queue matchmaking (simultaneous play)
- Match acceptance handshake
- BO5 result reporting + opponent confirmation
- Standings using your points system

## Requirements
- Node.js **22.12+**

## Quick start
1) Copy `.env.example` to `.env` and fill the values (token, app/guild IDs, match channel, encryption key).
2) Install dependencies:

```bash
npm install
```

3) Deploy slash commands to your server (guild):

```bash
npm run deploy
```

4) Run the bot:

```bash
npm start
```

## Commands
Players:
- /signup
- /mydata
- /checkin
- /ready
- /unready
- /standings
- /table
- /queue
- /left (sent via DM)
- /matches
- /help
- /helpplayer
- /playerhelp
- /adminhelp

Admins (requires Administrator permission in the server):
- /bot_settings
- /admin_status
- /admin_player_matches
- /admin_player_left
- /bot_settings set_activity_channel
- /admin_tournament_settings
- /admin_setup_tournament
- /admin_generate_fixtures
- /admin_reset (levels: checkins | league | everything, returns confirmation token)
- /admin_reset_confirm (confirm a pending reset using token)
- /admin_reset_league (legacy alias for league-level reset)
 - /admin_force_result
 - /admin_void_match
 - /admin_dispute_match
 - /points
 - /admin_vs


## Testing
Run a fast syntax validation (recommended before deploy/restart):

```bash
npm run check:syntax
```

Run unit tests with:

```bash
npm test
```

## Tournament setup
Use `/admin_setup_tournament` to configure the league before generating fixtures. You can set:
- max players
- number of timeslots
- duration of each timeslot
- start times of each timeslot (comma-separated HH:MM, 24h)
- clear previously configured timeslot starts (`clear_timeslot_starts:true`)
- total tournament days
- minimum show-up %
- tournament start date (`YYYY-MM-DD`)

Use `/admin_tournament_settings` any time to review the current configuration.

## Public-by-default behavior
Player-facing commands respond in-channel by default (no DMs).
Match assignments and result workflows are posted publicly in the configured results channel (set via `/bot_settings set_results_channel`).
Dispute notifications can be routed to a dedicated channel via `/bot_settings set_dispute_channel`.
Signup/check-in/ready activity notifications can be routed via `/bot_settings set_activity_channel`.


## Fixture history and notifications
- You can run `/admin_generate_fixtures` repeatedly; it only adds missing pair/leg fixtures and keeps full history.
- Confirmed matches are immutable for players and only changeable by admins via admin commands.
- Admin override now uses ❗ as an explicit gate: admin reacts ❗ first, then submits 🇦/🇧 winner and score emoji to force the final result. This supports non-3-0 scores and keeps normal player-report flow intact.
- When a match is created, it is posted publicly in the results channel and each player also receives a DM reminder with the fixture details.
- After a confirmed match, both players can react 🔁 to immediately start their second-leg rematch if available (no re-queue needed).
- `/admin_vs` lets admins set a specific match regardless of queue, but only when an eligible unplayed fixture exists between those two players.

## Points and show% behavior
- `/points` lets admins set points values for: win, loss, no-show/forfeit win, and extra 3-0 sweep bonus.
- SHOW% in table/settings is attendance-based: starts at 100% and drops as missed days increase across the configured tournament days.
- Players have an allowance of up to 5 missed check-ins; players who finish all required fixtures early are exempt from further check-ins.
- Attendance/show% now uses tournament start date through today (elapsed days), not full season length from day one.
- The table now includes a legend describing each header before the table output.
- The table now includes `GP` (games played).
- `ALLOW` now shows a plain number of missed-checkin days left (e.g. `5`), and `EXEMPT (5)` for finished players.
- `/table` supports explicit paging via `/table page:<number>` (for example: `/table page:2`).
- Match messages are pre-seeded with winner, score, and override reactions so users/admins can click immediately.


## Automatic queue matching
- Players can `/ready` at different times; the bot keeps them in queue and matches automatically when compatible opponents are available.
- Matchmaking also runs periodically in the background (`MATCHMAKER_INTERVAL_MS`, default 30000ms), so you do not need to manually generate or post match lists each time.
- Missing fixtures are auto-generated during matchmaking without duplicating historical pair/leg records.


Each reset requires token confirmation: run `/admin_reset` first, then `/admin_reset_confirm token:<TOKEN>` within 5 minutes (same requesting admin).
