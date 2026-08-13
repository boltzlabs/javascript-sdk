// Turn a directory on the caller's disk into the tar the worker unpacks.
//
// Two decisions worth stating.
//
// **The archive is deterministic.** Timestamps, ownership and walk order are all
// pinned, so the same directory produces the same bytes every time. That makes
// an upload diffable and cacheable, and it means "the pool I benchmarked" and
// "the pool I deployed" can be compared by hash rather than by hope.
//
// **The `serve` shim is vendored in automatically.** The sandbox mounts the
// uploaded directory at `/env` and nothing else — no npm, no install step. So
// `import {serve} from 'boltzlabs'` at the top of a user's `env.js` can only work
// if the module travels with it, which is why it is written into the tar under
// `node_modules/boltzlabs/`. Making the user copy a file by hand is a
// documentation problem that becomes a support problem.
//
// The tar is plain ustar, written here rather than taken as a dependency: the
// format is a 512-byte header and padded blocks, an environment is a handful of
// small source files, and a supply-chain surface for that trade is a bad deal.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// The worker's limit is 32 MB and the control plane rejects above it. An
// environment is a program, not a dataset.
export const MAX_CODE_BYTES = 32 << 20;

export const DEFAULT_EXCLUDES = [
	'__pycache__',
	'*.pyc',
	'*.pyo',
	'.git',
	'.hg',
	'.svn',
	'.venv',
	'venv',
	'node_modules',
	'.DS_Store',
	'*.egg-info',
	'.mypy_cache',
	'.pytest_cache',
	'.ipynb_checkpoints',
	'bench_results'
];

const BLOCK = 512;

const VENDOR_PACKAGE_JSON = JSON.stringify(
	{
		name: 'boltzlabs',
		version: '0.1.0',
		type: 'module',
		main: './env.js',
		exports: { '.': './env.js' }
	},
	null,
	2
);

/** glob-ish match for the exclude list: `*` only, which is all the patterns use. */
function excluded(name, patterns) {
	return patterns.some((p) => {
		if (!p.includes('*')) return name === p;
		const rx = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
		return rx.test(name);
	});
}

function octal(value, width) {
	// ustar numeric fields: zero-padded octal, NUL-terminated.
	return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0', 'ascii');
}

/** One 512-byte ustar header. */
function header(name, size, mode) {
	const buf = Buffer.alloc(BLOCK);
	const nameBytes = Buffer.from(name, 'utf8');
	if (nameBytes.length > 100) {
		// Long paths need a PAX or ustar-prefix record. An environment is a few
		// source files; say so rather than write a header the worker misreads.
		throw new Error(`path too long for the archive (${nameBytes.length} > 100 bytes): ${name}`);
	}
	nameBytes.copy(buf, 0);
	octal(mode & 0o7777, 8).copy(buf, 100); // mode
	octal(0, 8).copy(buf, 108); // uid
	octal(0, 8).copy(buf, 116); // gid
	octal(size, 12).copy(buf, 124); // size
	octal(0, 12).copy(buf, 136); // mtime — pinned, see the module comment
	buf.write('0', 156, 1, 'ascii'); // typeflag: regular file
	buf.write('ustar\0', 257, 6, 'ascii');
	buf.write('00', 263, 2, 'ascii');
	// uname/gname stay empty; uid/gid 0 is the whole ownership story.

	// The checksum is computed with its own field read as spaces.
	buf.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of buf) sum += byte;
	Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(buf, 148);
	return buf;
}

/** Header + contents + padding for one file. */
function entry(name, data, mode = 0o644) {
	const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
	const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
	return Buffer.concat([header(name, body.length, mode), body, Buffer.alloc(pad)]);
}

/** The bytes of this package's own env.js — the shim the sandbox runs. */
async function envModuleSource() {
	return fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'env.js'));
}

/** Every file under `root`, relative and sorted, with symlinks reported not followed. */
async function walk(root, excludes) {
	const files = [];
	const skippedSymlinks = [];

	async function visit(dir, prefix) {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const dirs = [];
		const plain = [];
		for (const e of entries) {
			if (excluded(e.name, excludes)) continue;
			(e.isDirectory() && !e.isSymbolicLink() ? dirs : plain).push(e);
		}
		// Sorted so the archive is byte-identical run to run.
		plain.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		dirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

		for (const e of plain) {
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isSymbolicLink()) {
				// The worker skips symlinks when unpacking — a link to /etc/shadow
				// would otherwise be mounted into every sandbox in the pool. Say so
				// here rather than let the file quietly not exist at the far end.
				skippedSymlinks.push(rel);
				continue;
			}
			if (!e.isFile()) continue;
			const full = path.join(dir, e.name);
			files.push({ rel, full, mode: (await fs.stat(full)).mode & 0o777 });
		}
		for (const e of dirs) {
			await visit(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
		}
	}

	await visit(root, '');
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	return { files, skippedSymlinks };
}

/**
 * Pack `envDir` into gzipped tar bytes.
 *
 * Throws if the entrypoint is missing — a create that failed on the worker for
 * that reason costs a round trip and returns an error about a path inside a
 * sandbox the caller has never seen.
 *
 * @returns {Promise<{code: Buffer, skippedSymlinks: string[]}>}
 */
export async function packEnvDir(
	envDir,
	{ entrypoint = 'env.js', vendor = true, excludes = DEFAULT_EXCLUDES, maxBytes = MAX_CODE_BYTES } = {}
) {
	const root = path.resolve(envDir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));

	let rootStat;
	try {
		rootStat = await fs.stat(root);
	} catch {
		throw new Error(`'${envDir}' is not a directory`);
	}
	if (!rootStat.isDirectory()) throw new Error(`'${envDir}' is not a directory`);

	try {
		if (!(await fs.stat(path.join(root, entrypoint))).isFile()) throw new Error('not a file');
	} catch {
		throw new Error(
			`'${envDir}' has no '${entrypoint}' — that file is what the pool runs. ` +
				`Pass entrypoint if yours is named something else.`
		);
	}

	const { files, skippedSymlinks } = await walk(root, excludes);

	const chunks = [];
	const names = new Set();
	for (const f of files) {
		chunks.push(entry(f.rel, await fs.readFile(f.full), f.mode));
		names.add(f.rel);
	}

	if (vendor && !names.has('node_modules/boltzlabs/env.js')) {
		chunks.push(entry('node_modules/boltzlabs/package.json', VENDOR_PACKAGE_JSON));
		chunks.push(entry('node_modules/boltzlabs/env.js', await envModuleSource()));
	}

	// Two zero blocks end the archive.
	chunks.push(Buffer.alloc(BLOCK * 2));

	// mtime=0 on the gzip header too: otherwise the container carries a
	// timestamp even though everything inside it is pinned.
	const code = zlib.gzipSync(Buffer.concat(chunks), { level: 6, mtime: 0 });

	if (code.length > maxBytes) {
		throw new Error(
			`'${envDir}' packs to ${(code.length / 1e6).toFixed(1)} MB, over the ` +
				`${(maxBytes / 1e6).toFixed(0)} MB limit. An environment is a program, not a ` +
				`dataset — bake large assets into the image.`
		);
	}
	return { code, skippedSymlinks };
}
