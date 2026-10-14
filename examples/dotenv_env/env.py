"""A real agentic coding environment: python-dotenv's UTF-8 BOM bug.

The task is a genuine upstream defect, not an invented one. A .env file saved
with a byte order mark (common from JetBrains IDEs on Windows) silently lost
its first variable, because the BOM was parsed as part of the first key.
Upstream issue #637, fixed in commit bca6644 by one line in
``src/dotenv/parser.py``:

    self.string = stream.read()          ->  ... .removeprefix("\\ufeff")

The fixture ships the repository at the fixing commit and reverts that line,
so the agent faces the bug exactly as it was reported.

Unlike a scripted replay, this environment takes whatever action the policy
emits. It is the read / write / test loop an agentic rollout actually runs:

    {"op": "read",  "path": "src/dotenv/parser.py"}
    {"op": "write", "path": "src/dotenv/parser.py", "content": "..."}
    {"op": "test"}

Reward is only on test, and only for a real repair:

  * the BOM regression must pass,
  * the parser's existing behaviour must still hold, so a fix that breaks
    ordinary parsing earns nothing, and
  * the grader's own expectations are not in the workspace at all, so there is
    no test file to edit. Reward hacking by rewriting the oracle is not
    available, which is the property that makes the signal worth training on.

The grader restates upstream's regression expectations using only the standard
library: the sandbox has no network, so pytest cannot be assumed present. It
imports the repository's real parser and asserts on real Binding values.
"""
import hashlib
import io
import json
import os
import shutil
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PRISTINE = ROOT / "repo"
WORKSPACE = Path(os.environ.get("DOTENV_WORKSPACE", "/workspace")) / "repo"

TARGET = "src/dotenv/parser.py"
FIXED = 'self.string = stream.read().removeprefix("\\ufeff")'
BROKEN = "self.string = stream.read()"

ISSUE = (
    "Variables are silently lost when a .env file is saved with a UTF-8 BOM. "
    "Loading a file whose first line is '\\ufeffFOO=bar' yields no usable FOO. "
    "Expected: the BOM is not part of the first key."
)

# A written file larger than this is a mistake or an attack on the host, not a
# patch; the real one is a single line.
MAX_WRITE_BYTES = 1 << 20


def _resolve(relative):
    """Resolve a caller path inside the workspace, refusing to escape it.

    The path arrives from a language model. '../../etc/passwd' is not a
    hypothetical: it is what an unaligned or merely confused policy emits.
    """
    candidate = (WORKSPACE / relative).resolve()
    if candidate != WORKSPACE.resolve() and WORKSPACE.resolve() not in candidate.parents:
        raise ValueError("path escapes the workspace")
    return candidate


def reset(seed=None):
    """Rebuild the workspace at the fixing commit, then revert the fix."""
    if WORKSPACE.exists():
        shutil.rmtree(WORKSPACE)
    WORKSPACE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PRISTINE, WORKSPACE)

    target = WORKSPACE / TARGET
    source = target.read_text()
    if source.count(FIXED) != 1:
        raise RuntimeError("fixture drift: the fixed line is not uniquely present")
    target.write_text(source.replace(FIXED, BROKEN))

    for cached in WORKSPACE.rglob("__pycache__"):
        shutil.rmtree(cached, ignore_errors=True)
    return {"obs": {"issue": ISSUE, "repo": "theskumar/python-dotenv",
                    "entry": TARGET, "tests_visible": False,
                    "sha256": _digest(target)}}


def _digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _parse_with_repo(text):
    """Parse text with the workspace's own parser, freshly imported.

    Reimported every call because the policy edits the module between steps;
    a cached import would grade the previous attempt.
    """
    source = str(WORKSPACE / "src")
    for name in [m for m in sys.modules if m == "dotenv" or m.startswith("dotenv.")]:
        del sys.modules[name]
    sys.path.insert(0, source)
    try:
        from dotenv.parser import parse_stream  # noqa: PLC0415  deliberate reimport
        return list(parse_stream(io.StringIO(text)))
    finally:
        if sys.path and sys.path[0] == source:
            sys.path.pop(0)


def _grade():
    """Upstream's regression expectations, plus the behaviour it must not break."""
    checks = []

    # The reported bug: a BOM must not become part of the first key.
    bindings = _parse_with_repo("\ufeffa=b")
    checks.append(("bom_single", len(bindings) == 1 and bindings[0].key == "a"
                   and bindings[0].value == "b"))

    # Upstream's second case: only the first line carries the BOM.
    bindings = _parse_with_repo("\ufeffa=b\nc=d")
    checks.append(("bom_multi", [(x.key, x.value) for x in bindings] == [("a", "b"), ("c", "d")]))

    # Regression guard: a fix that strips too much, or mangles ordinary files,
    # earns nothing. This is what stops "delete the BOM handling and all input
    # handling with it" from scoring.
    bindings = _parse_with_repo("a=b\n# comment\nc='d e'\n")
    # A comment line is a binding with no key: upstream keeps it so a rewrite
    # can preserve the file, and a repair must keep that too.
    checks.append(("plain_unchanged",
                   [(x.key, x.value) for x in bindings] == [("a", "b"), (None, None), ("c", "d e")]))

    # A BOM in the middle of a file is data, not a mark, and must be left alone.
    bindings = _parse_with_repo("a=b\nc=\ufeffd\n")
    checks.append(("interior_bom_kept",
                   [(x.key, x.value) for x in bindings] == [("a", "b"), ("c", "\ufeffd")]))

    return checks


def step(action):
    op = action.get("op")
    info = {"op": op}
    try:
        if op == "read":
            path = _resolve(action["path"])
            info["content"] = path.read_text()[: 64 * 1024]
            return {"obs": {"bytes": len(info["content"])}, "reward": 0.0,
                    "done": False, "info": info}

        if op == "write":
            content = action["content"]
            if len(content.encode()) > MAX_WRITE_BYTES:
                raise ValueError("write too large")
            path = _resolve(action["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            info["sha256"] = _digest(path)
            return {"obs": {"written": action["path"]}, "reward": 0.0,
                    "done": False, "info": info}

        if op == "test":
            checks = _grade()
            passed = [name for name, ok in checks if ok]
            failed = [name for name, ok in checks if not ok]
            solved = not failed
            info["passed"], info["failed"] = passed, failed
            return {"obs": {"passed": len(passed), "failed": len(failed)},
                    "reward": 1.0 if solved else 0.0, "done": solved, "info": info}

        raise ValueError(f"unknown op {op!r}")
    except Exception as error:  # noqa: BLE001  the policy's mistakes are observations
        # A crash is a step the agent learns from, not a dead episode: an
        # unparseable patch should cost reward, not end the rollout.
        info["error"] = f"{type(error).__name__}: {error}"
        info["traceback"] = traceback.format_exc()[-2048:]
        return {"obs": {"error": info["error"]}, "reward": 0.0, "done": False, "info": info}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            reply = reset(request.get("seed")) if request["op"] == "reset" else step(request["action"])
        except Exception as error:  # noqa: BLE001  protocol-level failure
            reply = {"obs": {"fatal": str(error)}, "reward": 0.0, "done": True, "info": {}}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
