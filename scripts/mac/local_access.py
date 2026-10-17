"""Native-only browser access boundary; local processes are not an auth boundary."""
from urllib.parse import urlsplit
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

ORIGINS = frozenset({"http://127.0.0.1:3000", "http://localhost:3000"})


class LocalAccessGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        try:
            host = urlsplit("//" + headers.get("host", ""))
            allowed_host = host.hostname in {"localhost", "127.0.0.1", "::1"} and not host.username and not host.password and not (host.path or host.query or host.fragment)
            expected_port = (scope.get("server") or (None, None))[1]
            allowed_host = allowed_host and (expected_port is None or (host.port or 80) == expected_port)
        except ValueError:
            allowed_host = False
        origin = headers.get("origin")
        allowed_origin = origin is None or origin in ORIGINS
        # Cross-site subresources can omit Origin; do not rely only on CORS.
        try:
            referer = urlsplit(headers.get("referer", ""))
            referer_origin = f"{referer.scheme}://{referer.netloc}"
        except ValueError:
            referer_origin = ""
        allowed_site = origin in ORIGINS or referer_origin in ORIGINS or headers.get("sec-fetch-site") != "cross-site"
        if not (allowed_host and allowed_origin and allowed_site):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await JSONResponse({"detail": "Native service access denied"}, status_code=403)(scope, receive, send)
            return
        await self.app(scope, receive, send)
