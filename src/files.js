// File transfer to and from a sandbox — the SDK half of `boltz cp`.
//
// The wire format is a tar stream, which is what lets one request carry a whole
// tree with its layout intact, and it is what the `/fs` endpoint speaks on both
// sides. It rides an exec rather than a socket, so it works on a sandbox created
// with internet off.
//
// The writer is the plain ustar one from pack.js — same reasoning as there: the
// format is a 512-byte header and padded blocks, and a dependency to emit that
// is not worth the supply chain. The reader below is its counterpart.

import { mkdir, readdir, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;

function octal(value, width) {
	return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}

/** One 512-byte ustar header. */
function header(name, size, mode, type = '0') {
	const buf = Buffer.alloc(BLOCK);
	if (Buffer.byteLength(name) > 100) {
		throw new Error(`path too long for ustar: ${name}`);
	}
	buf.write(name, 0, 100, 'utf8');
	octal(mode & 0o7777, 8).copy(buf, 100);
	octal(0, 8).copy(buf, 108);
	octal(0, 8).copy(buf, 116);
	octal(size, 12).copy(buf, 124);
	octal(Math.floor(Date.now() / 1000), 12).copy(buf, 136);
	buf.write('        ', 148, 8, 'ascii'); // checksum placeholder
	buf.write(type, 156, 1, 'ascii');
	buf.write('ustar\0', 257, 6, 'ascii');
	buf.write('00', 263, 2, 'ascii');

	let sum = 0;
	for (const b of buf) sum += b;
	Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(buf, 148);
	return buf;
}

function pad(size) {
	const rem = size % BLOCK;
	return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/** Walk `root`, yielding {name, mode, data} named relative to `base`. */
async function collect(root, base, out = []) {
	const info = await stat(root);
	const name = path.relative(base, root).split(path.sep).join('/');
	if (info.isDirectory()) {
		if (name) out.push({ name: name + '/', mode: info.mode, dir: true });
		for (const ent of await readdir(root)) {
			await collect(path.join(root, ent), base, out);
		}
		return out;
	}
	if (!info.isFile()) return out; // sockets, devices and links have no meaning inside
	out.push({ name, mode: info.mode, data: await readFile(root) });
	return out;
}

/** Tar `local` so it extracts as its own basename under the destination. */
export async function packPath(local) {
	const abs = path.resolve(local);
	const base = path.dirname(abs);
	const entries = await collect(abs, base);
	const chunks = [];
	for (const e of entries) {
		if (e.dir) {
			chunks.push(header(e.name, 0, e.mode, '5'));
			continue;
		}
		chunks.push(header(e.name, e.data.length, e.mode), e.data, pad(e.data.length));
	}
	chunks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks end a tar
	return Buffer.concat(chunks);
}

/**
 * Unpack a tar under `dest`.
 *
 * The archive is not trusted input — a sandbox may be running code its owner did
 * not write — so every entry is checked to land inside `dest`. Without that, an
 * entry named `../../.ssh/authorized_keys` writes outside the directory the
 * caller pointed at. Links are skipped for the same reason: a symlink out of the
 * tree followed by a write through it is the same escape in two steps.
 */
export async function unpackTo(buf, dest) {
	const root = path.resolve(dest);
	await mkdir(root, { recursive: true });

	for (let off = 0; off + BLOCK <= buf.length; ) {
		const head = buf.subarray(off, off + BLOCK);
		if (head.every((b) => b === 0)) break; // end of archive

		const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
		const size = parseInt(head.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
		const mode = parseInt(head.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0o644;
		const type = head.subarray(156, 157).toString('ascii');
		off += BLOCK;

		const target = path.resolve(root, name);
		if (target !== root && !target.startsWith(root + path.sep)) {
			throw new Error(`refusing archive entry outside ${dest}: ${JSON.stringify(name)}`);
		}

		if (type === '5') {
			await mkdir(target, { recursive: true });
		} else if (type === '0' || type === '\0' || type === '') {
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, buf.subarray(off, off + size));
			await chmod(target, mode & 0o777);
		}
		// links (types 1, 2) and everything else are skipped deliberately

		off += size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
	}
}
