import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { packEnvDir } from '../src/pack.js';

function tmpdir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bz-pack-'));
}

/** Read the entry names out of a tar the way tar itself would. */
function namesIn(gz) {
	const tar = zlib.gunzipSync(gz);
	const names = [];
	for (let off = 0; off + 512 <= tar.length; ) {
		const header = tar.subarray(off, off + 512);
		const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
		if (!name) break;
		const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
		names.push({ name, size, mode: header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim() });
		off += 512 + Math.ceil(size / 512) * 512;
	}
	return names;
}

test('the archive is a tar that system tar can read', () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');
	fs.mkdirSync(path.join(dir, 'sub'));
	fs.writeFileSync(path.join(dir, 'sub', 'helper.js'), 'export const b = 2;\n');

	return packEnvDir(dir).then(({ code }) => {
		const out = tmpdir();
		fs.writeFileSync(path.join(out, 'env.tar.gz'), code);
		// The real check: GNU/BSD tar accepts it. A hand-written header that only
		// this test's parser understands would be worthless.
		const listing = execFileSync('tar', ['-tzf', path.join(out, 'env.tar.gz')], {
			encoding: 'utf8'
		}).trim().split('\n').sort();

		assert.ok(listing.includes('env.js'));
		assert.ok(listing.includes('sub/helper.js'));
		assert.ok(listing.includes('node_modules/boltzlabs/env.js'));
	});
});

test('the same directory packs to the same bytes', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');

	const first = (await packEnvDir(dir)).code;
	// Touch the mtime; a deterministic archive must not notice.
	const later = new Date(Date.now() + 60_000);
	fs.utimesSync(path.join(dir, 'env.js'), later, later);
	const second = (await packEnvDir(dir)).code;

	assert.deepEqual(first, second, 'the archive is not deterministic');
});

test('the serve shim travels with the code', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');

	const { code } = await packEnvDir(dir);
	const names = namesIn(code).map((e) => e.name);
	// The sandbox mounts the uploaded directory and nothing else — no npm — so
	// `import {serve} from 'boltzlabs'` only resolves if the module is in the tar.
	assert.ok(names.includes('node_modules/boltzlabs/env.js'));
	assert.ok(names.includes('node_modules/boltzlabs/package.json'));
});

test('vendoring can be turned off', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');

	const { code } = await packEnvDir(dir, { vendor: false });
	assert.deepEqual(namesIn(code).map((e) => e.name), ['env.js']);
});

test('a missing entrypoint fails here, not on the worker', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'main.js'), 'export const a = 1;\n');

	await assert.rejects(() => packEnvDir(dir), /has no 'env\.js'/);
	// Naming it is enough.
	const { code } = await packEnvDir(dir, { entrypoint: 'main.js' });
	assert.ok(namesIn(code).some((e) => e.name === 'main.js'));
});

test('excluded directories never reach the archive', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');
	fs.mkdirSync(path.join(dir, 'node_modules', 'left-over'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'node_modules', 'left-over', 'big.js'), 'x'.repeat(1000));
	fs.mkdirSync(path.join(dir, '__pycache__'));
	fs.writeFileSync(path.join(dir, '__pycache__', 'x.pyc'), 'junk');
	fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');

	const { code } = await packEnvDir(dir);
	const names = namesIn(code).map((e) => e.name);
	// The vendored path is ours; the caller's node_modules is not.
	assert.ok(!names.some((n) => n.includes('left-over')));
	assert.ok(!names.some((n) => n.includes('__pycache__')));
	assert.ok(!names.includes('.DS_Store'));
});

test('a symlink is reported rather than silently dropped', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');
	fs.symlinkSync('/etc/hosts', path.join(dir, 'sneaky.txt'));

	const { code, skippedSymlinks } = await packEnvDir(dir);
	// The worker skips symlinks when unpacking; the caller is told which.
	assert.deepEqual(skippedSymlinks, ['sneaky.txt']);
	assert.ok(!namesIn(code).some((e) => e.name === 'sneaky.txt'));
});

test('file modes survive the round trip', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');
	fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });

	const { code } = await packEnvDir(dir);
	const entry = namesIn(code).find((e) => e.name === 'run.sh');
	assert.equal(parseInt(entry.mode, 8) & 0o777, 0o755);
});

test('a path too long for a ustar header is refused clearly', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'env.js'), 'export const a = 1;\n');
	const deep = path.join(dir, 'a'.repeat(60), 'b'.repeat(60));
	fs.mkdirSync(deep, { recursive: true });
	fs.writeFileSync(path.join(deep, 'x.js'), 'x');

	await assert.rejects(() => packEnvDir(dir), /path too long/);
});
