import fcntl
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time

from friend_circle.config import Config
from friend_circle.credentials import Credentials
from friend_circle.service import Federation


def mapped_actor(service, username, kind, controller=None):
    actor = service.store.one(
        "SELECT id,kind,controller FROM actors WHERE username=?", (username,)
    )
    if actor is None:
        return service.identity.create(username, kind, controller)["id"]
    if actor["kind"] != kind or actor["controller"] != controller:
        raise ValueError(f"identity {username} already has a different role")
    return actor["id"]


def write_private(path, value):
    temporary = path.with_suffix(".new")
    temporary.unlink(missing_ok=True)
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(value + "\n")
    temporary.replace(path)


def run(host):
    processes = []
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)

    try:
        commands = [
            ["gunicorn", "-b", os.environ.get("FC_PUBLIC_BIND", "0.0.0.0:5090"), "-w", "2", "--threads", "8",
             "--timeout", "60", "--no-control-socket", "friend_circle.wsgi:public_app()"],
            ["gunicorn", "-b", f"unix:{host / 'gateway.sock'}", "-m", "0o077", "-w", "2",
             "--threads", "8", "--timeout", "60", "--no-control-socket", "friend_circle.wsgi:private_app()"],
            ["gunicorn", "-b", f"unix:{host / 'mcp.sock'}", "-m", "0o077", "-w", "1",
             "--threads", "4", "--timeout", "60", "--no-control-socket", "friend_circle.wsgi:mcp_app()"],
            ["friend-circle", "--origin", os.environ["FC_ORIGIN"],
             "--state", os.environ["FC_STATE"], "worker"],
        ]
        for command in commands:
            processes.append(subprocess.Popen(command))
        while not stopping:
            if any(process.poll() is not None for process in processes):
                return 1
            time.sleep(0.5)
        return 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        deadline = time.monotonic() + 25
        for process in processes:
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    state = Path(os.environ["FC_STATE"])
    host = Path(os.environ["FC_HOST_DIR"])
    uid, gid = int(os.environ["FC_UID"]), int(os.environ["FC_GID"])
    if uid <= 0 or gid <= 0:
        raise ValueError("use non-root Friend Circle UID and GID")
    if os.geteuid() == 0:
        for directory in (state, host):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chown(directory, uid, gid)
            directory.chmod(0o700)
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    os.umask(0o077)
    if os.environ["FC_HUMAN"] == os.environ["FC_AI"]:
        raise ValueError("person and AI must have distinct handles")
    config = Config(os.environ["FC_ORIGIN"], state)
    with (host / "server.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        service = Federation(config)
        mapping = host / "principal"
        if mapping.exists():
            actor = service.store.one(
                "SELECT id FROM actors WHERE username=? AND kind='person'", (os.environ["FC_HUMAN"],)
            )
            if actor is None or actor["id"] != mapping.read_text().strip():
                raise ValueError("the configured person differs from the existing Lumi identity")
        person = mapped_actor(service, os.environ["FC_HUMAN"], "person")
        ai = mapped_actor(service, os.environ["FC_AI"], "ai", person)
        mcp_token = host / "mcp-token"
        credentials = Credentials(service.store)
        if mcp_token.exists():
            _, actor, scopes = credentials.verify(mcp_token.read_text().strip())
            if actor != ai or scopes != {"read", "post", "interact"}:
                raise ValueError("the configured AI differs from the existing Lumi MCP identity")
        else:
            for old in credentials.list(ai):
                if old["label"] == "Lumi Friend Circle" and not old["revoked"]:
                    credentials.revoke(old["id"])
            issued = credentials.issue(ai, ("read", "post", "interact"), "Lumi Friend Circle")
            write_private(mcp_token, issued["token"])
        token = host / "gateway-token"
        if not token.exists():
            write_private(token, secrets.token_urlsafe(48))
        write_private(mapping, person)
        os.environ["FC_GATEWAY_TOKEN_FILE"] = str(token)
        (host / "gateway.sock").unlink(missing_ok=True)
        (host / "mcp.sock").unlink(missing_ok=True)
        return run(host)


if __name__ == "__main__":
    raise SystemExit(main())
