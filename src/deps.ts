// What the request handlers share
import type {
    BotClientFactory,
    MiniAppServiceClient,
    MiniAppTokens,
} from "@open-ic/openchat-botclient-ts";
import type { GolfService } from "./games/golf/service";
import type { GameConfig } from "./games/registry";
import type { Names } from "./names";
import type { Publisher } from "./publisher";
import type { GameStore } from "./store";

export type Deps = {
    factory: BotClientFactory;
    store: GameStore;
    publisher: Publisher;
    names: Names;
    /** Chain Golf's calls to onicai's canister */
    golf: GolfService;
    /** The MiniApp service client, once a LocalUserIndex to get the bot's token from is known */
    miniApps: () => MiniAppServiceClient | undefined;
    /** Remembers a command's LocalUserIndex, so the service client can be made */
    useApiGateway: (gateway: string) => MiniAppServiceClient;
    /** The verifier of the service's tokens, made on first use: it needs the bot's id */
    tokens: () => Promise<MiniAppTokens>;
    /** What a new game's made with, eg. a short race for a test */
    gameConfig: GameConfig;
};
