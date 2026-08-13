import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { BoltzLabsError } from '../src/errors.js';
import { RLPool } from '../src/pool.js';
import { stubServer } from './stub.js';

/** A minimal environment directory the packer will accept. */
function envDir(entrypoint = 'env.js') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-env-'));
	fs.writeFileSync(path.join(dir, entrypoint), 'export const x = 1;\n');
	return dir;
}

function poolRoutes(n, extra = {}) {
	return {
		'POST /api/rl/pools': { pool_id: 'rp-1', n },
		'POST /api/rl/pools/rp-1/reset': {
			obs: Array.from({ length: n }, (_, i) => ({ t: 0, i })),
			timing: { worker_ms: 3 }
		},
		'POST /api/rl/pools/rp-1/step': (body) => ({
			obs: body.actions.map((a) => ({ t: 1, a })),
			rewards: body.actions.map(() => 1.5),
			dones: body.actions.map(() => false),
			infos: body.actions.map(() => ({})),
			timing: { worker_ms: 2, env_max_ms: 1, env_mean_ms: 0.5, stragglers: 0 }
		}),
		'GET /api/rl/pools/rp-1': { pool_id: 'rp-1', n, status: 'running' },
		'DELETE /api/rl/pools/rp-1': { __status: 204 },
		...extra
	};
}

// --- named environments ----------------------------------------------------
// A pool runs either an environment the platform ships or one you wrote. Both,
// or neither, is refused before anything is packed or sent: the two readings of
// "whose code ran" are equally plausible, and the wrong one is a training run
// against an environment nobody chose.

test('a pool needs exactly one source of code', async () => {
	await assert.rejects(
		() => RLPool.create({ envDir: './some_env', n: 4, environment: 'cartpole' }),
		/not both and not neither/
	);
	await assert.rejects(() => RLPool.create({ n: 4 }), /not both and not neither/);
});

test('n is required', async () => {
	await assert.rejects(() => RLPool.create({ environment: 'cartpole' }), /n is required/);
});

test('a named environment sends no code, no runtime and no entrypoint', async () => {
	const stub = await stubServer(poolRoutes(4));
	try {
		const pool = await RLPool.create({
			environment: 'cartpole',
			n: 4,
			url: stub.url,
			apiKey: 'k'
		});

		const [create] = stub.seen;
		assert.equal(create.body.environment, 'cartpole');
		assert.equal(create.body.n, 4);
		// Runtime and entrypoint belong to the catalogue entry. Sending them
		// anyway is a request the platform refuses.
		assert.ok(!('runtime' in create.body));
		assert.ok(!('entrypoint' in create.body));
		assert.ok(!('code_tar_gz' in create.body));

		assert.equal(pool.poolId, 'rp-1');
		assert.equal(pool.environment, 'cartpole');
		assert.equal(pool.codeBytes, 0);
		await pool.close();
	} finally {
		await stub.close();
	}
});

test('an env directory is packed and uploaded', async () => {
	const dir = envDir('env.js');
	const stub = await stubServer(poolRoutes(2));
	try {
		const pool = await RLPool.create({
			envDir: dir,
			n: 2,
			runtime: 'node',
			url: stub.url,
			apiKey: 'k'
		});

		const [create] = stub.seen;
		assert.equal(create.body.runtime, 'node');
		assert.equal(create.body.entrypoint, 'env.js');
		assert.ok(create.body.code_tar_gz.length > 0);
		assert.ok(!('environment' in create.body));

		// It is a real gzip stream, not a base64 accident.
		const tar = zlib.gunzipSync(Buffer.from(create.body.code_tar_gz, 'base64'));
		assert.ok(tar.length % 512 === 0);
		assert.ok(pool.codeBytes > 0);
		await pool.close();
	} finally {
		await stub.close();
	}
});

// --- driving the pool ------------------------------------------------------

test('reset and step carry the batch in one request each', async () => {
	const stub = await stubServer(poolRoutes(4));
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 4, url: stub.url, apiKey: 'k' });

		const obs = await pool.reset();
		assert.equal(obs.length, 4);
		assert.equal(obs[2].i, 2);

		const res = await pool.step([0, 1, 2, 3]);
		assert.equal(res.obs.length, 4);
		assert.ok(res.rewards instanceof Float32Array);
		assert.deepEqual(Array.from(res.rewards), [1.5, 1.5, 1.5, 1.5]);
		assert.deepEqual(res.dones, [false, false, false, false]);
		assert.equal(res.infos.length, 4);
		assert.equal(pool.steps, 1);

		// One step is one request — the whole point of a pool.
		const steps = stub.seen.filter((r) => r.path.endsWith('/step'));
		assert.equal(steps.length, 1);
		assert.deepEqual(steps[0].body.actions, [0, 1, 2, 3]);

		await pool.close();
	} finally {
		await stub.close();
	}
});

