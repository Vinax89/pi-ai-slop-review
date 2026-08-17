import json

# Dependency resolution cases.
import requests


def call_api():
    return requests.get("https://api.example.test")


try:
    import orjson
except ImportError:
    orjson = None


def serialize(data):
    if orjson is not None:
        return orjson.dumps(data)
    return json.dumps(data)
