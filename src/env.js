// The loop that runs *inside* the sandbox: one JSON line in, one JSON line out.
//
// This module is deliberately dependency-free and self-contained. The SDK
// vendors it into the tar it uploads (see pack.js), so it has to run on a box
// that has nothing but a Node binary — no npm, no install step.
//
//     import { serve } from 'boltzlabs';
//
//     serve({
//       reset: (seed) => ({ t: 0 }),
//       step:  (action) => [obs, reward, done, info]
//     });
//
// `serve` exists to own the three things that silently break the channel:
//
//   1. **Buffering.** Without a synchronous write the runtime holds the reply in
//      its stdout buffer and a 0.2 ms step becomes seconds, or a whole episode
//      of them.
//   2. **Stray output.** The protocol *is* stdout. A single `console.log('debug')`
//      desynchronises it and every subsequent reply is read as an answer to the
//      previous message. `serve` takes a private duplicate of fd 1 and points
//      `console.log` at stderr, so ordinary logging keeps working and lands in
//      the environment's log instead of on the wire.
//   3. **Exceptions.** A throw out of user code would kill the environment; the
//      worker would report it as a straggler and the pool would quietly shrink.
//      Instead the step is answered with `done: true` and the error in `info`, so
//      a broken environment is visible in the training loop's own data.

import fs from 'node:fs';
import readline from 'node:readline';

export class ProtocolError extends Error {}

// ---------------------------------------------------------------------------
// the channel
// ---------------------------------------------------------------------------

/**
 * Take stdout away from the program and hand back a private handle to it.
 *
 * `/dev/fd/1` opens a *new* descriptor onto the same file description as fd 1,
 * so the returned handle keeps writing to the real pipe no matter what happens
 * to the public one afterwards. That handle is the protocol channel.
 *
 * Everything else in the process is then pointed at stderr —
 * `process.stdout.write` included, which is what `console.log` and every logging
 * library ultimately calls. Node exposes no `dup2`, so a native addon writing
 * straight to fd 1 could still corrupt the channel; that is a real limit and it
 * is written down here rather than papered over. In practice a JS environment
 * has no such writer, and the JS-level swap covers the case that actually
 * happens: someone debugging with `console.log`.
 */
function takeChannel() {
	let channelFd = null;
	try {
		channelFd = fs.openSync('/dev/fd/1', 'w');
	} catch {
		// No /dev/fd (a test harness, an unusual platform). Fall back to writing
		// on process.stdout before it is redirected below.
		channelFd = null;
	}

	const toStderr = (chunk, encoding, callback) => {
		const done = typeof encoding === 'function' ? encoding : callback;
		const enc = typeof encoding === 'function' ? undefined : encoding;
		const ok = process.stderr.write(chunk, enc);
		if (typeof done === 'function') done();
		return ok;
	};

	if (channelFd !== null) {
		// Only safe once the private handle exists — otherwise the protocol would
		// have nowhere left to go.
		process.stdout.write = toStderr;
	}
	console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
	console.info = console.log;
	console.debug = console.log;

	return channelFd;
}

// ---------------------------------------------------------------------------
// reply shaping
// ---------------------------------------------------------------------------

/**
 * Last-resort coercion for values `JSON.stringify` does not handle well.
 *
 * Written against duck types rather than imports: typed arrays are the common
 * case, and the same check covers anything array-shaped a user might return.
 */
function jsonable(_key, value) {
	if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value);
	if (value instanceof Set) return Array.from(value);
	if (value instanceof Map) return Object.fromEntries(value);
	if (typeof value === 'bigint') return Number(value);
	return value;
}

/**
 * Unwrap what a reset returned.
 *
 * Gymnasium-style environments return `[obs, info]`; plenty of hand-written ones
 * return the observation alone. Both are accepted. The pool's reset carries no
 * info field, so an info object here is dropped — if your observation is
 * genuinely a pair whose second element is an object, wrap it so it is not
 * mistaken for the Gymnasium shape.
 */
function resetObs(ret) {
	if (Array.isArray(ret) && ret.length === 2 && ret[1] !== null && typeof ret[1] === 'object' && !Array.isArray(ret[1])) {
		return ret[0];
	}
	return ret;
}

/**
 * Normalise every step return shape onto the wire object.
 *
 * Accepted, in the order they are tried:
 *
 *   * object with `obs`/`reward`/`done`/`info` — passed through
 *   * `[obs, reward, terminated, truncated, info]` — the Gymnasium 5-tuple
 *   * `[obs, reward, done, info]` — the classic 4-tuple
 *   * `[obs, reward, done]` / `[obs, reward]`
 *
 * The 5-tuple collapses to a single `done` because the pool's wire format has
 * one flag, but `terminated` and `truncated` are both preserved in `info` — a
 * trainer that bootstraps value estimates needs to tell the two apart, and
 * losing that distinction here would be a silent correctness bug in the training
 * loop rather than a visible one.
 */
