class Deferred(Exception):
    def __init__(self, until, source=None):
        self.until, self.source = until, source


class SourceFailure(Exception):
    def __init__(self, code, retry_after=0, source=None):
        self.code, self.retry_after, self.source = code, retry_after, source


class Superseded(Exception):
    """A newer inventory snapshot owns this check's continuation."""
