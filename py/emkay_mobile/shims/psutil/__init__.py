"""Stand-in for psutil: a browser has no process table; report plausible values."""
import time
from collections import namedtuple

_vm = namedtuple("svmem", "total available percent used free")
_du = namedtuple("sdiskusage", "total used free percent")
_boot = time.time()


def cpu_percent(interval=None, percpu=False):
    return [0.0] if percpu else 0.0


def cpu_count(logical=True):
    return 1


def virtual_memory():
    return _vm(2 * 1024 ** 3, 1024 ** 3, 50.0, 1024 ** 3, 1024 ** 3)


def disk_usage(path="/"):
    return _du(1024 ** 3, 0, 1024 ** 3, 0.0)


def boot_time():
    return _boot


def sensors_battery():
    return None


class Process:
    def __init__(self, pid=None):
        self.pid = pid or 1

    def memory_info(self):
        return namedtuple("pmem", "rss vms")(0, 0)

    def name(self):
        return "emkay-mobile"


def pids():
    return [1]


def process_iter(*a, **k):
    return iter([Process()])
