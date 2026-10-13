"""Device selection shared by diffusion loading and tests."""

def select_device(torch, requested: str = "auto") -> str:
    if requested not in {"auto", "cpu", "cuda", "mps"}:
        raise ValueError("IMAGE_DEVICE must be auto, cpu, cuda, or mps")
    available = {
        "cpu": True,
        "cuda": torch.cuda.is_available(),
        "mps": hasattr(torch.backends, "mps") and torch.backends.mps.is_available(),
    }
    if requested != "auto":
        if not available[requested]:
            raise RuntimeError(f"IMAGE_DEVICE={requested} is unavailable on this host")
        return requested
    return next(device for device in ("cuda", "mps", "cpu") if available[device])
