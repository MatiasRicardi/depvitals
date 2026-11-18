"""Linux-only regression supervisor; adopts and reaps the authored grandchild."""

import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def wait_until(probe, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        time.sleep(0.02)
    raise TimeoutError("Authored process did not reach the expected state")


def gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def kill_owned(fd):
    try:
        signal.pidfd_send_signal(fd, signal.SIGKILL)
    except ProcessLookupError:
        pass


def main():
    mode, helper, node, directory = sys.argv[1:]
    assert mode in ("alarm", "sigterm")
    # PR_SET_CHILD_SUBREAPER is test-only: the helper still reaps its direct child.
    assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
    root = Path(directory)
    pid_path = root / "pids.json"
    code = '''
const { spawn } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
descendant.once('spawn', () => {
  writeFileSync(process.argv[1] + '.tmp', JSON.stringify({ child: process.pid, descendant: descendant.pid }));
  renameSync(process.argv[1] + '.tmp', process.argv[1]);
});
setInterval(() => {}, 1000);
'''
    command = [sys.executable, "-I", helper, str(root / "stdout"),
               str(root / "stderr"), str(root / "metric.json"), node, "-e", code, str(pid_path)]
    helper_process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    owned = []
    descendant_reaped = False
    pids = None
    try:
        # Open handles while all processes are alive; failure cleanup cannot target a reused PID.
        owned.append(os.pidfd_open(helper_process.pid))
        wait_until(lambda: pid_path.exists())
        pids = json.loads(pid_path.read_text())
        for pid in pids.values():
            owned.append(os.pidfd_open(pid))
        assert os.getpgid(pids["child"]) == pids["child"]
        assert os.getpgid(pids["descendant"]) == pids["child"]
        if mode == "sigterm":
            signal.pidfd_send_signal(owned[0], signal.SIGTERM)
        stdout, stderr = helper_process.communicate(timeout=25)
        assert helper_process.returncode == 1
        assert stdout == b""
        expected = b"exceeded 20 seconds" if mode == "alarm" else b"received SIGTERM"
        assert expected in stderr, stderr
        assert not (root / "metric.json").exists()
        assert (root / "stdout").read_bytes() == b""
        assert (root / "stderr").read_bytes() == b""
        assert gone(pids["child"]), "Helper failed to reap the direct child"
        def reap_descendant():
            reaped, status = os.waitpid(pids["descendant"], os.WNOHANG)
            return (reaped, status) if reaped else None

        reaped, status = wait_until(reap_descendant)
        assert reaped == pids["descendant"], "Descendant survived helper cleanup"
        descendant_reaped = True
        assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL
        assert gone(pids["descendant"])
        for fd in owned:
            os.close(fd)
        owned.clear()
        print(json.dumps({"childGone": True, "descendantGone": True, "successMetric": False}))
    finally:
        # PID handles remain tied to these exact processes even after a successful reap.
        for fd in reversed(owned):
            kill_owned(fd)
            os.close(fd)
        helper_process.communicate(timeout=5)
        if pids is not None:
            for name, pid in pids.items():
                if name == "descendant" and descendant_reaped:
                    continue
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass


if __name__ == "__main__":
    main()
