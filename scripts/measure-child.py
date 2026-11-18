"""Linux development-only child timer and kernel peak-RSS recorder."""

import json
import os
import resource
import signal
import subprocess
import sys
import time


def timeout(_signal, _frame):
    raise TimeoutError("Measured child exceeded 20 seconds")


def main():
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Peak RSS units in this helper require Linux")
    stdout_path, stderr_path, metric_path, *command = sys.argv[1:]
    if not command:
        raise ValueError("Expected a child command")
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    signal.signal(signal.SIGALRM, timeout)
    with open(stdout_path, "xb") as stdout, open(stderr_path, "xb") as stderr:
        signal.alarm(20)
        child = None
        try:
            start = time.perf_counter_ns()
            child = subprocess.Popen(
                command, stdout=stdout, stderr=stderr, start_new_session=True
            )
            _, status, usage = os.wait4(child.pid, 0)
            elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
            child.returncode = os.waitstatus_to_exitcode(status)
        except BaseException:
            if child is not None and child.returncode is None:
                # Stop ordinary descendants in the isolated session as well.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.wait4(child.pid, 0)
                child.returncode = -signal.SIGKILL
            raise
        finally:
            signal.alarm(0)
    result = {
        "status": child.returncode,
        "signal": -child.returncode if child.returncode < 0 else None,
        "elapsedMs": elapsed_ms,
        "peakRssKiB": usage.ru_maxrss,
    }
    with open(metric_path, "x", encoding="utf8") as metric:
        json.dump(result, metric)
        metric.write("\n")


if __name__ == "__main__":
    main()