test('a typed array of actions is accepted', async () => {
	const stub = await stubServer(poolRoutes(3));
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 3, url: stub.url, apiKey: 'k' });
		await pool.step(Int32Array.from([1, 2, 3]));
		const [, step] = stub.seen;
		assert.deepEqual(step.body.actions, [1, 2, 3]);
		await pool.close();
	} finally {
		await stub.close();
	}
});

test('the wrong number of actions is caught before the request', async () => {
	const stub = await stubServer(poolRoutes(4));
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 4, url: stub.url, apiKey: 'k' });
		await assert.rejects(() => pool.step([1, 2]), /got 2 actions for 4 environments/);
		// Nothing was sent.
		assert.equal(stub.seen.filter((r) => r.path.endsWith('/step')).length, 0);
		await pool.close();
	} finally {
		await stub.close();
	}
});

test('timing reports the overhead the platform cost you', async () => {
	const stub = await stubServer(poolRoutes(2));
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 2, url: stub.url, apiKey: 'k' });
		await pool.step([0, 0]);

		assert.ok(pool.timing.roundtripMs > 0);
		assert.equal(pool.timing.envMaxMs, 1);
		// Overhead is everything that was not the slowest environment stepping.
		assert.ok(pool.timing.overheadMs > 0);
		assert.ok(String(pool.timing).includes('overhead'));
		await pool.close();
	} finally {
		await stub.close();
	}
});

test('a partial reset only touches the indices it names', async () => {
	const stub = await stubServer({
		...poolRoutes(4),
		'POST /api/rl/pools/rp-1/reset': (body) =>
			body.indices
				? { obs: body.indices.map((i) => ({ reset: i })) }
				: { obs: Array.from({ length: 4 }, (_, i) => ({ t: 0, i })) }
	});
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 4, url: stub.url, apiKey: 'k' });
		await pool.reset();
		const obs = await pool.reset({ where: [1, 3] });

		assert.deepEqual(obs[1], { reset: 1 });
		assert.deepEqual(obs[3], { reset: 3 });
		// Untouched slots keep the observation they already had.
		assert.deepEqual(obs[0], { t: 0, i: 0 });
		await pool.close();
	} finally {
		await stub.close();
	}
});

test('an out-of-range index is refused', async () => {
	const stub = await stubServer(poolRoutes(4));
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 4, url: stub.url, apiKey: 'k' });
		await assert.rejects(() => pool.reset({ where: [9] }), RangeError);
		await pool.close();
	} finally {
		await stub.close();
	}
});

test('close is idempotent and a closed pool refuses work', async () => {
	const stub = await stubServer(poolRoutes(2));
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 2, url: stub.url, apiKey: 'k' });
		await pool.close();
		await pool.close(); // must not throw, and must not send twice

		assert.equal(stub.seen.filter((r) => r.method === 'DELETE').length, 1);
		assert.equal(pool.closed, true);
		await assert.rejects(() => pool.step([0, 0]), BoltzLabsError);
	} finally {
		await stub.close();
	}
});

test('withPool closes even when the body throws', async () => {
	const stub = await stubServer(poolRoutes(2));
	try {
		await assert.rejects(
			() =>
				RLPool.withPool({ environment: 'cartpole', n: 2, url: stub.url, apiKey: 'k' }, async () => {
					throw new Error('training blew up');
				}),
			/training blew up/
		);
		assert.equal(stub.seen.filter((r) => r.method === 'DELETE').length, 1);
	} finally {
		await stub.close();
	}
});

test('a short batch from the worker is caught, not silently trusted', async () => {
	const stub = await stubServer({
		...poolRoutes(4),
		'POST /api/rl/pools/rp-1/step': { obs: [{}, {}], rewards: [1, 1], dones: [false, false], infos: [{}, {}] }
	});
	try {
		const pool = await RLPool.create({ environment: 'cartpole', n: 4, url: stub.url, apiKey: 'k' });
		await assert.rejects(() => pool.step([0, 0, 0, 0]), /returned 2 observations, expected 4/);
		await pool.close();
	} finally {
		await stub.close();
	}
});
