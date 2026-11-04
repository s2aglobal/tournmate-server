#!/usr/bin/env python3
"""Profile photo rules checks (storage.rules, players photo fields).

Runs against the Firestore + Storage emulators (project demo-tm) started by
run-photos.sh. Prints one PASS/FAIL line per case.
"""
import json
import urllib.error
import urllib.parse
import urllib.request

from fsrest import Ts, merge, set_doc, tok

STORAGE = "http://127.0.0.1:9189/v0/b/demo-tm.appspot.com/o"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\xff\xd9"

failures = 0


def expect(got, want, name):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'} {name} ({got}{'' if ok else f', want {want}'})")


def sreq(method, url, uid, body=None, content_type=None, headers=None):
    r = urllib.request.Request(url, data=body, method=method)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    if content_type:
        r.add_header("Content-Type", content_type)
    if uid:
        r.add_header("Authorization", "Bearer " + ("owner" if uid == "owner" else tok(uid)))
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def upload(path, uid, body=JPEG, content_type="image/jpeg"):
    """Firebase SDK multipart upload (putData with metadata), as the apps do."""
    boundary = "tmboundary"
    meta = json.dumps({"name": path, "contentType": content_type}).encode()
    data = (f"--{boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n".encode() + meta
            + f"\r\n--{boundary}\r\nContent-Type: {content_type}\r\n\r\n".encode() + body
            + f"\r\n--{boundary}--".encode())
    q = urllib.parse.urlencode({"name": path})
    return sreq("POST", f"{STORAGE}?{q}", uid, data, f"multipart/related; boundary={boundary}",
                {"X-Goog-Upload-Protocol": "multipart"})


def obj(path):
    return f"{STORAGE}/{urllib.parse.quote(path, safe='')}"


def read(path, uid):
    return sreq("GET", obj(path), uid)


def remove(path, uid):
    return sreq("DELETE", obj(path), uid)


# ─── Storage: profilePhotos/{uid}/{file} ─────────────────
print("# storage.rules")
OWN = "profilePhotos/u1/11111111-aaaa.jpg"
expect(upload(OWN, "u1"), 200, "owner uploads JPEG to own folder")
expect(upload(OWN, "u1"), 200, "owner overwrites own file")
expect(upload("profilePhotos/u1/x.jpg", None), 403, "signed-out upload rejected")
expect(upload("profilePhotos/u2/x.jpg", "u1"), 403, "upload to another user's folder rejected")
expect(upload("profilePhotos/u1/x.png", "u1", content_type="image/png"), 403, "PNG rejected")
expect(upload("profilePhotos/u1/x.jpg", "u1", content_type="application/octet-stream"), 403, "untyped upload rejected")
expect(upload("profilePhotos/u1/big.jpg", "u1", body=b"\xff" * (2 * 1024 * 1024)), 403, "2 MB rejected")
expect(upload("profilePhotos/u1/ok.jpg", "u1", body=b"\xff" * (2 * 1024 * 1024 - 1)), 200, "just under 2 MB accepted")
expect(upload("profilePhotos/u1/a/b.jpg", "u1"), 403, "nested path rejected")
expect(upload("profilePhotos/x.jpg", "u1"), 403, "file directly under profilePhotos/ rejected")
expect(upload("avatars/u1/x.jpg", "u1"), 403, "other top-level path rejected")
expect(upload("u1.jpg", "u1"), 403, "bucket root rejected")
expect(read(OWN, "u2"), 200, "signed-in user reads someone's photo")
expect(read(OWN, "u1"), 200, "owner reads own photo")
expect(read(OWN, None), 403, "signed-out read rejected")
expect(remove(OWN, "u1"), 403, "owner can't delete (server only)")
expect(remove(OWN, "u2"), 403, "other user can't delete")
expect(read(OWN, "u1"), 200, "file still there")

# ─── Firestore: photo fields are server-only ─────────────
print("# players photo fields")
BASE = {"firebaseUid": "u1", "name": "One", "email": "u1@x.com", "elo": 1200, "streak": 0,
        "genderRaw": "male", "avatarId": "fox"}
URL = "https://firebasestorage.googleapis.com/v0/b/b/o/x?alt=media&token=t"
expect(set_doc("players/PC1", "u1", {**BASE, "photoURL": URL}), 403, "create with photoURL rejected")
expect(set_doc("players/PC2", "u1", {**BASE, "photoPath": OWN}), 403, "create with photoPath rejected")
expect(set_doc("players/PC3", "u1", {**BASE, "photoUpdatedAt": Ts("2026-11-01T10:00:00Z")}), 403,
       "create with photoUpdatedAt rejected")
expect(set_doc("players/PC4", "u1", {**BASE, "photoURL": None}), 403, "create with photoURL null rejected")
expect(set_doc("players/P1", "u1", BASE), 200, "create without photo fields (unchanged flow)")
expect(merge("players/P1", "u1", {"photoURL": URL}), 403, "client sets photoURL rejected")
expect(merge("players/P1", "u1", {"photoPath": OWN}), 403, "client sets photoPath rejected")
expect(merge("players/P1", "u1", {"photoUpdatedAt": Ts("2026-11-01T10:00:00Z")}), 403,
       "client sets photoUpdatedAt rejected")

# Server has set a photo (admin bypass).
WITH_PHOTO = {**BASE, "photoURL": URL, "photoPath": OWN, "photoUpdatedAt": Ts("2026-11-01T10:00:00Z")}
expect(set_doc("players/P1", "owner", WITH_PHOTO), 200, "seed: server sets photo")
expect(merge("players/P1", "u1", {"avatarId": "owl"}), 200, "avatar change keeps working with a photo set")
expect(merge("players/P1", "u1", {"name": "Renamed", "genderRaw": "male", "avatarId": "owl"}), 200,
       "full profile merge without photo fields passes")
expect(merge("players/P1", "u1", {"name": "Again", "photoURL": URL}), 200,
       "merge echoing the unchanged photoURL passes")
expect(merge("players/P1", "u1", {"photoURL": None}), 403, "client clears photoURL rejected")
expect(merge("players/P1", "u1", {"photoURL": URL + "2"}), 403, "client swaps photoURL rejected")
expect(set_doc("players/P1", "u1", {**BASE, "name": "Overwrite"}), 403,
       "full overwrite dropping the photo fields rejected")
expect(merge("players/P1", "u2", {"avatarId": "cat"}), 403, "another user can't edit (unchanged)")

print(f"# {failures} failed")
