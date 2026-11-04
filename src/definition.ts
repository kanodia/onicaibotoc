// The bot's definition, which OpenChat fetches from `/bot_definition` when the bot is registered,
// and shows when it's installed. One command posts a game's card; which game is a dropdown, so
// adding a game adds a choice rather than a command. A game's settings aren't parameters: they
// differ by game, and OpenChat's form for a command shows every parameter whichever game is
// chosen, so the host sets them in the lobby. The definition also lists the apps the bot hosts,
// one per game, with their images: OpenChat refuses a card whose app isn't listed.
import { Permissions } from "@open-ic/openchat-botclient-ts";
import { GAMES } from "./games/registry";

export const definition = {
    description:
        "Play onicai's on-chain games with the people in your chat. `/play` posts a game card: " +
        "join from the card, and the game opens in OpenChat. In a Chain Golf race, up to 20 " +
        "players take on today's hole, each with their own round inside an Internet Computer " +
        "canister, which simulates every shot with Box2D, so nobody can fake a score. The fewest " +
        "strokes wins. The host picks the level and the time limit in the lobby.",
    commands: [
        {
            name: "play",
            description: "Post one of onicai's games for people in this chat to join",
            placeholder: "Setting up the game ...",
            params: [
                {
                    name: "game",
                    description: "Which game to play",
                    placeholder: "Choose a game",
                    required: true,
                    param_type: {
                        StringParam: {
                            min_length: 1,
                            max_length: 20,
                            choices: GAMES.map((game) => ({ name: game.title, value: game.id })),
                            multi_line: false,
                        },
                    },
                },
            ],
            // As bitflags, which is how OpenChat reads a definition's permissions
            permissions: Permissions.encodePermissions({
                community: [],
                chat: [],
                message: ["MiniApp"],
            }),
            default_role: "Participant",
        },
    ],
    // A card can't be posted in a direct chat
    restricted_locations: ["Community", "Group"],
    // Each game's app, which its card names, with the image shown when there's no app to show
    mini_apps: GAMES.map((game) => ({ name: game.id, image_url: game.image })),
};
