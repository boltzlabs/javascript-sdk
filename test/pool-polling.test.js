import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RLPool } from "../src/pool.js";
import { stubServer } from "./stub.js";

/** A minimal environment directory the packer will accept. */
function envDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bz-env-"));
  fs.writeFileSync(path.join(dir, "env.py"), "print('ok')\n");
  return dir;
}

test("creation polls the saved pool and returns only when ready", async () => {
  let polls = 0;
  const stub = await stubServer({
    "POST /api/rl/pools?wait=false": {
      __status: 202,
      body: { pool_id: "rp-1", status: "creating" },
    },
    "GET /api/rl/pools/rp-1?creation=true": () => ({
      pool_id: "rp-1",
      status: ++polls === 1 ? "creating" : "running",
      ready: 2,
    }),
    "DELETE /api/rl/pools/rp-1": { __status: 204 },
  });
  try {
    const pool = await RLPool.create({
      envDir: envDir(),
      n: 2,
      url: stub.url,
      apiKey: "k",
    });
    assert.equal(pool.poolId, "rp-1");
    assert.equal(polls, 2);
    assert.equal(stub.seen.filter((req) => req.method === "POST").length, 1);
    assert.ok(
      stub.seen.every((req) => req.headers.authorization === "Bearer k"),
    );
    await pool.close();
  } finally {
    await stub.close();
  }
});

test("startup errors keep their status and cancel the pool", async () => {
  const stub = await stubServer({
    "POST /api/rl/pools?wait=false": { pool_id: "rp-1", status: "creating" },
    "GET /api/rl/pools/rp-1?creation=true": {
      status: "failed",
      error: "env.js failed",
      error_status: 400,
    },
    "DELETE /api/rl/pools/rp-1": { __status: 204 },
  });
  try {
    await assert.rejects(
      RLPool.create({
        envDir: envDir(),
        n: 1,
        url: stub.url,
        apiKey: "k",
      }),
      (err) => err.status === 400 && err.detail === "env.js failed",
    );
    assert.equal(stub.seen.at(-1).method, "DELETE");
  } finally {
    await stub.close();
  }
});

test("the creation deadline cancels the pending pool", async () => {
  const stub = await stubServer({
    "POST /api/rl/pools?wait=false": { pool_id: "rp-1", status: "creating" },
    "DELETE /api/rl/pools/rp-1": { __status: 204 },
  });
  try {
    await assert.rejects(
      RLPool.create({
        envDir: envDir(),
        n: 1,
        url: stub.url,
        apiKey: "k",
        createTimeout: 0.2,
      }),
      /creation timed out/,
    );
    assert.equal(stub.seen.at(-1).method, "DELETE");
  } finally {
    await stub.close();
  }
});