function stepReply(ret) {
	if (ret !== null && typeof ret === 'object' && !Array.isArray(ret) && ('obs' in ret || 'observation' in ret)) {
		const out = { ...ret };
		if ('observation' in out) {
			out.obs = out.observation;
			delete out.observation;
		}
		out.reward = Number(out.reward ?? 0);
		out.done = Boolean(out.done ?? false);
		return out;
	}

	if (!Array.isArray(ret)) {
		throw new ProtocolError(
			`step() must return [obs, reward, done, info] or an object with an 'obs' key, got ${typeof ret}`
		);
	}

	if (ret.length === 5) {
		const [obs, reward, terminated, truncated, info] = ret;
		const merged = info !== null && typeof info === 'object' && !Array.isArray(info) ? { ...info } : { info };
		merged.terminated = Boolean(terminated);
		merged.truncated = Boolean(truncated);
		return { obs, reward: Number(reward), done: Boolean(terminated) || Boolean(truncated), info: merged };
	}
	if (ret.length === 4) {
		const [obs, reward, done, info] = ret;
		return { obs, reward: Number(reward), done: Boolean(done), info };
	}
	if (ret.length === 3) {
		const [obs, reward, done] = ret;
		return { obs, reward: Number(reward), done: Boolean(done) };
	}
	if (ret.length === 2) {
		const [obs, reward] = ret;
		return { obs, reward: Number(reward), done: false };
	}
	throw new ProtocolError(`step() returned a ${ret.length}-element array; expected 2 to 5`);
}

/**
 * Answer a message that could not be served, without dying.
 *
 * `done: true` so a training loop ends the episode rather than carrying a
 * poisoned state forward, and the stack goes to stderr where it lands in the
 * environment's log next to the pool id.
 */
function errorReply(what, err) {
	process.stderr.write(`${what}: ${err?.stack ?? err}\n`);
	return {
		obs: null,
		reward: 0.0,
		done: true,
		info: { boltzlabs_error: `${what}: ${err?.name ?? 'Error'}: ${err?.message ?? err}` }
	};
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

/**
 * Run the environment loop until stdin closes.
 *
 * `reset(seed)` returns an observation. `seed` is `null` when the caller did not
 * ask for one; seed it anyway if you want reproducible episodes.
 *
 * `step(action)` returns any of the shapes `stepReply` accepts.
 *
 * Both may be async, and both are awaited one message at a time. There is no
 * concurrency to reason about inside an environment: the pool's parallelism is
 * across environments, not within one.
 *
 * @param {{reset: Function, step: Function, input?: NodeJS.ReadableStream}} handlers
 */
export async function serve({ reset, step, input = process.stdin }) {
	if (typeof reset !== 'function' || typeof step !== 'function') {
		throw new TypeError('serve({reset, step}) — both are required and both must be functions');
	}

	const channelFd = takeChannel();
	let started = false;

	const emit = (obj) => {
		// No spaces in the separators. At a thousand environments the batch is the
		// payload, and the spaces are a measurable fraction of it.
		const line = JSON.stringify(obj, jsonable) + '\n';
		if (channelFd !== null) {
			fs.writeSync(channelFd, line);
		} else {
			process.stdout.write(line);
		}
	};

	const rl = readline.createInterface({ input, crlfDelay: Infinity });

	for await (const raw of rl) {
		const line = raw.trim();
		if (!line) continue;

		let msg;
		try {
			msg = JSON.parse(line);
			if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
				throw new ProtocolError('message was not a JSON object');
			}
		} catch (err) {
			// Never let a bad line kill the env.
			emit(errorReply('bad message', err));
			continue;
		}

		const op = msg.op;

		if (op === 'reset') {
			try {
				const obs = resetObs(await reset(msg.seed ?? null));
				started = true;
				emit({ obs });
			} catch (err) {
				emit(errorReply('reset() threw', err));
			}
		} else if (op === 'step') {
			try {
				// The worker always resets at spawn, so this can only be reached if
				// a caller drove the protocol by hand. Reset rather than hand the
				// user's step() an uninitialised environment.
				if (!started) {
					await reset(null);
					started = true;
				}
				emit(stepReply(await step(msg.action)));
			} catch (err) {
				emit(errorReply('step() threw', err));
			}
		} else {
			// Unknown op: answer, do not crash. A protocol that grew a message this
			// environment predates should degrade to one bad step, not to a dead
			// environment for the rest of the run.
			emit({ obs: null, reward: 0.0, done: false, info: { boltzlabs_error: `unknown op ${JSON.stringify(op)}` } });
		}
	}
}

export default { serve, ProtocolError };
