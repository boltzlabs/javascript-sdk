"""Drive env.py through its JSONL protocol on this machine, no sandbox needed.

Checks the properties the environment is sold on: the bug is real, the reward
needs a real repair, and the obvious ways to cheat or crash it do neither.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ESC = "\\" + "ufeff"  # the six characters as they appear in source text
BROKEN = "self.string = stream.read()"


def main():
    fixture = HERE
    proc = subprocess.Popen(
        [sys.executable, "env.py"], cwd=fixture, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        env=dict(os.environ, DOTENV_WORKSPACE=tempfile.mkdtemp(), PYTHONDONTWRITEBYTECODE="1"))

    def call(request):
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())

    def act(action):
        return call({"op": "step", "action": action})

    results = []

    def check(name, ok, detail=""):
        results.append({"check": name, "pass": bool(ok)})
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  [{detail}]"))

    r = call({"op": "reset", "seed": 1})
    check("reset returns the issue and hides the tests",
          "BOM" in r["obs"].get("issue", "") and r["obs"].get("tests_visible") is False, r)

    r = act({"op": "test"})
    check("bug is present: test fails before any repair", r["reward"] == 0.0 and not r["done"], r)
    check("exactly the two BOM cases fail; ordinary parsing holds",
          sorted(r["info"].get("failed", [])) == ["bom_multi", "bom_single"], r["info"])

    r = act({"op": "read", "path": "src/dotenv/parser.py"})
    source = r["info"].get("content", "")
    check("agent can read the source", BROKEN in source and "removeprefix" not in source)

    r = act({"op": "read", "path": "../../../etc/passwd"})
    check("path escape is refused and the episode survives",
          "escapes the workspace" in r["info"].get("error", "") and not r["done"], r["info"])
    r = act({"op": "read", "path": "tests/test_parser.py"})
    check("the grader's tests are not in the workspace", "error" in r["info"], r["info"])

    over = source.replace(BROKEN, f'self.string = stream.read().replace("{ESC}", "")')
    act({"op": "write", "path": "src/dotenv/parser.py", "content": over})
    r = act({"op": "test"})
    check("over-stripping repair earns no reward",
          r["reward"] == 0.0 and r["info"].get("failed") == ["interior_bom_kept"], r["info"])

    act({"op": "write", "path": "src/dotenv/parser.py", "content": "def broken(:\n"})
    r = act({"op": "test"})
    check("syntax-error patch costs reward but keeps the episode",
          r["reward"] == 0.0 and not r["done"] and "error" in r["info"], r["info"])

    good = source.replace(BROKEN, f'self.string = stream.read().removeprefix("{ESC}")')
    act({"op": "write", "path": "src/dotenv/parser.py", "content": good})
    r = act({"op": "test"})
    check("upstream fix earns reward 1 and ends the episode",
          r["reward"] == 1.0 and r["done"] and not r["info"].get("failed"), r["info"])

    call({"op": "reset", "seed": 2})
    r = act({"op": "test"})
    check("reset restores the bug for the next episode",
          r["reward"] == 0.0 and sorted(r["info"].get("failed", [])) == ["bom_multi", "bom_single"], r["info"])

    r = act({"op": "rm -rf"})
    check("unknown op is an observation, not a crash", "unknown op" in r["info"].get("error", ""), r["info"])

    r = act({"op": "write", "path": "x.txt", "content": "a" * ((1 << 20) + 1)})
    check("oversized write is refused", "too large" in r["info"].get("error", ""), r["info"])

    proc.stdin.close()
    proc.wait()
    passed = sum(1 for x in results if x["pass"])
    print(f"\n{passed}/{len(results)} passed")
    print(json.dumps({"local_functional": results, "passed": passed, "total": len(results)}))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
