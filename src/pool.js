// A pool of RL environments, driven one batch at a time.
//
//     const pool = await RLPool.create({environment: 'cartpole', n: 1000});
//     let obs = await pool.reset();
//     const {rewards, dones} = await pool.step(actions);   // one request, 1000 envs
//     await pool.close();
//
// The shape that matters: `step` is one HTTP request carrying N actions and
// returning N results. A loop that stepped environments one at a time would pay
// a round trip per environment per step, and at a thousand environments that is
// the whole cost of training.
//
// `RLPool.create` is a static rather than a constructor because a pool does not
// exist until the platform has booted N sandboxes and given it an id, and a
// constructor cannot await that.

import * as config from './config.js';
import { BoltzLabsError } from './errors.js';
import { Session } from './http.js';
import { packEnvDir } from './pack.js';

const CP_PREFIX = '/api/rl/pools';
const WORKER_PREFIX = '/worker/rl/pools';

/**
 * Where a step's wall time went.
 *
 * `overheadMs` is the number to watch: it is what the platform cost you on top
 * of the environments' own work, and it is the difference between a pool that
 * scales and one that does not.
 */
export class Timing {
	constructor({ roundtripMs = 0, workerMs = 0, envMaxMs = 0, envMeanMs = 0, stragglers = 0 } = {}) {
		Object.assign(this, { roundtripMs, workerMs, envMaxMs, envMeanMs, stragglers });
	}

	/** Everything that was not the slowest environment actually stepping. */
	get overheadMs() {
		return Math.max(0, this.roundtripMs - this.envMaxMs);
	}

	static fromWire(timing, roundtripMs) {
		const t = timing ?? {};
		return new Timing({
			roundtripMs,
			workerMs: Number(t.worker_ms ?? t.workerMs ?? 0),
			envMaxMs: Number(t.env_max_ms ?? t.envMaxMs ?? 0),
			envMeanMs: Number(t.env_mean_ms ?? t.envMeanMs ?? 0),
			stragglers: Number(t.stragglers ?? 0)
		});
	}

	toString() {
		return (
			`${this.roundtripMs.toFixed(1)}ms roundtrip, ${this.envMaxMs.toFixed(1)}ms slowest env, ` +
			`${this.overheadMs.toFixed(1)}ms overhead` +
			(this.stragglers ? `, ${this.stragglers} stragglers` : '')
		);
	}
}

/** Coerce typed arrays and the like into something JSON can carry. */
function jsonable(value) {
	if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value);
	if (value instanceof Set) return Array.from(value);
	return value;
}

export class RLPool {
	// Built by `create`. The constructor only wires up state that needs no I/O,
	// so nothing here can half-exist.
	constructor(fields) {
		Object.assign(this, fields);
	}

