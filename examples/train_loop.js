// The shape of a training loop against a pool.
//
//     node examples/train_loop.js --environment cartpole -n 256
//     node examples/train_loop.js --env-dir ./examples/counting_env -n 64 --runtime node
//
// There is no learning here on purpose — it is the loop and the timing, which is
// what you want to see before putting a real algorithm behind it.
import { RLPool, rlEnvironments } from '../src/index.js';

function arg(name, fallback = null) {
	const i = process.argv.indexOf(name);
	return i === -1 ? fallback : process.argv[i + 1];
}

const n = Number(arg('-n', '64'));
const steps = Number(arg('--steps', '100'));
const environment = arg('--environment');
const envDir = arg('--env-dir');
const runtime = arg('--runtime', 'python3');

if (!environment && !envDir) {
	console.error('pass --environment <name> or --env-dir <path>');
	console.error('available:', (await rlEnvironments()).map((e) => e.code).join(', '));
	process.exit(2);
}

const pool = await RLPool.create(
	environment ? { environment, n } : { envDir, n, runtime }
);
console.log(`pool ${pool.poolId}: ${pool.n} envs via ${pool.via}`);

try {
	let obs = await pool.reset({ seed: 0 });
	let total = 0;
	const overheads = [];

	for (let i = 0; i < steps; i++) {
		// A real trainer puts a policy here. Random actions still measure the
		// thing this loop exists to measure: what a step costs.
		const actions = obs.map(() => Math.floor(Math.random() * 2));
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
