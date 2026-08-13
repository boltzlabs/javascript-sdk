import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Run an environment the way the worker does: a child process, JSON lines in on
 * stdin, JSON lines out on stdout. Anything the SDK gets wrong about the channel
 * shows up here and nowhere else.
 */
async function drive(body, messages) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-env-'));
	fs.writeFileSync(
		path.join(dir, 'env.js'),
		`import { serve } from ${JSON.stringify(path.join(SRC, 'env.js'))};\n${body}\n`
	);

	const child = spawn(process.execPath, [path.join(dir, 'env.js')], {
		stdio: ['pipe', 'pipe', 'pipe']
	});

	let out = '';
	let err = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (err += d));

	for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
	child.stdin.end();

	const code = await new Promise((r) => child.on('close', r));
	const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
	return { lines, stderr: err, code };
}

test('reset and step answer one line each', async () => {
	const { lines } = await drive(
		`let t = 0;
		 serve({
		   reset: () => { t = 0; return { t }; },
		   step: (a) => [{ t: ++t }, a * 1.5, t >= 2, { a }]
		 });`,
		[{ op: 'reset' }, { op: 'step', action: 2 }, { op: 'step', action: 4 }]
	);

	assert.equal(lines.length, 3);
	assert.deepEqual(lines[0], { obs: { t: 0 } });
	assert.deepEqual(lines[1], { obs: { t: 1 }, reward: 3, done: false, info: { a: 2 } });
	assert.deepEqual(lines[2], { obs: { t: 2 }, reward: 6, done: true, info: { a: 4 } });
});

test('the seed reaches reset', async () => {
	const { lines } = await drive(
		`serve({ reset: (seed) => ({ seed }), step: () => [null, 0, false, {}] });`,
		[{ op: 'reset', seed: 42 }, { op: 'reset' }]
	);
	assert.deepEqual(lines[0], { obs: { seed: 42 } });
	// No seed asked for is null, not undefined-shaped nonsense.
	assert.deepEqual(lines[1], { obs: { seed: null } });
});

test('console.log does not corrupt the channel', async () => {
	// This is the failure the whole design exists to prevent: a debug print
	// landing on the protocol stream desynchronises every reply after it.
	const { lines, stderr } = await drive(
		`serve({
		   reset: () => { console.log('debugging'); return { ok: 1 }; },
		   step: () => { process.stdout.write('sneaky\\n'); return [{ ok: 2 }, 1, false, {}]; }
		 });`,
		[{ op: 'reset' }, { op: 'step', action: 0 }]
	);

	assert.equal(lines.length, 2, 'stray output leaked onto the protocol channel');
	assert.deepEqual(lines[0], { obs: { ok: 1 } });
	assert.equal(lines[1].obs.ok, 2);
	// It is not lost — it lands in the environment's log.
	assert.ok(stderr.includes('debugging'));
	assert.ok(stderr.includes('sneaky'));
});

test('a throw in step becomes a done episode, not a dead environment', async () => {
	const { lines, code } = await drive(
		`serve({
		   reset: () => ({ t: 0 }),
		   step: () => { throw new Error('user bug'); }
		 });`,
		[{ op: 'reset' }, { op: 'step', action: 0 }, { op: 'step', action: 1 }]
	);

	assert.equal(lines.length, 3);
	assert.equal(lines[1].done, true);
	assert.equal(lines[1].reward, 0);
	assert.match(lines[1].info.boltzlabs_error, /step\(\) threw.*user bug/);
	// Still answering after the throw, and it exited cleanly at EOF.
	assert.equal(lines[2].done, true);
	assert.equal(code, 0);
});

