"""Stand-in for pexpect: there is no pty in a browser."""
class ExceptionPexpect(Exception):
    pass


EOF = TIMEOUT = None


def spawn(*a, **k):
    raise ExceptionPexpect("no pty in the browser")


run = spawn
