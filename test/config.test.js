import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import * as config from '../src/config.js';
import { AuthError } from '../src/errors.js';

const SAVED = { ...process.env };

beforeEach(() => {
	delete process.env.BOLTZLABS_API_KEY;
	delete process.env.BOLTZLABS_API_URL;
	config._clearCache();
});

after(() => {
	process.env = SAVED;
});

test('the default origin is the production one', () => {
	assert.equal(config.DEFAULT_API_URL, 'https://boltzlabs.cloud');
	const { url } = config.resolve({ apiKey: 'k' });
	assert.equal(url, 'https://boltzlabs.cloud');
});

test('a trailing slash on the origin is dropped', () => {
	const { url } = config.resolve({ url: 'https://example.test/', apiKey: 'k' });
	assert.equal(url, 'https://example.test');
});

test('the real environment beats a .env file', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
	fs.writeFileSync(path.join(dir, '.env'), 'BOLTZLABS_API_KEY=from-file\n');
	process.env.BOLTZLABS_API_KEY = 'from-env';

	const { apiKey } = config.resolve({ dotenvPath: path.join(dir, '.env') });
	assert.equal(apiKey, 'from-env');
});

test('a .env file is read when the environment is empty', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
	const file = path.join(dir, '.env');
	fs.writeFileSync(file, 'export BOLTZLABS_API_KEY="ak_quoted"  # trailing comment\n');

	const { apiKey } = config.resolve({ dotenvPath: file });
	assert.equal(apiKey, 'ak_quoted');
});

test('an unquoted trailing comment is stripped, a quoted # is kept', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
	const file = path.join(dir, '.env');
	fs.writeFileSync(file, 'A=plain # note\nB="has#hash"\n');

	const parsed = config.loadDotenv({ file });
	assert.equal(parsed.A, 'plain');
	assert.equal(parsed.B, 'has#hash');
});

test('.env is found by walking upwards', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
	const nested = path.join(root, 'a', 'b');
	fs.mkdirSync(nested, { recursive: true });
	fs.writeFileSync(path.join(root, '.env'), 'BOLTZLABS_API_KEY=up-there\n');

	assert.equal(config.findDotenv(nested), path.join(root, '.env'));
});

test('loading a .env never mutates process.env', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
	const file = path.join(dir, '.env');
	fs.writeFileSync(file, 'BOLTZLABS_SENTINEL=nope\n');

	config.loadDotenv({ file });
	assert.equal(process.env.BOLTZLABS_SENTINEL, undefined);
});

test('a missing key is an error, not an anonymous request', () => {
	// Point at a directory with no .env so the walk cannot find the repo's own.
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
	assert.throws(() => config.resolve({ dotenvPath: path.join(empty, '.env') }), AuthError);
});

test('mask shows enough of a key to identify it and no more', () => {
	assert.equal(config.mask('short'), '••••');
	const masked = config.mask('ak_0123456789abcdefghij');
	assert.ok(masked.startsWith('ak_012345678'));
	assert.ok(masked.endsWith('ghij'));
	assert.ok(!masked.includes('9abcdef'));
});
