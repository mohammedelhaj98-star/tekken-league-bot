# Tekken Ramadan League Bot (Beginner Template)

This is a starter Discord bot (discord.js) that supports:
- Player registration with required fields: **Real Name, Tekken Tag, Email, Phone**
- Stores Discord identity automatically
- Daily **/checkin** tracking (for your 15/20 rule)
- Admin **/admin_generate_fixtures** to create a double round robin (2 legs) fixture list
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

Admins (requires Administrator permission in the server):
- /admin_set_roles
- /admin_list_roles
- /admin_clear_roles
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
