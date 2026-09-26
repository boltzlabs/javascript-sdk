import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { packPath, unpackTo } from '../src/files.js';

async function scratch() {
	return mkdtemp(path.join(tmpdir(), 'bzfiles-'));
}

test('a directory survives a pack/unpack round trip', async () => {
	const src = await scratch();
	await mkdir(path.join(src, 'app'), { recursive: true });
	await writeFile(path.join(src, 'app', 'index.js'), 'hello');
	await writeFile(path.join(src, 'app', 'nested.txt'), 'world');

	const tar = await packPath(path.join(src, 'app'));
	const dest = await scratch();
	await unpackTo(tar, dest);

	// Named relative to the parent, so it lands as <dest>/app — scp semantics.
	assert.equal(await readFile(path.join(dest, 'app', 'index.js'), 'utf8'), 'hello');
	assert.equal(await readFile(path.join(dest, 'app', 'nested.txt'), 'utf8'), 'world');
});

test('an entry that climbs out of the destination is refused', async () => {
	// Hand-built: the packer would never emit this, but a sandbox can.
	const BLOCK = 512;
	const head = Buffer.alloc(BLOCK);
	const name = '../escaped.txt';
	head.write(name, 0, 100, 'utf8');
	head.write('0000644\0', 100, 8, 'ascii');
	head.write('00000000005\0', 124, 12, 'ascii');
	head.write('        ', 148, 8, 'ascii');
	head.write('0', 156, 1, 'ascii');
	head.write('ustar\0', 257, 6, 'ascii');
	let sum = 0;
	for (const b of head) sum += b;
	Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(head, 148);

	const body = Buffer.alloc(BLOCK);
	body.write('pwned');
	const tar = Buffer.concat([head, body, Buffer.alloc(BLOCK * 2)]);

	const dest = await scratch();
	await assert.rejects(() => unpackTo(tar, path.join(dest, 'sub')), /outside/);
	assert.ok(!existsSync(path.join(dest, 'escaped.txt')), 'wrote above the destination');
});
