#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Classroom server for bento/slides — a no-login gallery + autosave backend
// for a school lab: "New work" hands out a fresh deck at its own URL, the
// deck autosaves itself back to the server as it's edited, and the gallery
// lists every work anyone has ever created so it can be reopened and
// continued. Nothing is ever permanently deleted — "archive" only hides a
// work from the gallery.
//
// Deliberately near-zero npm dependencies — this is small enough that
// node:http + node:fs cover almost all of it. QR codes borrow the `qrcode`
// package already installed for slides/ (see getQrLib), the same trick
// scripts/build-qr-page.mjs uses — no separate install needed as long as
// `npm ci` has run in slides/.
//
//   node server/classroom/index.mjs            # http://localhost:4300
//   PORT=8080 CLASSROOM_DATA_DIR=/srv/works node server/classroom/index.mjs
//
// Each "work" is its own folder under the data dir:
//   data/works/<id>/current.html   — the live, self-contained .bento.html
//   data/works/<id>/meta.json      — {id, title, subject, titleFromDoc,
//                                     archived, createdAt, updatedAt}
// Opening /w/<id> serves current.html as-is: Bento files are fully
// self-contained (single-file build), so that IS the editor, loaded with
// whatever was last saved. A tiny autosave shim gets appended into each
// copy at creation/duplication time (see injectAutosave below) that
// periodically calls the app's own `window.bento.serialize()` scripting
// hook (kernel/src's documented AI/tooling round-trip surface) and POSTs
// the result back here.
//
// No auth, by design (deliberate — classroom use, not a security boundary).

import { createServer } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const TEMPLATE_PATH = join(ROOT, 'slides/dist-single/Bento_Slides.bento.html')
const DATA_DIR = process.env.CLASSROOM_DATA_DIR
  ? process.env.CLASSROOM_DATA_DIR
  : join(dirname(fileURLToPath(import.meta.url)), 'data')
const WORKS_DIR = join(DATA_DIR, 'works')
const PORT = Number(process.env.PORT) || 4300
const MAX_BODY_BYTES = 64 * 1024 * 1024 // generous, but bounded — decks can embed media
const MAX_FIELD_LEN = 200 // title/subject input cap
const ID_RE = /^[a-zA-Z0-9-]+$/

// --- one-time setup ---------------------------------------------------------

function ensureTemplate() {
  if (existsSync(TEMPLATE_PATH)) return
  console.log('[classroom] building slides/dist-single/Bento_Slides.bento.html (first run only)…')
  const r = spawnSync('npm', ['run', 'build:single'], { cwd: join(ROOT, 'slides'), stdio: 'inherit' })
  if (r.status !== 0 || !existsSync(TEMPLATE_PATH)) {
    console.error('[classroom] build failed — run `npm ci && npm run build:single` in slides/ yourself, then restart.')
    process.exit(1)
  }
}

function ensureDataDir() {
  mkdirSync(WORKS_DIR, { recursive: true })
}

// qrcode is a devDependency of slides/, not of this server — borrow it from
// there instead of installing a second copy (same trick as
// scripts/build-qr-page.mjs). Resolved lazily so a missing `npm ci` in
// slides/ only breaks the QR route, not the whole server.
let qrLib
function getQrLib() {
  if (qrLib === undefined) {
    try {
      qrLib = createRequire(join(ROOT, 'slides/package.json'))('qrcode')
    } catch {
      qrLib = null
    }
  }
  if (!qrLib) throw new Error('qrcode module not found — run `npm ci` in slides/ first')
  return qrLib
}

// --- html/text helpers ---------------------------------------------------

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function makeWorkId() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

const thaiDate = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })

/** Pull the doc title back out of a saved shell (`<title>doc — bento/slides</title>`). */
function titleFromHtml(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  if (!m) return null
  return m[1].replace(/\s+—\s+bento\/slides\s*$/, '').trim() || null
}

// --- the embedded #bento-doc data block -------------------------------------
// Contract lives in kernel/src/save.ts (serializeBody): a
// `<script type="application/bento+json" id="bento-doc">` whose JSON body has
// every literal `<` escaped to `<` (so it can never contain `</script>`).
// Only the duplicate route needs to actually edit this — everything else
// treats a saved work as an opaque blob.

const DOC_BLOCK_RE = /(<script[^>]*\bid="bento-doc"[^>]*>)([\s\S]*?)(<\/script>)/

function readDoc(html) {
  const m = html.match(DOC_BLOCK_RE)
  if (!m) return null
  try {
    return JSON.parse(m[2].trim().replace(/\\u003c/g, '<'))
  } catch {
    return null
  }
}

