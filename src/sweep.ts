// Ends games whose clock has run out, whether or not anyone's still playing, and gets every game
// what it's waiting for from onicai's canister: a lobby its hole, a started race its rounds.
import type { GolfService } from "./games/golf/service";
import type { Publisher } from "./publisher";
import type { GameStore } from "./store";

export const SWEEP_EVERY_MS = 1000;

/** Ends every game that's out of time and publishes its end. Returns how many ended. */
export function sweep(store: GameStore, publisher: Publisher, golf: GolfService): number {
    let ended = 0;
    for (const { game, play } of store.entries()) {
        if (play.endIfTimeUp()) {
            ended++;
            publisher.publish(game);
        }
    }
    if (ended > 0) store.save();
    golf.tick();
    return ended;
}
