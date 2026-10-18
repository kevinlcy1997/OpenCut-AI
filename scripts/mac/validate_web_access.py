"""Probe the running native website boundary without modifying project data."""
import argparse
import json
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def validate(base):
    cases = [
        ("local probe", {}, "GET", 200),
        ("trusted origin", {"Origin": "http://127.0.0.1:3000"}, "GET", 200),
        ("bookmark", {"Sec-Fetch-Site": "none"}, "GET", 200),
        ("external link", {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}, "GET", 200),
        ("rebound host", {"Host": "evil.example:3000"}, "GET", 403),
        ("wrong port", {"Host": "localhost:3001"}, "GET", 403),
        ("hostile origin", {"Origin": "https://evil.example"}, "GET", 403),
        ("null origin", {"Origin": "null"}, "GET", 403),
        ("cross-site resource", {"Sec-Fetch-Site": "cross-site"}, "GET", 403),
        ("other local site", {"Sec-Fetch-Site": "same-site", "Referer": "http://localhost:3001/"}, "GET", 403),
        ("hostile form", {"Origin": "https://evil.example"}, "POST", 403),
        ("originless form", {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}, "POST", 403),
    ]
    results = []
    for path in ("/", "/api/health"):
        for name, headers, method, expected in cases:
            request = Request(base + path, headers=headers, method=method)
            try:
                with urlopen(request, timeout=15) as response:
                    actual = response.status
                    cache_control = response.headers.get("Cache-Control", "")
            except HTTPError as error:
                actual = error.code
                cache_control = error.headers.get("Cache-Control", "")
                error.close()
            results.append({"case": name, "path": path, "method": method, "expected": expected,
                            "actual": actual, "passed": actual == expected and (expected != 403 or cache_control == "no-store")})
    return {"checked_at": datetime.now(timezone.utc).isoformat(), "base": base,
            "scope": "native website page and API HTTP boundary; no project mutations; not a full security audit",
            "passed": all(row["passed"] for row in results), "checks": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:3000")
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    report = validate(args.base.rstrip("/"))
    from pathlib import Path
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    print(f'{sum(row["passed"] for row in report["checks"])}/{len(report["checks"])} checks passed')
    raise SystemExit(0 if report["passed"] else 1)
