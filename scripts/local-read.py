"""Read the local catalog from inside the app container without exposing its token."""
import json
import urllib.request
from pathlib import Path

token = Path("/run/credentials/reader").read_text().strip()
request = urllib.request.Request("http://127.0.0.1:8080/api/v1/services",
                                 headers={"Authorization": "Bearer " + token})
with urllib.request.urlopen(request, timeout=5) as response:
    print(json.dumps(json.load(response), indent=2))
