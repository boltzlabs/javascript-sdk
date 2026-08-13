# boltzlabs

Sandboxes and RL environments, from JavaScript.

```bash
npm install boltzlabs
```

Node 18 or newer. No dependencies.

```js
import { Sandbox } from 'boltzlabs';

const sb = await Sandbox.create();                 // small / base / internet off

console.log(String(await sb.run('print(sum(range(101)))')));
console.log(String(await sb.exec('pip install requests')));

await sb.delete();                                 // stops the meter
```

The key comes from `BOLTZLABS_API_KEY` in the environment or in a `.env` file,
searched from the current directory upwards. Nothing else is required.

The origin defaults to `https://boltzlabs.cloud`. Set `BOLTZLABS_API_URL` to
point elsewhere, or call `use({apiKey, url})` once at startup.

## Sandboxes

A sandbox is a machine that stays up between commands. `Sandbox.create()` is a
static rather than a constructor because a sandbox does not exist until the
platform has assigned it an id, and a constructor cannot await that.

```js
const sb = await Sandbox.create({
  machine: 'medium',          // nano | small | medium | large
  environment: 'pytorch',     // base | python | node | pytorch | …
  name: 'trainer',
  internet: true
});

await sb.waitUntilRunning();  // creation returns before boot does

await sb.exec('nvidia-smi');
await sb.run('import torch; print(torch.cuda.is_available())');

sb.url(8080);                 // reach a port from outside
await sb.metrics();

await sb.delete();
```

`withSandbox` writes the `delete()` for you, including when the body throws —
the case that otherwise leaves a machine billing until someone notices.

```js
await Sandbox.withSandbox({ environment: 'python' }, async (sb) => {
  (await sb.run('print("hi")')).check();
});
```

## One-shot execution

Nothing is created and nothing is left over — no sandbox to make first and none
to destroy after. Use a sandbox instead when you want state to survive between
commands.

```js
import { execute, languages } from 'boltzlabs';

await execute('print(sum(range(101)))', { language: 'python' });   // 5050
await execute({ file: 'train.py', language: 'python' });
await execute('console.log(1)', { language: 'node' });
await execute({ file: 'main.go', language: 'go' });                // compiled, then run

await languages();   // python, node, go, c, cpp — from the platform
```

The language is never guessed, from an extension or otherwise: a `.py` file is
as likely to be torch as plain python, and inline code has no extension at all.

A compiled language builds first. Code that does not compile comes back as a
result, not an exception, with `compileFailed` set and the compiler's output in
`stderr`.

## RL pools

The shape that matters: one HTTP request carries N actions and returns N
results. A loop that stepped environments one at a time would pay a round trip
per environment per step, and at a thousand environments that is the whole cost
of training.

```js
import { RLPool } from 'boltzlabs';

const pool = await RLPool.create({ environment: 'cartpole', n: 1000 });

let obs = await pool.reset();

for (let i = 0; i < 100; i++) {
  const actions = obs.map(() => Math.random() < 0.5 ? 0 : 1);
  const { obs: next, rewards, dones, infos } = await pool.step(actions);
  obs = next;
}

console.log(String(pool.timing));   // 8.1ms roundtrip, 1.2ms slowest env, 6.9ms overhead
await pool.close();
```

`rewards` is a `Float32Array`, `dones` is a `boolean[]`, and `obs`/`infos` stay
as they came — coercing arbitrary JSON into an array would be a guess about your
observation space that this layer has no business making.

### Ready-made environments

```js
import { rlEnvironments } from 'boltzlabs';

await rlEnvironments();   // gridworld, bandit, cartpole, mountaincar, acrobot, pendulum
```

### Your own environment

A pool runs either an environment the platform ships or one you wrote — passing
both, or neither, is refused rather than resolved by precedence.

Write `env.js`, and `serve` owns the protocol:

```js
// my_env/env.js
import { serve } from 'boltzlabs';

let t = 0;

serve({
  reset: (seed) => { t = 0; return { t }; },
  step:  (action) => [{ t: ++t }, action === 1 ? 1 : 0, t >= 100, {}]
});
```

```js
const pool = await RLPool.create({ envDir: './my_env', n: 256, runtime: 'node' });
```

The directory is packed into a deterministic tar and uploaded; the `serve` shim
travels with it, because the sandbox mounts your directory and nothing else — no
npm, no install step.

`step` may return any of these, and may be `async`:

| returned | meaning |
| --- | --- |
| `[obs, reward]` | `done` is false |
| `[obs, reward, done]` | |
| `[obs, reward, done, info]` | the classic 4-tuple |
| `[obs, reward, terminated, truncated, info]` | the Gymnasium 5-tuple |
| `{obs, reward, done, info}` | passed through |

The 5-tuple collapses to one `done` because the wire format has one flag, but
both `terminated` and `truncated` are preserved in `info` — a trainer that
bootstraps value estimates needs to tell them apart.

`serve` also takes stdout away from your code: `console.log` and
`process.stdout.write` go to stderr, where they land in the environment's log
instead of desynchronising the protocol. Debug printing is safe.

An exception in your `step` is answered as `done: true` with the error in
`info.boltzlabs_error`, so a broken environment is visible in the training
loop's own data rather than quietly shrinking the pool.

## Everything else

```js
import { me, sandboxes, sandbox, environments, machines, pools, Client, use } from 'boltzlabs';

await me();             // who your key belongs to      (bzlabs auth status)
await sandboxes();      // everything you have running  (bzlabs ls)
await sandbox(id);      // one of them, by id           (bzlabs status <id>)
await environments();   // runtime and coding-agent images (bzlabs environments)
await machines();       // machines and prices          (bzlabs machines)
await pools();          // your RL pools

use({ apiKey, url });   // point the default client somewhere else
new Client({ apiKey, url });   // or hold two at once
```

## Errors

Separated by what you can do about them. The one that is worth catching by
itself is `CapacityError` — it is the retryable one.

```js
import { CapacityError, QuotaError, PoolGoneError } from 'boltzlabs';

try {
  await RLPool.create({ environment: 'cartpole', n: 5000 });
} catch (err) {
  if (err instanceof CapacityError) { /* no worker took it — retry */ }
  if (err instanceof QuotaError)    { /* your environment limit is in the way */ }
  if (err instanceof PoolGoneError) { /* the worker left; create a new pool */ }
  throw err;
}
```

| class | status | |
| --- | --- | --- |
| `TransportError` | — | never got an HTTP answer |
| `AuthError` | 401, 403 | key missing, wrong, or not allowed |
| `NotFoundError` | 404 | no such thing, or not yours |
| `QuotaError` | 409 | environment limit |
| `PoolGoneError` | 410 | the worker holding the pool left the fleet |
| `PayloadTooLargeError` | 413 | uploaded environment over 32 MB |
| `CapacityError` | 502, 503, 504 | no worker could take it — retryable |
