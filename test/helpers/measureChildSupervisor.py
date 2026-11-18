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


def signal_owned(fd, number):
    try:
        signal.pidfd_send_signal(fd, number)
    except ProcessLookupError:
        pass


def reap_adopted():
    """Stop any unrecorded adopted children and drain zombies until ECHILD."""
    deadline = time.monotonic() + 5
    children_file = Path(f"/proc/self/task/{os.getpid()}/children")
    while True:
        try:
            reaped, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if reaped:
            continue
        for child in children_file.read_text().split():
            fd = None
            try:
                fd = os.pidfd_open(int(child))
                # The handle is stable; verify ownership before signaling an enumerated PID.
                stat = Path(f"/proc/{child}/stat").read_text().rsplit(")", 1)[1].split()
                if int(stat[1]) == os.getpid():
                    signal_owned(fd, signal.SIGKILL)
            except (ProcessLookupError, FileNotFoundError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        if time.monotonic() >= deadline:
            raise TimeoutError("Adopted children did not terminate")
        time.sleep(0.02)


def cleanup_helper(helper_process, owned):
    try:
        if helper_process.poll() is None:
            # Let the helper terminate its isolated group even if PID discovery never finished.
            if owned:
                signal_owned(owned[0], signal.SIGTERM)
            else:
                helper_process.terminate()
        try:
            helper_process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            if owned:
                signal_owned(owned[0], signal.SIGKILL)
            else:
                helper_process.kill()
            helper_process.communicate(timeout=5)
    finally:
        for fd in reversed(owned[1:]):
            signal_owned(fd, signal.SIGKILL)
        for fd in owned:
            os.close(fd)
        owned.clear()
        reap_adopted()



def main():
    mode, helper, node, directory = sys.argv[1:]
    assert mode in ("alarm", "sigterm", "missing-pids", "missing-pids-stopped-helper")
    missing_pids = mode.startswith("missing-pids")
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
    observed_path = root / "observed-pids.json" if missing_pids else pid_path
    command = [sys.executable, "-I", helper, str(root / "stdout"),
               str(root / "stderr"), str(root / "metric.json"), node, "-e", code, str(observed_path)]
    helper_process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    owned = []
    pids = None
    try:
        # Open handles while all processes are alive; failure cleanup cannot target a reused PID.
        owned.append(os.pidfd_open(helper_process.pid))
        if missing_pids:
            wait_until(lambda: observed_path.exists())
            if mode == "missing-pids-stopped-helper":
                signal_owned(owned[0], signal.SIGSTOP)
            try:
                wait_until(lambda: pid_path.exists(), seconds=0.2)
            except TimeoutError:
                pass
            else:
                raise AssertionError("Authored missing PID discovery unexpectedly succeeded")
        else:
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
            assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL
            assert gone(pids["descendant"])
            for fd in owned:
                os.close(fd)
            owned.clear()
            print(json.dumps({"childGone": True, "descendantGone": True, "successMetric": False}))
    finally:
        cleanup_helper(helper_process, owned)
    if missing_pids:
        assert helper_process.returncode == (1 if mode == "missing-pids" else -signal.SIGKILL)
        assert not (root / "metric.json").exists()
        observed = json.loads(observed_path.read_text())
        assert gone(observed["child"])
        assert gone(observed["descendant"])
        try:
            os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            pass
        else:
            raise AssertionError("Subreaper still has adopted children")
        print(json.dumps({"childGone": True, "descendantGone": True,
                          "successMetric": False, "discoveryFailed": True, "noChildren": True}))


if __name__ == "__main__":
    main()