	/**
	 * Create a pool and wait for its environments to boot.
	 *
	 * Either your own environment directory, or one the platform ships:
	 *
	 *     RLPool.create({envDir: './my_env', n: 64})
	 *     RLPool.create({environment: 'cartpole', n: 64})
	 */
	static async create({
		envDir = null,
		n = null,
		environment = null,
		url = null,
		apiKey = null,
		direct = null,
		name = null,
		runtime = 'python3',
		entrypoint = null,
		memoryMb = null,
		stepTimeoutMs = null,
		measureCpu = null,
		serializeMeasurement = false,
		vendorSdk = true,
		timeout = 60,
		createTimeout = 900
	} = {}) {
		// A pool runs either an environment the platform ships or one you wrote.
		// Refused rather than resolved by precedence: the two readings of "whose
		// code ran" are equally plausible, and the wrong one is a training run
		// against an environment nobody chose.
		if (Boolean(envDir) === Boolean(environment)) {
			throw new TypeError(
				'pass either envDir (your environment) or environment (a name), ' +
					'not both and not neither — see boltzlabs.rlEnvironments()'
			);
		}
		if (n === null || n === undefined) {
			throw new TypeError('n is required: how many environments to run at once');
		}

		const directUrl = direct ?? config.get('BOLTZLABS_WORKER_URL');
		if (url && directUrl) throw new TypeError('pass url or direct, not both');

		let base, prefix, via, headers;
		if (directUrl) {
			// Straight at a worker, bypassing the control plane. Only reachable
			// from inside the deployment or over a tunnel.
			const token = config.get('BOLTZLABS_WORKER_TOKEN', { fallback: '' });
			base = directUrl;
			prefix = WORKER_PREFIX;
			via = 'worker';
			headers = token ? { Authorization: `Bearer ${token}` } : {};
		} else {
			const resolved = config.resolve({ url, apiKey });
			base = resolved.url;
			prefix = CP_PREFIX;
			via = 'platform';
			headers = { Authorization: `Bearer ${resolved.apiKey}` };
		}

		const session = new Session(base, { headers, timeout });
		const body = { n: Math.trunc(n), serialize_measurement: Boolean(serializeMeasurement) };

		let resolvedRuntime = null;
		let resolvedEntrypoint = null;
		let codeBytes = 0;
		let skippedSymlinks = [];

		if (environment) {
			// A ready-made environment: nothing to pack, and runtime/entrypoint
			// belong to the catalogue entry rather than to this call. Sending them
			// anyway would be a request the platform refuses.
			body.environment = environment;
		} else {
			resolvedRuntime = runtime;
			resolvedEntrypoint = entrypoint ?? (runtime === 'node' ? 'env.js' : 'env.py');

			const packed = await packEnvDir(envDir, {
				entrypoint: resolvedEntrypoint,
				vendor: vendorSdk
			});
			codeBytes = packed.code.length;
			skippedSymlinks = packed.skippedSymlinks;

			body.runtime = resolvedRuntime;
			body.entrypoint = resolvedEntrypoint;
			body.code_tar_gz = packed.code.toString('base64');
		}

		if (name) body.name = name;
		if (memoryMb) body.memory_mb = Math.trunc(memoryMb);
		if (stepTimeoutMs) body.step_timeout_ms = Math.trunc(stepTimeoutMs);
		if (measureCpu) body.measure_cpu = Math.trunc(measureCpu);

		// Booting N interpreters is minutes, not a step. Its own deadline.
		const created = await session.call('POST', prefix, body, { timeout: createTimeout });

		return new RLPool({
			poolId: created?.pool_id ?? created?.id ?? '',
			n: Math.trunc(n),
			environment: environment ?? null,
			runtime: resolvedRuntime,
			entrypoint: resolvedEntrypoint,
			codeBytes,
			skippedSymlinks,
			via,
			_session: session,
			_prefix: prefix,
			_stepTimeout: timeout,
			_obs: new Array(Math.trunc(n)).fill(null),
			_closed: false,
			_steps: 0,
			_timing: null,
			_resetTiming: null,
			_createdAt: Date.now()
		});
	}

	get timing() {
		return this._timing;
	}
	get resetTiming() {
		return this._resetTiming;
	}
	get steps() {
		return this._steps;
	}
	get closed() {
		return this._closed;
	}
	get length() {
		return this.n;
	}

	/**
	 * Reset every environment, or a subset.
	 *
	 * `where` selects environments by index; without it the whole pool resets.
	 * Returns the observations, in pool order.
	 */
	async reset({ seed = null, where = null, hard = false } = {}) {
		this._checkOpen();

		const indices = where === null ? null : this._indices(where);
		if (indices !== null && indices.length === 0) return [...this._obs];

		const body = {};
		if (seed !== null && seed !== undefined) body.seed = Math.trunc(seed);
		if (indices !== null) body.indices = indices;
		if (hard) body.hard = true;

		const started = performance.now();
		const res = await this._session.call('POST', `${this._prefix}/${this.poolId}/reset`, body, {
			timeout: this._resetTimeout(hard)
		});
		const roundtripMs = performance.now() - started;

		const obs = res?.obs ?? [];
		if (indices === null) {
			if (obs.length !== this.n) {
				throw new BoltzLabsError(`reset returned ${obs.length} observations, expected ${this.n}`);
			}
			this._obs = [...obs];
		} else {
			indices.forEach((idx, slot) => {
				this._obs[idx] = obs[slot];
			});
		}

		this._resetTiming = Timing.fromWire(res?.timing, roundtripMs);
		return [...this._obs];
	}

