"""Rehearse native PostgreSQL backup in a disposable, network-isolated container.

Never restores into the running database. Dump bytes remain in private runtime storage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def schema(command):
    raw = run(command + ["pg_dump", "-U", "opencut", "-d", "opencut", "--schema-only", "--no-owner", "--no-privileges"], text=True)
    # PostgreSQL emits a random psql safety marker, unrelated to schema contents.
    return re.sub(r"^\\(?:un)?restrict .*\n", "", raw, flags=re.MULTILINE).encode()


def table_manifest(command, database="opencut"):
    def query(sql):
        return run(command + ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "opencut", "-d", database, "-c", sql], text=True).strip()
    names = json.loads(query("SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]') FROM pg_tables WHERE schemaname='public'"))
    result = []
    for name in names:
        identifier = '"' + name.replace('"', '""') + '"'
        # Compare rows without logging their contents or depending on physical row order.
        value = json.loads(query("SELECT json_build_object('rows', count(*), 'digest', md5(coalesce(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)), ''))) FROM public." + identifier + " t"))
        result.append({"table": name, **value})
    return result


def validate(report_path):
    state = ROOT / ".mac-runtime"
    compose = ["docker", "compose", "-p", "opencut-mac", "-f", str(state / "compose.json")]
    container = run(compose + ["ps", "-q", "db"], text=True).strip()
    if not container or "\n" in container:
        raise RuntimeError("Expected exactly one running native database")
    image = run(["docker", "inspect", "--format", "{{.Image}}", container], text=True).strip()
    source = ["docker", "exec", container]
    name = "opencut-recovery-" + uuid.uuid4().hex[:12]
    destination = ["docker", "exec", name]
    private = state / "validation" / name
    private.mkdir(parents=True, mode=0o700)
    os.chmod(private, 0o700)
    dump = private / "database.dump"
    before = table_manifest(source)
    original_schema = schema(source)
    # Use the exact running image; no image download, host ports or persistent volumes.
    started = False
    try:
        with dump.open("xb") as output:
            os.chmod(dump, 0o600)
            subprocess.run(source + ["pg_dump", "-U", "opencut", "-d", "opencut", "--format=custom"], stdout=output, stderr=subprocess.PIPE, check=True)
        run(["docker", "run", "--detach", "--rm", "--name", name, "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=256m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_USER=opencut", "-e", "POSTGRES_DB=opencut", image])
        started = True
        deadline = time.monotonic() + 45
        while (run(destination + ["cat", "/proc/1/comm"], text=True).strip() != "postgres" or subprocess.run(destination + ["pg_isready", "-U", "opencut", "-d", "opencut"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode):
            if time.monotonic() > deadline:
                raise RuntimeError("Isolated recovery database did not become ready")
            time.sleep(0.25)
        with dump.open("rb") as source_dump:
            subprocess.run(["docker", "exec", "-i", name, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "-U", "opencut", "-d", "opencut"], stdin=source_dump, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        recovered = table_manifest(destination)
        recovered_schema = schema(destination)
        after = table_manifest(source)
        # The live database may be empty. Exercise actual data recovery using only
        # synthetic rows in the disposable instance, then a second disposable DB.
        probe_sql = """CREATE TABLE public.opencut_recovery_probe
            (id integer PRIMARY KEY, label text, payload jsonb, raw bytea, amount numeric);
            INSERT INTO public.opencut_recovery_probe VALUES
            (1, 'Unicode 香港', '{"nested":[1,true,null]}', decode('0001ff','hex'), 12.345),
            (2, NULL, NULL, NULL, NULL),
            (3, 'line one' || chr(10) || 'line two', '[]', decode('','hex'), -0.001);"""
        run(destination + ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "opencut", "-d", "opencut", "-c", probe_sql])
        seeded = table_manifest(destination)
        probe_dump = private / "synthetic-probe.dump"
        with probe_dump.open("xb") as output:
            os.chmod(probe_dump, 0o600)
            subprocess.run(destination + ["pg_dump", "-U", "opencut", "-d", "opencut", "--format=custom"], stdout=output, stderr=subprocess.PIPE, check=True)
        run(destination + ["createdb", "-U", "opencut", "recovery_probe"])
        with probe_dump.open("rb") as source_dump:
            subprocess.run(["docker", "exec", "-i", name, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "-U", "opencut", "-d", "recovery_probe"], stdin=source_dump, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        synthetic_matches = seeded == table_manifest(destination, "recovery_probe")
        passed = before == recovered == after and original_schema == recovered_schema and synthetic_matches
        report = {"passed": passed, "image_id": image, "dump_bytes": dump.stat().st_size,
                  "dump_sha256": hashlib.sha256(dump.read_bytes()).hexdigest(),
                  "schema_sha256": hashlib.sha256(original_schema).hexdigest(),
                  "schema_matches": original_schema == recovered_schema,
                  "table_count": len(before), "row_count": sum(row["rows"] for row in before),
                  "table_counts_and_row_digests_match": before == recovered,
                  "source_unchanged_during_check": before == after,
                  "synthetic_probe_rows": 3, "synthetic_row_recovery_matches": synthetic_matches,
                  "synthetic_types": ["Unicode/newline text", "JSONB", "bytea", "numeric", "SQL NULL"],
                  "isolation": "same image ID, network none, no host ports, tmpfs database, no live restore",
                  "limitations": ["Point-in-time rehearsal; concurrent source writes cause a conservative failure", "Does not verify browser project/media storage or cross-version migrations", "Server data coverage is limited to rows present at measurement time"]}
        Path(report_path).write_text(json.dumps(report, indent=2) + "\n")
        if not passed:
            raise RuntimeError("Recovery comparison failed; inspect report and retain private dump")
        print(f"Recovery verified: {len(before)} tables, {report['row_count']} rows; private dump retained in .mac-runtime/validation/{name}")
    finally:
        if started:
            run(["docker", "rm", "--force", name])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    validate(args.report)
