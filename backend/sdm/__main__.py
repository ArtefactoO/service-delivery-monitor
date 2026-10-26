import argparse
import json
import os
from pathlib import Path
import secrets

from .config import load_settings
from .contracts import DeliveryEvent
from .store import Store


def initialize(settings):
    store = Store(settings.database_url)
    store.initialize()
    if settings.bootstrap_registry:
        fixture = json.loads(Path(settings.bootstrap_registry).read_text())
        store.catalog(fixture["services"], fixture["revision"], settings.teams, source="bootstrap")
    store.engine.dispose()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve", "init-db", "schema", "local"])
    args = parser.parse_args()
    if args.command == "schema":
        print(json.dumps(DeliveryEvent.model_json_schema(), ensure_ascii=False, indent=2))
        return
    if args.command == "local":
        directory = Path("/run/credentials")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        for name in ["reader", "publisher", "build"]:
            target = directory / name
            if not target.exists():
                target.write_text(secrets.token_urlsafe(48))
                target.chmod(0o600)
        initialize(load_settings())
    if args.command == "init-db":
        initialize(load_settings())
        return
    import uvicorn
    uvicorn.run("sdm.api:create_app", factory=True, host="0.0.0.0", port=8080, access_log=False)


if __name__ == "__main__":
    main()
