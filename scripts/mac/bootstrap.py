"""Add native-only coordination without affecting Docker entrypoints."""
import importlib
import os

app = importlib.import_module("app").app
if os.environ.get("OPENCUT_MAC_SERVICE") != "media-service" and importlib.util.find_spec("coordinator") is not None:
    from coordinator import NativeGuard
    app.add_middleware(NativeGuard)

if os.environ.get("OPENCUT_MAC_SERVICE") == "face-service":
    @app.post("/unload")
    async def unload_face():
        module = importlib.import_module("app")
        if module._detector is not None:
            module._detector.close()
            module._detector = None
        return {"status": "unloaded"}

# Outermost: reject browser/Host abuse before CORS or model admission.
from local_access import LocalAccessGuard
app.add_middleware(LocalAccessGuard)
