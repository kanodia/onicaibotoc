import type { Settings } from "./games/settings";

export type Config = {
    port: number;
    openchatPublicKey: string;
    icHost: string;
    identityPrivateKey: string;
    openStorageCanisterId: string;
    /** OpenChat's UserIndex, for looking players' names up; the SDK's default is mainnet's */
    userIndexCanisterId?: string;
    miniAppServiceUrl: string;
    /** A LocalUserIndex to get the bot's MiniApp service token from, before its first command */
    apiGateway?: string;
    /** Where the games are kept between restarts, or undefined to keep them only in memory */
    dataFile?: string;
    /** The built app, served at `/app` */
    appDir: string;
    /** onicai's games canister, through its HTTP API */
    onicaiUrl: string;
    /** What onicai's leaderboard shows for OpenChat's rounds: "anon" if empty */
    onicaiPlayerName: string;
    /** A game's settings unless the host sets them, eg. a short race for a test */
    settings?: Settings;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
    const required = (name: string): string => {
        const value = env[name];
        if (value === undefined || value === "") {
            throw new Error(`${name} must be set`);
        }
        return value;
    };
    const optional = (name: string): string | undefined => {
        const value = env[name];
        return value === undefined || value === "" ? undefined : value;
    };
    return {
        port: Number(optional("PORT") ?? 3200),
        openchatPublicKey: required("OC_PUBLIC"),
        icHost: required("IC_HOST"),
        identityPrivateKey: required("IDENTITY_PRIVATE"),
        openStorageCanisterId: required("STORAGE_INDEX_CANISTER"),
        userIndexCanisterId: optional("USER_INDEX_CANISTER"),
        miniAppServiceUrl: required("MINI_APP_SERVICE_URL").replace(/\/$/, ""),
        apiGateway: optional("OC_API_GATEWAY"),
        dataFile: optional("DATA_FILE") ?? "./data/games.json",
        appDir: optional("APP_DIR") ?? "./dist/app",
        onicaiUrl: (optional("ONICAI_URL") ?? "https://play.onicai.com").replace(/\/$/, ""),
        onicaiPlayerName: optional("ONICAI_PLAYER_NAME") ?? "",
        settings: settingsFromEnv(optional("RACE_SECONDS")),
    };
}

/** A race's time limit from the env, for trying a race out: a short time */
function settingsFromEnv(seconds?: string): Settings | undefined {
    return seconds === undefined ? undefined : { minutes: Number(seconds) / 60 };
}
