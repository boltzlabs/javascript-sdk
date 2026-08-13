// A counting environment: the smallest thing that exercises the protocol.
//
//     node ../train_loop.js --env-dir ./examples/counting_env -n 64
import { serve } from 'boltzlabs';

let t = 0;

serve({
	reset: (seed) => {
		t = 0;
		return { t, seed };
	},
	// Reward for matching the step number, so a trainer has something to learn.
	step: (action) => {
		t += 1;
		return [{ t }, action === t % 4 ? 1 : 0, t >= 20, { t }];
	}
});
