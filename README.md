# OnicaiBot

[onicai](https://play.onicai.com)'s on-chain games, played inside [OpenChat](https://oc.app) chats.

`/play` posts a game card in a group or channel. The command's `game` parameter is a dropdown of
the games. Whoever ran the command is playing from the start, as the host. Others join from the
card, a player starts the game, and it's played in the card, in this bot's page, which OpenChat
opens in a frame. Everyone else in the chat can watch.

The first game is a **Chain Golf race**:

- Up to 20 players play today's Chain Golf hole at the level the host picks in the lobby.
- Each player has their own round inside onicai's canister, which simulates every shot with
  Box2D on 13 nodes, so nobody can fake a score.
- The fewest strokes wins, and holing it first breaks a tie. Only a player who has holed it can
  win.
- The race ends once everyone has holed it or run out of shots, or when the time's up (5 minutes,
  unless the host sets 3, 10 or 15).
- Everyone sees every ball on the same hole, and each shot's flight as it lands.
- The finished card keeps the standings, with a link to each round on play.onicai.com, where
  anyone can have the canister replay it.

## How it works

```
OpenChat website ── WebSocket ── OpenChat's MiniApp service ── HTTPS ── OnicaiBot ── HTTPS ── onicai's canister
       │                                                                     ▲            (play.onicai.com/api)
       └── frame: <bot>/app ── shots, with the player's token ───────────────┘
```

- **OpenChat's MiniApp service** posts the card. It handles joining and starting through OpenChat,
  so the card records exactly who played. It also relays each state the bot publishes to everyone
  with the card on screen. See OpenChat's
  [protocol doc](https://github.com/open-chat-labs/open-chat/blob/master/backend/docs/mini_app_service_protocol.md).
- **The bot keeps each round's key.** When the race starts, the bot starts a round on the canister
  for each player (`POST /api/golf/round`). A player's page sends its shots to the bot, which plays
  them on the canister (`POST /api/golf/round/<id>/shot`) and answers with the ball's flight. A
  player can only shoot through the race, and the bot knows each player's score from the canister
  itself.
- **The lobby shows the hole:** today's hole at the chosen level, from `GET /api/golf/today`.
- **What onicai sees:** the bot never sends onicai OpenChat usernames. Rounds show on onicai's
  leaderboard as `ONICAI_PLAYER_NAME`, or as "anon" if that's unset.

The code is laid out so that another of onicai's games adds an entry to the dropdown:

- `src/games/registry.ts`: the games, each with its card, limits and settings;
- `src/games/golf/`: the race's rules (`race.ts`), its calls to the canister (`service.ts`) and what
  the bot and the page share (`types.ts`);
- `src/onicai.ts`: the client for onicai's HTTP API;
- `src/handlers/`: `/play`, the MiniApp service's calls, and the page's requests;
- `src/app/`: the page in the card, with the hole drawn as onicai's own page draws it
  (`golf/draw.ts`).

The race, store, publisher and page lobby are adapted from OpenChat's MiniGameBot, in
[open-chat-bots](https://github.com/open-chat-labs/open-chat-bots).

## Running it

You need Node 22. Then install, test and build:

```bash
npm install
npm test
npm run build
```

Copy `.env.example` to `.env` and fill it in, then start the bot:

```bash
npm start
```

To set the bot up in OpenChat:

1. Register it in OpenChat with the `/register_bot` command, giving the bot's origin, eg.
   `http://localhost:3200` locally, as its endpoint. The bot serves its definition there.
2. Install it in a group from the group's Bots tab.
3. Run `/play` and pick Chain Golf race.

`vendor/` holds a build of OpenChat's TypeScript bot SDK, `@open-ic/openchat-botclient-ts`
1.0.69, from open-chat-bots `main` at 6f97f59. That's the first commit whose card posts can have
the host playing (`joinInitiator`). npm's latest release is 1.0.65, which predates MiniApps. Once
a newer version is published, depend on that instead.

## Deploying

For now the bot runs on OpenChat's AWS, as the container `oc-onicai-bot` on the EC2 instance
`i-0198f9d466e519454` in us-east-1, beside OpenChat's MiniApp service, bridges and MiniGameBot.
Later it's to run on onicai's own machines.

**Deploys** are done by the *Deploy OnicaiBot* GitHub Actions workflow
([`deploy.yaml`](.github/workflows/deploy.yaml)), run by hand from `main`:

- It tests the bot, builds the image with [`Dockerfile`](Dockerfile) on an arm runner, and pushes it
  to OpenChat's ECR, `oc-onicai-bot`, tagged `latest` and with the commit. It then restarts the bot
  on the host, which pulls `latest` as it starts.
- If the bot doesn't start, or doesn't stay up for 30 seconds, the deploy fails, and systemd keeps
  restarting it. Its logs are in CloudWatch, in `/oc/onicai-bot`.
- It then checks the bot serves its definition at its public URL.
- The config stays as it is in SSM Parameter Store, under `/oc-onicai-bot/`, and so do the games, in
  `/var/lib/oc-onicai-bot` on the host. A restart doesn't end a race.
- On a PR it only tests and builds.

**What this repo can do on the host:** push the bot's image, and restart it. The restart is a fixed
SSM document, [`aws/oc-onicai-bot-restart.yaml`](aws/oc-onicai-bot-restart.yaml), which takes no
parameters, and the deploy role can run nothing else there. The container runs as `node`, with no
capabilities and 256MB of memory, on a network of its own that can't reach the instance's
metadata. So the bot can't reach the instance role's credentials, which would give it the other
services' config.

### Setting it up

Once, before the first deploy, someone with OpenChat's AWS access runs
[`aws/setup.sh`](aws/setup.sh). It makes:

- the ECR repository and the log group;
- the config: a new identity for the bot, plus OpenChat's public key and the MiniApp service's URL,
  copied from MiniGameBot's;
- the host role's policy, [`aws/instance-role-policy.json`](aws/instance-role-policy.json), and
  port 8085 in the host's security group, from CloudFront only;
- a CloudFront distribution in front of the host's 8085, which is the bot's public URL;
- the deploy role, `GitHubActions-DeployOnicaiBot`, which GitHub can assume only from this repo's
  `main` ([trust](aws/deploy-role-trust.json), [permissions](aws/deploy-role-policy.json));
- the restart document, and the host's start script and unit, from [`aws/`](aws).

The deploy can't change the restart document, the start script or the unit. So after changing one
of them, run `aws/setup.sh` again.

Then, after the first deploy, register the bot with `/register_bot`. Its endpoint is the public
URL, and its principal is the one it logs as it starts. After a deploy that changes the
definition, eg. a new game, run `/update_bot`. OpenChat refuses a card whose app isn't in the
definition it holds.

## Open questions for onicai

- **Capacity.** One shared fuel tank pays for every player. There's also a daily compute budget,
  80B instructions with a hard limit of 100B. A golf shot takes about 3–13M instructions, so golf
  is cheap. But busy chats could still use a lot of it, and chess against Stockfish would use far
  more. Should OpenChat's rounds get a quota or a tank of their own?
- **A stable API.** The bot uses the API onicai's own pages use. A versioned API would keep the bot
  working as the site changes.
- **The day's hole.** Rounds can't name the day, so a race that starts before midnight UTC gives
  anyone whose round starts after midnight the next day's hole.
- **Leaderboards.** Should OpenChat's rounds appear on onicai's daily leaderboard and feed, and
  under what name?