function writeDoc(html, doc) {
  const body = '\n' + JSON.stringify(doc).replace(/</g, '\\u003c') + '\n'
  let out = html.replace(DOC_BLOCK_RE, (_all, open, _mid, close) => open + body + close)
  const titleText = escapeHtml(doc.title || 'Untitled') + ' — bento/slides'
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${titleText}</title>`)
  return out
}

// --- autosave shim -----------------------------------------------------------
// Lives entirely outside the app bundle — no kernel/slides source is touched.
// Polls window.bento.serialize() (the app's own documented scripting surface)
// and posts changes back to this server.

// Matches regardless of exact attribute serialization: a round-trip through
// window.bento.serialize() clones the live DOM and re-emits the shim's
// <script> tag via outerHTML, which normalizes a bare boolean attribute to
// data-classroom-autosave="" — a literal-string match on what THIS file
// writes would silently miss that form and leave a stale shim (still
// posting saves to the OLD work's id) running alongside the fresh one.
const SHIM_RE = /<script[^>]*\bdata-classroom-autosave\b[^>]*>[\s\S]*?<\/script>/

function autosaveShim(workId) {
  return `<script data-classroom-autosave>(function(){
var workId = ${JSON.stringify(workId)};
var last = null;
var tag = document.createElement('div');
tag.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99999;font:12px/1.4 system-ui,sans-serif;color:#5E7699;background:#ffffffcc;padding:3px 9px;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .3s ease';
var home = document.createElement('a');
home.href = '/'; home.textContent = '← งานทั้งหมด';
home.style.cssText = 'position:fixed;left:10px;top:10px;z-index:99999;font:12px system-ui,sans-serif;color:#16273E;background:#ffffffcc;padding:4px 10px;border-radius:6px;text-decoration:none;box-shadow:0 1px 4px #0002';
function mount(){ document.body.appendChild(tag); document.body.appendChild(home); }
if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
function flash(msg){ tag.textContent = msg; tag.style.opacity = '1'; clearTimeout(flash._t); flash._t = setTimeout(function(){ tag.style.opacity = '0'; }, 1500); }
// Plain fetch, no keepalive/sendBeacon: a saved .bento.html is the whole app
// shell (hundreds of KB+), and Chromium caps keepalive/beacon request bodies
// around 64KB — those calls fail silently the moment a real deck is loaded.
// The 4s interval is the actual safety net; beforeunload/visibilitychange
// just take one best-effort extra shot before that.
function save(){
  if (!window.bento || typeof window.bento.serialize !== 'function' || window.bento.readonly) return;
  var html;
  try { html = window.bento.serialize(); } catch (e) { return; }
  if (html === last) return;
  fetch('/api/works/' + workId + '/save', { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: html })
    .then(function(r){ if (r.ok) { last = html; flash('บันทึกแล้ว'); } })
    .catch(function(){});
}
setInterval(save, 4000);
window.addEventListener('beforeunload', save);
document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'hidden') save(); });
})();</script>`
}

/** Idempotent: strips any existing shim (a different work's id) before adding a fresh one. */
function injectAutosave(html, workId) {
  const stripped = html.replace(SHIM_RE, '')
  const shim = autosaveShim(workId)
  return stripped.includes('</body>') ? stripped.replace('</body>', `${shim}</body>`) : stripped + shim
}

// --- meta.json ---------------------------------------------------------------

function metaPath(id) {
  return join(WORKS_DIR, id, 'meta.json')
}

async function readMeta(id) {
  try {
    return JSON.parse(await readFile(metaPath(id), 'utf8'))
  } catch {
    return null
  }
}

async function writeMeta(meta) {
  await writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8')
}

/** filter: 'active' (default, non-archived) | 'archived' | 'all' */
async function listWorks(filter = 'active') {
  let ids
  try {
    ids = await readdir(WORKS_DIR)
  } catch {
    return []
  }
  const works = []
  for (const id of ids) {
    if (!ID_RE.test(id)) continue
    const meta = await readMeta(id)
    if (!meta) continue
    const archived = !!meta.archived
    if (filter === 'active' && archived) continue
    if (filter === 'archived' && !archived) continue
    works.push(meta)
  }
  works.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return works
}

function groupBySubject(works) {
  const groups = new Map()
  for (const w of works) {
    const key = w.subject || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(w)
  }
  return Array.from(groups.entries())
    .map(([subject, items]) => ({ subject, items, latest: items[0].updatedAt }))
    .sort((a, b) => (a.latest < b.latest ? 1 : -1))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('payload too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readForm(req) {
  const body = await readBody(req)
  return new URLSearchParams(body.toString('utf8'))
}

// --- pages -------------------------------------------------------------------

function workCard(w) {
  const subjectBadge = w.subject ? `<span class="badge">${escapeHtml(w.subject)}</span>` : ''
  const toggleAction = w.archived ? 'unarchive' : 'archive'
  const toggleLabel = w.archived ? '↩ กู้คืน' : '📦 เก็บเข้าคลัง'
  return `<li class="work">
    <a class="thumb" href="/w/${w.id}" tabindex="-1"><iframe src="/w/${w.id}" sandbox loading="lazy" tabindex="-1"></iframe></a>
    <div class="body">
      <a class="title" href="/w/${w.id}">${escapeHtml(w.title || '(ยังไม่มีชื่อ)')}</a>
      <div class="meta">${subjectBadge}<span>อัปเดตล่าสุด ${escapeHtml(thaiDate(w.updatedAt))}</span></div>
      <div class="actions">
        <a href="/w/${w.id}#present">▶ นำเสนอ</a>
        <a href="/w/${w.id}/qr">QR</a>
        <form method="POST" action="/works/${w.id}/duplicate"><button type="submit">⧉ ทำสำเนา</button></form>
        <form method="POST" action="/works/${w.id}/${toggleAction}"><button type="submit">${toggleLabel}</button></form>
      </div>
    </div>
  </li>`
}

const PAGE_STYLE = `
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 48px auto; padding: 0 20px; color: #16273E; background: #F7F5F0; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h2 { font-size: 1.05rem; margin: 28px 0 10px; color: #16273E; }
  p.lede { color: #5E7699; margin-top: 0; }
  a.back { color: #5E7699; text-decoration: none; font-size: 0.85rem; }
  form.new { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 32px; }
  form.new input { font: inherit; padding: 10px 12px; border: 1px solid #d8d4c8; border-radius: 8px; background: #fff; flex: 1 1 200px; min-width: 160px; }
  button.new { font: inherit; font-weight: 600; background: #16273E; color: #fff; border: 0; padding: 10px 20px; border-radius: 8px; cursor: pointer; }
  button.new:hover { background: #263c5c; }
  ul.works { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
  li.work { background: #fff; border: 1px solid #e4e1d8; border-radius: 10px; overflow: hidden; }
  .thumb { display: block; position: relative; width: 100%; aspect-ratio: 16/9; background: #16273E; }
  .thumb iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; pointer-events: none; }
  li.work .body { padding: 10px 12px 12px; }
  li.work a.title { display: block; font-weight: 600; color: inherit; text-decoration: none; margin-bottom: 4px; }
  li.work a.title:hover { text-decoration: underline; }
  li.work .meta { display: flex; align-items: center; gap: 6px; font-size: 0.75rem; color: #5E7699; margin-bottom: 8px; }
  .badge { background: #EFE7DA; color: #16273E; border-radius: 999px; padding: 2px 8px; font-weight: 600; }
  li.work .actions { display: flex; flex-wrap: wrap; gap: 6px; font-size: 0.78rem; }
  li.work .actions a, li.work .actions button { font: inherit; color: #16273E; background: #F2EFE6; border: 0; border-radius: 6px; padding: 5px 8px; text-decoration: none; cursor: pointer; }
  li.work .actions a:hover, li.work .actions button:hover { background: #e4e1d8; }
  li.empty { color: #5E7699; padding: 14px 0; grid-column: 1/-1; }
`

function renderGallery(groups, subjects) {
  const datalist = `<datalist id="subjects">${subjects.map((s) => `<option value="${escapeHtml(s)}">`).join('')}</datalist>`
  const body = groups.length
    ? groups
        .map(
          (g) => `<h2>${g.subject ? escapeHtml(g.subject) : 'ไม่ระบุวิชา/ห้อง'}</h2>
          <ul class="works">${g.items.map(workCard).join('\n')}</ul>`
        )
        .join('\n')
    : `<ul class="works"><li class="empty">ยังไม่มีงาน กรอกชื่องานแล้วกด "สร้างงานใหม่" ด้านบนเพื่อเริ่ม</li></ul>`

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ห้องเรียน Bento Slides</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>ห้องเรียน Bento Slides</h1>
  <p class="lede">ไม่ต้องล็อกอิน งานทุกชิ้นจะถูกบันทึกอัตโนมัติไว้ที่นี่ เปิดซ้ำเพื่อทำต่อได้เสมอ — <a class="back" href="/archived">ดูงานที่เก็บเข้าคลัง →</a></p>
  <form class="new" method="POST" action="/works">
    <input type="text" name="title" placeholder="ชื่องาน (ไม่บังคับ)" maxlength="${MAX_FIELD_LEN}">
    <input type="text" name="subject" list="subjects" placeholder="วิชา/ห้อง (ไม่บังคับ)" maxlength="${MAX_FIELD_LEN}">
    ${datalist}
    <button class="new" type="submit">+ สร้างงานใหม่</button>
  </form>
  ${body}
</body>
</html>`
}

function renderArchived(works) {
  const body = works.length
    ? `<ul class="works">${works.map(workCard).join('\n')}</ul>`
    : `<ul class="works"><li class="empty">ยังไม่มีงานที่เก็บเข้าคลัง</li></ul>`
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>คลังงาน — ห้องเรียน Bento Slides</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>คลังงาน</h1>
  <p class="lede">งานที่เก็บเข้าคลัง ยังเปิดแก้ไขได้ตามปกติ กด "กู้คืน" เพื่อย้ายกลับไปหน้ารวมงาน — <a class="back" href="/">← กลับหน้ารวมงาน</a></p>
  ${body}
</body>
</html>`
}

function renderQrPage(meta, link, svg) {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR — ${escapeHtml(meta.title || 'งาน')}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 20px; color: #16273E; background: #F7F5F0; text-align: center; }
  h1 { font-size: 1.3rem; }
  .qr { background: #fff; border: 1px solid #e4e1d8; border-radius: 12px; padding: 20px; margin: 20px 0; }
  .qr svg { width: 100%; height: auto; max-width: 320px; }
  .link { word-break: break-all; font-size: 0.85rem; color: #5E7699; }
  .row { display: flex; gap: 10px; justify-content: center; margin-top: 16px; flex-wrap: wrap; }
  .row a { color: #16273E; background: #F2EFE6; border-radius: 8px; padding: 8px 14px; text-decoration: none; font-size: 0.9rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(meta.title || 'งาน')}</h1>
  <div class="qr">${svg}</div>
  <p class="link">${escapeHtml(link)}</p>
  <div class="row">
    <a href="/w/${meta.id}">✎ เปิดแก้ไข</a>
    <a href="/w/${meta.id}#present">▶ นำเสนอ</a>
    <a href="/">← งานทั้งหมด</a>
  </div>
</body>
</html>`
}

// --- server --------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/') {
    const works = await listWorks('active')
    const subjects = Array.from(new Set((await listWorks('all')).map((w) => w.subject).filter(Boolean))).sort()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderGallery(groupBySubject(works), subjects))
    return
  }

  if (req.method === 'GET' && url.pathname === '/archived') {
    const works = await listWorks('archived')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderArchived(works))
    return
  }

  if (req.method === 'POST' && url.pathname === '/works') {
    const form = await readForm(req)
    const titleIn = (form.get('title') || '').trim().slice(0, MAX_FIELD_LEN)
    const subjectIn = (form.get('subject') || '').trim().slice(0, MAX_FIELD_LEN)
    const id = makeWorkId()
    const dir = join(WORKS_DIR, id)
    mkdirSync(dir, { recursive: true })
    const template = await readFile(TEMPLATE_PATH, 'utf8')
    await writeFile(join(dir, 'current.html'), injectAutosave(template, id), 'utf8')
    const now = new Date().toISOString()
    await writeMeta({
      id,
      title: titleIn || titleFromHtml(template) || 'งานใหม่',
      subject: subjectIn || null,
      // once a teacher names it up front, that name is theirs to keep — autosave
      // stops overwriting it with whatever the in-editor deck title says
      titleFromDoc: !titleIn,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    res.writeHead(303, { Location: `/w/${id}` })
    res.end()
    return
  }

  const dupMatch = url.pathname.match(/^\/works\/([a-zA-Z0-9-]+)\/duplicate$/)
  if (req.method === 'POST' && dupMatch) {
    const srcId = dupMatch[1]
    if (!ID_RE.test(srcId)) return badRequest(res, 'bad id')
    const srcFile = join(WORKS_DIR, srcId, 'current.html')
    if (!existsSync(srcFile)) return notFound(res)
    const srcHtml = await readFile(srcFile, 'utf8')
    const srcMeta = await readMeta(srcId)
    const id = makeWorkId()
    const dir = join(WORKS_DIR, id)
    mkdirSync(dir, { recursive: true })

    // doc.template = true is the app's OWN "instantiate a fresh copy" flag
    // (slides/src/model.ts parseDoc): on next open it mints a new docId and
    // drops any collab credentials, so the duplicate never live-syncs back
    // into the original (same-machine tabs share sync state by docId alone).
    const doc = readDoc(srcHtml)
    let title
    let outHtml
    if (doc) {
      // srcMeta.title wins over doc.title: once a work is named up front
      // (titleFromDoc:false) the two can drift — the gallery name is the one
      // the user actually recognizes it by.
      title = (srcMeta?.title || doc.title || 'Untitled') + ' (สำเนา)'
      doc.title = title
      doc.template = true
      outHtml = writeDoc(srcHtml, doc)
    } else {
      title = (srcMeta?.title || 'Untitled') + ' (สำเนา)'
      outHtml = srcHtml
    }
    await writeFile(join(dir, 'current.html'), injectAutosave(outHtml, id), 'utf8')
    const now = new Date().toISOString()
    await writeMeta({
      id,
      title,
      subject: srcMeta?.subject ?? null,
      titleFromDoc: true,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    res.writeHead(303, { Location: `/w/${id}` })
    res.end()
    return
  }

  const archMatch = url.pathname.match(/^\/works\/([a-zA-Z0-9-]+)\/(archive|unarchive)$/)
  if (req.method === 'POST' && archMatch) {
    const [, id, action] = archMatch
    if (!ID_RE.test(id)) return badRequest(res, 'bad id')
    const meta = await readMeta(id)
    if (!meta) return notFound(res)
    meta.archived = action === 'archive'
    await writeMeta(meta)
    res.writeHead(303, { Location: action === 'archive' ? '/' : '/archived' })
    res.end()
    return
  }

  const qrMatch = url.pathname.match(/^\/w\/([a-zA-Z0-9-]+)\/qr$/)
  if (req.method === 'GET' && qrMatch) {
    const id = qrMatch[1]
    if (!ID_RE.test(id)) return notFound(res)
    const meta = await readMeta(id)
    if (!meta) return notFound(res)
    const proto = req.headers['x-forwarded-proto'] || 'http'
    const link = `${proto}://${req.headers.host}/w/${id}`
    let svg
    try {
      const QRCode = getQrLib()
      svg = (await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })).replace(/<\?xml[^>]*\?>/, '')
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<p>สร้าง QR ไม่ได้: ${escapeHtml(e.message || String(e))}</p><p><a href="/">← กลับ</a></p>`)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderQrPage(meta, link, svg))
    return
  }

  const openMatch = url.pathname.match(/^\/w\/([a-zA-Z0-9-]+)$/)
  if (req.method === 'GET' && openMatch) {
    const id = openMatch[1]
    if (!ID_RE.test(id)) return notFound(res)
    const file = join(WORKS_DIR, id, 'current.html')
    if (!existsSync(file)) return notFound(res)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(await readFile(file, 'utf8'))
    return
  }

  const saveMatch = url.pathname.match(/^\/api\/works\/([a-zA-Z0-9-]+)\/save$/)
  if (req.method === 'POST' && saveMatch) {
    const id = saveMatch[1]
    if (!ID_RE.test(id)) return badRequest(res, 'bad id')
    const dir = join(WORKS_DIR, id)
    if (!existsSync(dir)) return notFound(res)
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      res.writeHead(e.statusCode || 400).end()
      return
    }
    const html = body.toString('utf8')
    if (!html.includes('<html')) return badRequest(res, 'not html')
    await writeFile(join(dir, 'current.html'), html, 'utf8')
    const meta = (await readMeta(id)) || { id, subject: null, titleFromDoc: true, archived: false, createdAt: new Date().toISOString() }
    if (meta.titleFromDoc !== false) meta.title = titleFromHtml(html) ?? meta.title
    meta.updatedAt = new Date().toISOString()
    await writeMeta(meta)
    res.writeHead(204)
    res.end()
    return
  }

  notFound(res)
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('404 not found')
}

function badRequest(res, msg) {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(msg)
}

ensureTemplate()
ensureDataDir()

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err)
    if (!res.headersSent) res.writeHead(500)
    res.end('500 internal error')
  })
}).listen(PORT, () => {
  console.log(`[classroom] listening on http://localhost:${PORT}`)
  console.log(`[classroom] works stored under ${WORKS_DIR}`)
})
