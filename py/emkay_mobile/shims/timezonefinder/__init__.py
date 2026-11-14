"""Stand-in for timezonefinder: the browser already knows its own time zone.

Coordinates are ignored; the answer is the zone the page reports
(set from Intl.DateTimeFormat by the worker into EMKAY_TZ).
"""
import os


class TimezoneFinder:
    def __init__(self, *a, **k):
        pass

    def timezone_at(self, *, lng=None, lat=None, **k):
        return os.environ.get("EMKAY_TZ", "UTC")

    certain_timezone_at = timezone_at
    timezone_at_land = timezone_at
    closest_timezone_at = timezone_at


class TimezoneFinderL(TimezoneFinder):
    pass


def timezone_at(*, lng=None, lat=None, **k):
    return TimezoneFinder().timezone_at(lng=lng, lat=lat)
