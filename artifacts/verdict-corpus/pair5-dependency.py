import json

# Dependency resolution cases.
import surely_missing_requests


def call_api():
    return surely_missing_requests.get("https://api.example.test")


try:
    import orjson
except ImportError:
    orjson = None


def serialize(data):
    if orjson is not None:
        return orjson.dumps(data)
    return json.dumps(data)
