import json

# Pair 5: missing dependency vs optional/platform dependency.
# Member A (expected: confirmed) — imported but never declared anywhere.
import requests


def call_api():
    return requests.get("https://api.example.test")


# Member B (expected: dismissed) — optional import with graceful degradation.
try:
    import orjson
except ImportError:
    orjson = None


def serialize(data):
    if orjson is not None:
        return orjson.dumps(data)
    return json.dumps(data)