	/**
	 * One action per environment, one request, N results.
	 *
	 * Returns `{obs, rewards, dones, infos, timing}`:
	 *
	 *   * `obs`     — array of length n, arbitrary JSON, exactly what each
	 *                 environment returned
	 *   * `rewards` — `Float32Array(n)`
	 *   * `dones`   — `boolean[]` of length n
	 *   * `infos`   — array of length n, arbitrary JSON
	 *
	 * `rewards` is a typed array because that is what a trainer's next line
	 * wants; obs and info stay as they came, because coercing arbitrary JSON into
	 * an array is a guess about the caller's observation space that this layer
	 * has no business making.
	 *
	 * An environment that missed its deadline on the worker comes back as
	 * `done: true` with zero reward and `info.boltzlabs_straggler`, and is counted
	 * in `pool.timing.stragglers` — a degraded batch is visible in the data
	 * rather than inferred from a stall.
	 */
	async step(actions) {
		this._checkOpen();
		const normalised = this._normaliseActions(actions);

		// The clock starts before serialisation and stops after decoding: it is
		// the wall time the training loop actually pays for a step, not the part
		// of it that happens to be on a socket.
		const started = performance.now();
		const res = await this._session.call(
			'POST',
			`${this._prefix}/${this.poolId}/step`,
			{ actions: normalised },
			{ timeout: this._stepTimeout }
		);
		const roundtripMs = performance.now() - started;

		const obs = res?.obs ?? [];
		if (obs.length !== this.n) {
			throw new BoltzLabsError(`step returned ${obs.length} observations, expected ${this.n}`);
		}

		const rewards = Float32Array.from(res?.rewards ?? []);
		const dones = (res?.dones ?? []).map(Boolean);
		const infos = res?.infos ?? [];

		this._obs = [...obs];
		this._steps += 1;
		this._timing = Timing.fromWire(res?.timing, roundtripMs);

		return { obs, rewards, dones, infos, timing: this._timing };
	}

	/** Live pool status, including the memory number that decides the bill. */
	async status() {
		this._checkOpen();
		return this._session.call('GET', `${this._prefix}/${this.poolId}`);
	}

	/** Destroy the pool. This is what stops the meter. */
	async close() {
		if (this._closed) return;
		this._closed = true;
		try {
			await this._session.call('DELETE', `${this._prefix}/${this.poolId}`, undefined, { timeout: 120 });
		} catch {
			// A pool whose worker already left is already gone; close() is the
			// call people put in a `finally`, and it must not throw there.
		}
	}

	/** Create, run `fn`, and close even if `fn` throws. */
	static async withPool(opts, fn) {
		const pool = await RLPool.create(opts);
		try {
			return await fn(pool);
		} finally {
			await pool.close();
		}
	}

	// -- internals -----------------------------------------------------------

	_checkOpen() {
		if (this._closed) throw new BoltzLabsError(`pool ${this.poolId} is closed`);
	}

	_resetTimeout(hard) {
		// A hard reset respawns the interpreters; that is a create, not a step.
		return hard ? Math.max(this._stepTimeout, 300) : this._stepTimeout;
	}

	_indices(where) {
		const list = Array.from(where, (i) => Math.trunc(i));
		for (const i of list) {
			if (!Number.isInteger(i) || i < 0 || i >= this.n) {
				throw new RangeError(`index ${i} is outside this pool of ${this.n}`);
			}
		}
		return list;
	}

	_normaliseActions(actions) {
		const list = Array.from(actions ?? [], jsonable);
		if (list.length !== this.n) {
			throw new BoltzLabsError(`got ${list.length} actions for ${this.n} environments`);
		}
		return list;
	}
}
