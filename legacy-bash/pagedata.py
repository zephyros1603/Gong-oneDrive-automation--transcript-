#!/usr/bin/env python3
"""Pull a key out of the window.pageData blob on a Gong page (stdin -> stdout).

The conversations page server-renders pageData, which is where the workspace
list lives. Brace-matching beats a regex here because the blob is deeply
nested and contains escaped quotes.
"""
import json
import sys


def page_data(html):
    i = html.find("pageData = {")
    if i == -1:
        raise SystemExit("no pageData on this page (signed out?)")
    start = html.index("{", i)
    depth = 0
    in_str = escaped = False
    for j in range(start, len(html)):
        c = html[j]
        if in_str:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return json.loads(html[start:j + 1])
    raise SystemExit("unterminated pageData")


pd = page_data(sys.stdin.read())
what = sys.argv[1] if len(sys.argv) > 1 else "keys"

if what == "workspaces":
    for w in pd.get("workspaces", []):
        print(f"{w['id']}\t{w['name']}")
elif what == "keys":
    for k in pd:
        print(k)
else:
    print(json.dumps(pd.get(what), indent=2))
