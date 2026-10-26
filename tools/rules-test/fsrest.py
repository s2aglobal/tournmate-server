"""Firestore emulator REST helpers for the rules / trigger checks (project demo-tm)."""
import base64
import json
import urllib.error
import urllib.request

PROJECT = "demo-tm"
D = f"projects/{PROJECT}/databases/(default)/documents"
BASE = "http://127.0.0.1:8089/v1"


def tok(uid):
    e = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return e({"alg": "none", "typ": "JWT"}) + "." + e({
        "sub": uid, "user_id": uid, "iss": f"https://securetoken.google.com/{PROJECT}",
        "aud": PROJECT, "auth_time": 1, "iat": 1, "exp": 9999999999,
        "firebase": {"sign_in_provider": "password"}}) + "."


class Ts(str):
    pass


def val(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, Ts):
        return {"timestampValue": str(v)}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [val(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: val(x) for k, x in v.items()}}}
    raise TypeError(v)


def fields(d):
    return {k: val(v) for k, v in d.items()}


def req(method, url, uid, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if uid:
        r.add_header("Authorization", "Bearer " + ("owner" if uid == "owner" else tok(uid)))
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def set_doc(path, uid, data):
    """setData without merge (full overwrite / create)."""
    return req("PATCH", f"{BASE}/{D}/{path}", uid, {"fields": fields(data)})


def merge(path, uid, data):
    """setData(merge: true) / update(map): only the given fields."""
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in data)
    return req("PATCH", f"{BASE}/{D}/{path}?{mask}", uid, {"fields": fields(data)})


def commit(uid, writes):
    return req("POST", f"{BASE}/{D}:commit", uid, {"writes": writes})


def array_op(path, uid, field, op, values):
    """FieldValue.arrayUnion / arrayRemove."""
    kind = "appendMissingElements" if op == "union" else "removeAllFromArray"
    return commit(uid, [{
        "update": {"name": f"{D}/{path}", "fields": {}},
        "updateMask": {"fieldPaths": []},
        "updateTransforms": [{"fieldPath": field, kind: {"values": [val(v) for v in values]}}],
        "currentDocument": {"exists": True},
    }])


def delete(path, uid):
    return req("DELETE", f"{BASE}/{D}/{path}", uid)


def get(path, uid):
    return req("GET", f"{BASE}/{D}/{path}", uid)
