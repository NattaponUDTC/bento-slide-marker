#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Classroom server for bento/slides — a no-login gallery + autosave backend
// for a school lab: "New work" hands out a fresh deck at its own URL, the
// deck autosaves itself back to the server as it's edited, and the gallery
// lists every work anyone has ever created so it can be reopened and
// continued. Nothing is ever deleted (see docs at the bottom of this file).
//
// Deliberately zero npm dependencies — this is small enough that node:http
// + node:fs cover it, and it means `node index.mjs` just works.
//
//   node server/classroom/index.mjs            # http://localhost:4300
//   PORT=8080 CLASSROOM_DATA_DIR=/srv/works node server/classroom/index.mjs
//
// Each "work" is its own folder under the data dir:
//   data/works/<id>/current.html   — the live, self-contained .bento.html
//   data/works/<id>/meta.json      — {id, title, createdAt, updatedAt}
// Opening /w/<id> serves current.html as-is: Bento files are fully
// self-contained (single-file build), so that IS the editor, loaded with
// whatever was last saved. A tiny autosave shim gets appended into each
// copy at creation time (see injectAutosave below) that periodically calls
// the app's own `window.bento.serialize()` scripting hook (kernel/src's
// documented AI/tooling round-trip surface) and POSTs the result back here.
//
// No auth, by design (deliberate — classroom use, not a security boundary).

import { createServer } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const TEMPLATE_PATH = join(ROOT, 'slides/dist-single/Bento_Slides.bento.html')
const DATA_DIR = process.env.CLASSROOM_DATA_DIR
  ? process.env.CLASSROOM_DATA_DIR
  : join(dirname(fileURLToPath(import.meta.url)), 'data')
const WORKS_DIR = join(DATA_DIR, 'works')
const PORT = Number(process.env.PORT) || 4300
const MAX_BODY_BYTES = 64 * 1024 * 1024 // generous, but bounded — decks can embed media
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

// --- helpers -----------------------------------------------------------------

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function makeWorkId() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/** Pull the doc title back out of a saved shell (`<title>doc — bento/slides</title>`). */
function titleFromHtml(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  if (!m) return null
  return m[1].replace(/\s+—\s+bento\/slides\s*$/, '').trim() || null
}

// The autosave shim: polls window.bento.serialize() (the app's own documented
// scripting surface, kernel/src) and posts changes back to this server. Lives
// entirely outside the app bundle — no kernel/slides source is touched.
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

function injectAutosave(html, workId) {
  const shim = autosaveShim(workId)
  return html.includes('</body>') ? html.replace('</body>', `${shim}</body>`) : html + shim
}

async function readMeta(id) {
  try {
    return JSON.parse(await readFile(join(WORKS_DIR, id, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
}

async function listWorks() {
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
    if (meta) works.push(meta)
  }
  works.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return works
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

// --- pages -------------------------------------------------------------------

function renderGallery(works) {
  const rows = works.length
    ? works
        .map(
          (w) => `<li class="work">
            <a class="open" href="/w/${w.id}">
              <span class="title">${escapeHtml(w.title || '(ยังไม่มีชื่อ)')}</span>
              <span class="meta">อัปเดตล่าสุด ${escapeHtml(new Date(w.updatedAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }))}</span>
            </a>
          </li>`
        )
        .join('\n')
    : `<li class="empty">ยังไม่มีงาน กด "สร้างงานใหม่" ด้านบนเพื่อเริ่ม</li>`

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ห้องเรียน Bento Slides</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; color: #16273E; background: #F7F5F0; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  p.lede { color: #5E7699; margin-top: 0; }
  form.new { margin: 24px 0 32px; }
  button.new { font: inherit; font-weight: 600; background: #16273E; color: #fff; border: 0; padding: 12px 20px; border-radius: 10px; cursor: pointer; }
  button.new:hover { background: #263c5c; }
  ul.works { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  li.work a.open { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; background: #fff; border: 1px solid #e4e1d8; border-radius: 10px; padding: 14px 16px; text-decoration: none; color: inherit; }
  li.work a.open:hover { border-color: #5E7699; }
  li.work .title { font-weight: 600; }
  li.work .meta { font-size: 0.8rem; color: #5E7699; white-space: nowrap; }
  li.empty { color: #5E7699; padding: 14px 0; }
</style>
</head>
<body>
  <h1>ห้องเรียน Bento Slides</h1>
  <p class="lede">ไม่ต้องล็อกอิน งานทุกชิ้นจะถูกบันทึกอัตโนมัติไว้ที่นี่ เปิดซ้ำเพื่อทำต่อได้เสมอ</p>
  <form class="new" method="POST" action="/works">
    <button class="new" type="submit">+ สร้างงานใหม่</button>
  </form>
  <ul class="works">
    ${rows}
  </ul>
</body>
</html>`
}

// --- server --------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/') {
    const works = await listWorks()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderGallery(works))
    return
  }

  if (req.method === 'POST' && url.pathname === '/works') {
    const id = makeWorkId()
    const dir = join(WORKS_DIR, id)
    mkdirSync(dir, { recursive: true })
    const template = await readFile(TEMPLATE_PATH, 'utf8')
    await writeFile(join(dir, 'current.html'), injectAutosave(template, id), 'utf8')
    const now = new Date().toISOString()
    const meta = { id, title: titleFromHtml(template), createdAt: now, updatedAt: now }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
    res.writeHead(303, { Location: `/w/${id}` })
    res.end()
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
    const meta = (await readMeta(id)) || { id, createdAt: new Date().toISOString() }
    meta.title = titleFromHtml(html) ?? meta.title
    meta.updatedAt = new Date().toISOString()
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
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
