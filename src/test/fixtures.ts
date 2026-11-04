// What the tests share
import type { Course } from "../games/golf/types";

/** A hole, flat from the tee to the cup, as the canister would describe it */
export function course(level = 10, day = 20_761): Course {
    return {
        day,
        par: 4,
        level,
        wind: 0,
        cup: { x: 40, y: 0.5, half_w: 0.3, depth: 0.45 },
        tee: { x: 3, y: 0.2 },
        ball_radius: 0.15,
        ground: [
            [-2, 0],
            [62, 0],
        ],
        boxes: [],
    };
}
