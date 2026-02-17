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
- /help
- /helpplayer
- /playerhelp

Admins (requires Administrator permission in the server):
- /bot_settings
- /admin_status
- /admin_tournament_settings
- /admin_setup_tournament
- /admin_generate_fixtures
- /admin_reset_league (dangerous)
 - /admin_force_result
 - /admin_void_match


## Testing
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
- total tournament days
- minimum show-up %

Use `/admin_tournament_settings` any time to review the current configuration.

## Public-by-default behavior
Player-facing commands respond in-channel by default (no DMs).
Match assignments and result workflows are posted publicly in the configured results channel (set via `/bot_settings set_results_channel`).


## Fixture history and notifications
- You can run `/admin_generate_fixtures` repeatedly; it only adds missing pair/leg fixtures and keeps full history.
- Confirmed matches are immutable for players and only changeable by admins via admin commands.
- When a match is created, it is posted publicly in the results channel and each player also receives a DM reminder with the fixture details.


## Automatic queue matching
- Players can `/ready` at different times; the bot keeps them in queue and matches automatically when compatible opponents are available.
- Matchmaking also runs periodically in the background (`MATCHMAKER_INTERVAL_MS`, default 30000ms), so you do not need to manually generate or post match lists each time.
- Missing fixtures are auto-generated during matchmaking without duplicating historical pair/leg records.
