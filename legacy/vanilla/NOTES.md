# The vanilla build

What this app was before the Next.js migration: `serve.js`, a single
1,229-line `node:http` if-chain, serving five hand-written HTML pages with
inline `<script type="module">` and no build step at all.

It is kept for reference, not for running — it would not work now anyway,
since the storage layer it imported (`projects.js`, `settings.js`, `runs.js`)
has moved to SQLite and `startChatRun` has moved to `core/chat.js`.

Worth reading for two things:

- `ui/index.html` holds the original progress scene, including the packet
  animation and the trimmed-artwork coordinates that `components/PullScene.jsx`
  inherited.
- `serve.js` is the record of how the Gong API was worked out, though the
  durable parts of that have moved into `core/gong/`.

Safe to delete once nobody wants either.