test('the gymnasium 5-tuple keeps terminated and truncated apart', async () => {
	// Collapsing these into one flag without preserving both would be a silent
	// correctness bug in a trainer that bootstraps value estimates.
	const { lines } = await drive(
		`serve({
		   reset: () => ({}),
		   step: (a) => [{}, 1, a === 1, a === 2, { extra: 'kept' }]
		 });`,
		[{ op: 'step', action: 1 }, { op: 'step', action: 2 }, { op: 'step', action: 0 }]
	);

	assert.equal(lines[0].done, true);
	assert.deepEqual(lines[0].info, { extra: 'kept', terminated: true, truncated: false });
	assert.equal(lines[1].done, true);
	assert.deepEqual(lines[1].info, { extra: 'kept', terminated: false, truncated: true });
	assert.equal(lines[2].done, false);
});

test('the shorter tuples and the object form are all accepted', async () => {
	const { lines } = await drive(
		`const shapes = [
		   [{ n: 0 }, 1],
		   [{ n: 1 }, 1, true],
		   [{ n: 2 }, 1, false, { i: 2 }],
		   { obs: { n: 3 }, reward: 7, done: true },
		   { observation: { n: 4 }, reward: 8 }
		 ];
		 let i = 0;
		 serve({ reset: () => ({}), step: () => shapes[i++] });`,
		[0, 1, 2, 3, 4].map((a) => ({ op: 'step', action: a }))
	);

	assert.deepEqual(lines[0], { obs: { n: 0 }, reward: 1, done: false });
	assert.equal(lines[1].done, true);
	assert.deepEqual(lines[2].info, { i: 2 });
	assert.deepEqual(lines[3], { obs: { n: 3 }, reward: 7, done: true });
	// `observation` is renamed onto the wire's `obs`.
	assert.deepEqual(lines[4], { obs: { n: 4 }, reward: 8, done: false });
});

test('a reset is forced if a caller steps first', async () => {
	const { lines } = await drive(
		`let ready = false;
		 serve({
		   reset: () => { ready = true; return {}; },
		   step: () => [{ ready }, 0, false, {}]
		 });`,
		[{ op: 'step', action: 0 }]
	);
	assert.equal(lines[0].obs.ready, true);
});

test('a typed-array observation is serialised, not dropped', async () => {
	const { lines } = await drive(
		`serve({ reset: () => new Float32Array([1, 2, 3]), step: () => [null, 0, false, {}] });`,
		[{ op: 'reset' }]
	);
	assert.deepEqual(lines[0].obs, [1, 2, 3]);
});

test('a bad line and an unknown op are answered, not fatal', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-env-'));
	fs.writeFileSync(
		path.join(dir, 'env.js'),
		`import { serve } from ${JSON.stringify(path.join(SRC, 'env.js'))};\n` +
			`serve({ reset: () => ({ ok: 1 }), step: () => [{}, 0, false, {}] });\n`
	);

	const child = spawn(process.execPath, [path.join(dir, 'env.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
	let out = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (d) => (out += d));
	child.stderr.resume();

	child.stdin.write('{not json\n');
	child.stdin.write(JSON.stringify({ op: 'fly' }) + '\n');
	child.stdin.write(JSON.stringify({ op: 'reset' }) + '\n');
	child.stdin.end();

	const code = await new Promise((r) => child.on('close', r));
	const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));

	assert.equal(lines.length, 3);
	assert.match(lines[0].info.boltzlabs_error, /bad message/);
	// An unknown op must not end the episode — a protocol that grew a message
	// this environment predates should cost one step, not the rest of the run.
	assert.equal(lines[1].done, false);
	assert.match(lines[1].info.boltzlabs_error, /unknown op/);
	assert.deepEqual(lines[2], { obs: { ok: 1 } });
	assert.equal(code, 0);
});

test('an async reset and step are awaited', async () => {
	const { lines } = await drive(
		`serve({
		   reset: async () => { await new Promise(r => setTimeout(r, 5)); return { async: true }; },
		   step: async (a) => { await new Promise(r => setTimeout(r, 1)); return [{ a }, 1, false, {}]; }
		 });`,
		[{ op: 'reset' }, { op: 'step', action: 7 }]
	);
	assert.deepEqual(lines[0], { obs: { async: true } });
	assert.deepEqual(lines[1].obs, { a: 7 });
});
