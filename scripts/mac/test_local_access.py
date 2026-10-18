import unittest
from local_access import LocalAccessGuard


class LocalAccessTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, headers, kind="http"):
        messages = []
        self.called = False
        async def app(scope, receive, send):
            self.called = True
            await send({"type": "http.response.start", "status": 204})
        async def receive(): return {"type": "http.request", "body": b""}
        async def send(message): messages.append(message)
        await LocalAccessGuard(app)({"type": kind, "method": "POST", "path": "/load", "server": ("127.0.0.1", 8421), "headers": [(key.encode(), value.encode()) for key, value in headers.items()]}, receive, send)
        return messages

    async def test_trusted_editor_origin_and_internal_calls_work(self):
        for origin in (None, "http://127.0.0.1:3000", "http://localhost:3000"):
            headers = {"host": "127.0.0.1:8421"}
            if origin:
                headers["origin"] = origin
                headers["sec-fetch-site"] = "cross-site"
            await self.request(headers)
            self.assertTrue(self.called)

    async def test_localhost_media_subresource_can_use_its_trusted_referer(self):
        await self.request({"host": "127.0.0.1:8421", "sec-fetch-site": "cross-site", "referer": "http://localhost:3000/editor/project"})
        self.assertTrue(self.called)

    async def test_other_origins_are_denied_before_route_execution(self):
        for origin in ("https://attacker.example", "null", "http://127.0.0.1:5173"):
            messages = await self.request({"host": "127.0.0.1:8421", "origin": origin})
            self.assertFalse(self.called)
            self.assertEqual(messages[0]["status"], 403)

    async def test_rebinding_and_cross_site_subresources_are_denied(self):
        for headers in ({"host": "attacker.example:8421"}, {"host": "127.0.0.1:8421", "sec-fetch-site": "cross-site"}, {"host": "localhost:9999"}, {"host": "bad:invalid"}, {"host": "localhost:8421/path"}, {"host": "127.0.0.1:8421", "sec-fetch-site": "cross-site", "referer": "http://[invalid"}):
            await self.request(headers)
            self.assertFalse(self.called)

    async def test_cross_site_websocket_is_closed_before_accept(self):
        messages = await self.request({"host": "127.0.0.1:8421", "origin": "https://attacker.example"}, kind="websocket")
        self.assertFalse(self.called)
        self.assertEqual(messages, [{"type": "websocket.close", "code": 1008}])

if __name__ == "__main__": unittest.main()
