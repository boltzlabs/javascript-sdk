// boltzlabs — sandboxes and RL environments, from JavaScript.
//
//     import { Sandbox } from 'boltzlabs';
//
//     const sb = await Sandbox.create();                  // small / base / internet off
//
//     console.log(String(await sb.run('print(sum(range(101)))')));
//     console.log(String(await sb.exec('pip install requests')));
//
//     await sb.delete();                                  // stops the meter
//
//     import { RLPool } from 'boltzlabs';
//
//     const pool = await RLPool.create({environment: 'cartpole', n: 1000});
//     await pool.reset();
//     const {rewards, dones} = await pool.step(actions);   // one request, 1000 envs
//     await pool.close();
//
// The key comes from `BOLTZLABS_API_KEY` in the environment or in a `.env`.
// Nothing else is required.
//
// Everything else is a detail you can look up when you need it: `me()`,
// `sandboxes()`, `sandbox(id)`, `environments()`, `machines()`, `use()` to point
// at another key or origin, and `Client` when you want to hold two.

export {
	APIKey,
	Client,
	Environment,
	ExecResult,
	Language,
	Machine,
	Sandbox,
	defaultClient,
	use
} from './client.js';
export { RLPool, Timing } from './pool.js';
export { serve, ProtocolError } from './env.js';
export { packEnvDir } from './pack.js';
export { DEFAULT_API_URL } from './config.js';
export {
	APIError,
	AuthError,
	BoltzLabsError,
	CapacityError,
	NotFoundError,
	PayloadTooLargeError,
	PoolGoneError,
	QuotaError,
	TransportError
} from './errors.js';

export const VERSION = '0.1.0';

import { defaultClient } from './client.js';

// The listing calls, without making anyone build a Client first. They share one
// lazily-built default client, so importing boltzlabs still needs no key and
// opens no socket.

/** Who your key belongs to. `bzlabs auth status`. */
export function me() {
	return defaultClient().me();
}

/** Your sandboxes. `bzlabs ls`. */
export function sandboxes() {
	return defaultClient().sandboxes();
}

/**
 * One sandbox by id. `bzlabs status <id>`.
 *
 * The counterpart to creating one: `Sandbox.create(...)` creates, this reaches
 * something the platform already assigned an id to.
 */
export function sandbox(id) {
	return defaultClient().sandbox(id);
}

/**
 * Run one piece of code and get back what it printed. `bzlabs run`.
 *
 *     await execute('print(sum(range(101)))', {language: 'python'});
 *     await execute({file: 'train.py', language: 'python'});
 *
 * The language is always named — see `languages()` for the codes.
 */
export function execute(code, opts) {
	return defaultClient().execute(code, opts);
}

/** The language codes execution accepts. `bzlabs languages`. */
export function languages() {
	return defaultClient().languages();
}

/** What a sandbox can ship with. `bzlabs environments`. */
export function environments() {
	return defaultClient().environments();
}

/** Machines and prices. `bzlabs machines`. */
export function machines() {
	return defaultClient().machines();
}

/**
 * The ready-made RL environments a pool can be launched with.
 *
 * Each is the same JSON-lines protocol in the same sandbox as your own code —
 * the only difference is that it was already on the box:
 *
 *     RLPool.create({environment: 'cartpole', n: 64})
 */
export function rlEnvironments() {
	return defaultClient().rlEnvironments();
}

/** Your RL pools. */
export function pools() {
	return defaultClient().pools();
}
