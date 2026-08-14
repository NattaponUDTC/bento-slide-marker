# bento-classroom-server

A tiny no-login web app for using `bento/slides` in a school lab: a teacher or
student opens the site, clicks **สร้างงานใหม่** (New work), and gets a private
URL for their own deck. The deck autosaves itself back to the server every few
seconds; the gallery lists every work ever created so anyone can reopen and
keep going. There is no login and no delete — this is intentionally a low-
friction classroom tool, not a multi-tenant SaaS.

## Run it

```sh
# once: build the single-file editor this server hands out (auto-runs on
# first start if you skip this)
cd slides && npm ci && npm run build:single && cd ..

node server/classroom/index.mjs
# or: cd server/classroom && npm start
```

Open `http://localhost:4300`. Set `PORT` to change the port.

## Where work is stored

```
server/classroom/data/works/<id>/
  current.html   the live, self-contained .bento.html — this IS the editor
  meta.json      {id, title, createdAt, updatedAt}
```

`<id>` is a sortable timestamp + short random suffix
(`20260814-101530-a1b2c3`), so the folders on disk are already in creation
order without reading any metadata. Point `CLASSROOM_DATA_DIR` at another
path (e.g. a shared drive) to change where works live:

```sh
CLASSROOM_DATA_DIR=/srv/bento-works node server/classroom/index.mjs
```

Back up or move work by copying that directory — each work is a normal,
self-contained `.bento.html` file plus a small JSON sidecar, nothing more.

## How autosave works

Nothing in `slides/` or `kernel/` is modified. Every copy handed out from
`/w/<id>` has a small script appended before `</body>` (`injectAutosave` in
`index.mjs`) that polls the app's own documented scripting hook,
`window.bento.serialize()`, every few seconds and on tab close, and POSTs the
result to `/api/works/<id>/save`, which overwrites `current.html` in place.
Reopening `/w/<id>` later serves that same file back — the doc opens exactly
where it was left, because a saved Bento file boots from its own embedded
state.

## Gallery features

- **Name + subject/class at creation.** Both optional; a work named up front
  keeps that name in the gallery even as the deck's own in-editor title
  changes (`meta.titleFromDoc: false`) — leave the name blank and the gallery
  label just tracks whatever the deck is titled inside the editor, same as
  v1. The subject field groups the gallery into sections and remembers past
  values as autocomplete suggestions.
- **Thumbnails.** Each card is a sandboxed `<iframe>` (`sandbox`, no
  `allow-scripts`) pointed straight at the work's own URL — no separate
  rendering pipeline. With JS disabled the browser paints exactly the static
  `[data-bento-preview]` page-one snapshot every saved Bento file already
  carries for file-manager thumbnailing (`slides/src/preview.ts`), and never
  runs the app (so it's cheap and can't call home to `/api/works/.../save`).
  A work with no saves yet (first ~4s) shows the boot splash until the first
  autosave lands.
- **ทำสำเนา / duplicate.** Copies a work into a new id and flips
  `doc.template = true` in its embedded JSON — the app's own "instantiate a
  fresh copy" flag (`slides/src/model.ts` `parseDoc`), which mints a new
  `docId` and drops any collab credentials the moment the copy is actually
  opened. Without this the copy would share sync identity with its source
  (same-machine tabs sync purely by `docId` over `BroadcastChannel`) and
  editing one would silently leak into the other.
- **เก็บเข้าคลัง / archive.** `meta.archived` hides a work from `/` without
  touching its files — `/archived` lists it with a restore button. Still
  fully editable at its normal `/w/<id>` URL while archived.
- **นำเสนอ / Present.** Links straight to `/w/<id>#present`, which the app
  already treats as "start the show" on load (`slides/src/main.ts`) — no
  server-side work beyond the link.
- **QR code per work,** at `/w/<id>/qr` — built with the `qrcode` package
  already installed for `slides/` (borrowed via `createRequire`, the same
  trick `scripts/build-qr-page.mjs` uses, so this server adds no dependency
  of its own). Encodes the work's own reachable URL, so scanning it from
  `http://<lan-ip>:4300/...` opens the deck on a phone on the same network.

## Deliberately out of scope (v1)

- **No auth.** Anyone with the URL of a work can open and edit it. That's the
  point for a classroom, not an oversight — do not put this on the open
  internet without adding some.
- **No permanent delete.** Archiving hides a work; nothing removes its files.
  Clean up by deleting folders by hand if disk space matters.
