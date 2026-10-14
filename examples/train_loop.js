// The shape of a training loop against a pool: a random agent on a real bug.
//
//     node examples/train_loop.js -n 64
//     node examples/train_loop.js --env-dir ./my_env -n 64 --runtime node
//
// Each environment is examples/dotenv_env: python-dotenv with a real upstream bug
// put back. The agent reads, writes and runs the hidden tests; reward is 1 only
// for a real fix. There is no learning here on purpose — it is the loop and the
// timing, which is what you want to see before putting a model behind it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RLPool } from '../src/index.js';

function arg(name, fallback = null) {
	const i = process.argv.indexOf(name);
	return i === -1 ? fallback : process.argv[i + 1];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const n = Number(arg('-n', '64'));
const steps = Number(arg('--steps', '100'));
const envDir = arg('--env-dir', path.join(here, 'dotenv_env'));
const runtime = arg('--runtime', 'python3');

// The agent's possible moves. The repository copy here holds the upstream fix,
// so one write repairs the bug and another leaves it broken.
const target = 'src/dotenv/parser.py';
const fixed = fs.readFileSync(path.join(here, 'dotenv_env', 'repo', target), 'utf8');
const broken = fixed.replace('stream.read().removeprefix("\\ufeff")', 'stream.read()');
const moves = [
	{ op: 'read', path: target },
	{ op: 'write', path: target, content: fixed },
	{ op: 'write', path: target, content: broken },
	{ op: 'test' }
];

const pool = await RLPool.create({ envDir, n, runtime });
console.log(`pool ${pool.poolId}: ${pool.n} envs via ${pool.via}`);

try {
	let obs = await pool.reset({ seed: 0 });
	let total = 0;
	const overheads = [];

	for (let i = 0; i < steps; i++) {
		// A real trainer puts a model here that reads the issue and writes a
		// patch. Random moves still measure what this loop exists to measure:
		// what a step costs.
		const actions = obs.map(() => moves[Math.floor(Math.random() * moves.length)]);
		const { obs: next, rewards, timing } = await pool.step(actions);

		obs = next;
		for (const r of rewards) total += r;
		overheads.push(timing.overheadMs);

		if (i % 20 === 0) console.log(`step ${i}: ${timing}`);
	}

	overheads.sort((a, b) => a - b);
	const p50 = overheads[Math.floor(overheads.length * 0.5)];
	const p99 = overheads[Math.floor(overheads.length * 0.99)];
	console.log(`\n${steps} steps × ${n} envs = ${steps * n} transitions`);
	console.log(`mean reward/step: ${(total / steps).toFixed(2)}`);
	console.log(`platform overhead: p50 ${p50.toFixed(1)}ms, p99 ${p99.toFixed(1)}ms`);
} finally {
	await pool.close();
}
