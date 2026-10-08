"""Exception hierarchy for Praetor SDK errors."""


class PraetorError(Exception):
    """Base exception for all Praetor SDK errors.

    HTTP context is attached by the transport layer when an error is mapped
    from a response, so callers can inspect status/code without parsing text.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.status: int | None = None
        self.status_code: int | None = None
        self.code: str | None = None
        self.details: object | None = None
        self.body: str | None = None


# Backward-compatibility alias
CommanderError = PraetorError


class AuthenticationError(PraetorError):
    """401 Unauthorized — invalid or missing API key."""



class RateLimitError(PraetorError):
    """429 Too Many Requests — rate limit exceeded."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class NotFoundError(PraetorError):
    """404 Not Found — resource does not exist."""


class ServerError(PraetorError):
    """5xx Server Error — Praetor server issue."""


class ConnectionError(PraetorError):
    """Failed to connect to Praetor server after all retries."""


class TimeoutError(PraetorError):
    """Request timed out."""


class ValidationError(PraetorError):
    """Request validation failed (400 Bad Request)."""


def map_status_to_error(status_code: int, body_text: str) -> PraetorError:
    """Map an HTTP status code to the appropriate PraetorError subclass.

    Args:
        status_code: The HTTP response status code.
        body_text: The response body text (usually a JSON error message).

    Returns:
        A PraetorError instance appropriate for the status code.
    """
    if status_code == 400:
        return ValidationError(body_text)
    if status_code == 401:
        return AuthenticationError(body_text)
    if status_code == 404:
        return NotFoundError(body_text)
    if status_code == 413:
        return ValidationError(body_text)
    if status_code == 429:
        return RateLimitError(body_text)
    if 500 <= status_code < 600:
        return ServerError(body_text)
    return PraetorError(f"HTTP {status_code}: {body_text}")

