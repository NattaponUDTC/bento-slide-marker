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

## Deliberately out of scope (v1)

- **No auth.** Anyone with the URL of a work can open and edit it. That's the
  point for a classroom, not an oversight — do not put this on the open
  internet without adding some.
- **No delete.** Old works just accumulate under `data/works/`. Clean up by
  deleting folders by hand if disk space matters.
- **No thumbnails in the gallery.** Titles + timestamps only, for now.
