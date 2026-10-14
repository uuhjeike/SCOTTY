(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * Configuration
   * ------------------------------------------------------------------ */
  const RAW_BASE = 'https://raw.githubusercontent.com/uuhjeike/SCOTTY/main/';

  // Feed order, top to bottom. Emoji filenames are kept pre-encoded.
  const FILES = [
    '6.txt',
    '4.txt',
    '3.txt',
    '2.txt',
    '1.txt',
    '%F0%9F%91%B0%E2%80%8D%E2%99%80%EF%B8%8F%F0%9F%91%B0%E2%80%8D%E2%99%80%EF%B8%8F%F0%9F%91%B0%E2%80%8D%E2%99%80%EF%B8%8F.txt',
    '%F0%9F%9A%AB.txt',
    'Post.txt'
  ];

  const CACHE_PREFIX = 'scotty.src.';
  const TIMEOUT_MS = 15000;
  const MAX_ATTEMPTS = 3;
  const BATCH = 24;
  const RECHECK_MS = 60000;
  const MAX_AUTO_RECOVERY = 3;

  /* ------------------------------------------------------------------
   * DOM
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const feed = $('feed');
  const skeletons = $('skeletons');
  const emptyEl = $('empty');
  const sentinel = $('sentinel');
  const countMain = $('countMain');
  const countNote = $('countNote');
  const retryBtn = $('retry');
  const photo = $('photo');
  const photoFrame = $('photoFrame');
  const photoFallback = $('photoFallback');

  /* ------------------------------------------------------------------
   * Profile photograph (one failure, no retry loop)
   * ------------------------------------------------------------------ */
  function photoLoaded() { photoFrame.classList.add('loaded'); }
  function photoFailed() {
    photoFrame.classList.add('failed', 'loaded');
    photoFallback.hidden = false;
  }
  photo.addEventListener('load', photoLoaded, { once: true });
  photo.addEventListener('error', photoFailed, { once: true });
  if (photo.complete) {
    if (photo.naturalWidth > 0) photoLoaded(); else photoFailed();
  }

  /* ------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + s.length.toString(36);
  }

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function safeUrl(str) {
    try {
      const u = new URL(str);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
    } catch (e) {
      return null;
    }
  }

  function externalLink(href, label) {
    const a = el('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    a.textContent = label;
    return a;
  }

  const plural = (n) => n.toLocaleString('en-US') + (n === 1 ? ' post' : ' posts');

  /* ------------------------------------------------------------------
   * Parsing
   * A post is the text between lines that contain only hyphens ("-").
   * If a file has no such line at all, blank-line-separated blocks are
   * used instead. Empty blocks are never posts.
   * ------------------------------------------------------------------ */
  const isDelimiter = (line) => /^\s*-+\s*$/.test(line);

  function cleanBlock(lines) {
    const t = lines.join('\n')
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/(?:\n[ \t]*)+$/, '');
    return t.trim() ? t : '';
  }

  function parsePosts(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const useDelimiters = lines.some(isDelimiter);
    const blocks = [];
    let cur = [];
    const flush = () => {
      const b = cleanBlock(cur);
      if (b) blocks.push(b);
      cur = [];
    };
    for (const line of lines) {
      const boundary = useDelimiters ? isDelimiter(line) : line.trim() === '';
      if (boundary) flush(); else cur.push(line);
    }
    flush();
    return blocks;
  }

  // Keys are stable across reloads: source + content hash + nth identical post.
  function buildPosts(srcIndex, blocks) {
    const seen = new Map();
    return blocks.map((text) => {
      const h = hash(text);
      const n = (seen.get(h) || 0) + 1;
      seen.set(h, n);
      return { key: srcIndex + '|' + h + '|' + n, text };
    });
  }

  const looksLikeHtml = (t) => /^\s*<(?:!doctype|html)/i.test(t);

  /* ------------------------------------------------------------------
   * Sources
   * status: loading | ok | empty | failed | invalid
   * confirmed: content came from a successful request this session
   * ------------------------------------------------------------------ */
  const sources = FILES.map((file, i) => ({
    i,
    url: RAW_BASE + file,
    status: 'loading',
    posts: [],
    hash: null,
    hasData: false,
    confirmed: false,
    checking: false,
    inflight: null
  }));

  function applyText(src, text, confirmed) {
    const h = hash(text);
    if (h !== src.hash) {
      src.posts = buildPosts(src.i, parsePosts(text));
      src.hash = h;
    }
    src.hasData = true;
    src.status = src.posts.length ? 'ok' : 'empty';
    src.confirmed = confirmed;
  }

  function readCache() {
    for (const src of sources) {
      try {
        const t = localStorage.getItem(CACHE_PREFIX + src.i);
        if (t != null && !looksLikeHtml(t)) applyText(src, t, false);
      } catch (e) { /* storage unavailable */ }
    }
  }

  function writeCache(src, text) {
    try { localStorage.setItem(CACHE_PREFIX + src.i, text); } catch (e) { /* quota or disabled */ }
  }

  async function fetchWithRetry(url) {
    let lastErr;
    for (let a = 0; a < MAX_ATTEMPTS; a++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: ctl.signal,
          cache: 'no-cache',        // revalidate with ETag instead of trusting a stale copy
          credentials: 'omit',
          referrerPolicy: 'no-referrer'
        });
        if (res.ok) return await res.text();
        lastErr = new Error('HTTP ' + res.status);
        if (res.status !== 429 && res.status < 500) break; // not transient
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
      if (a < MAX_ATTEMPTS - 1) await sleep(1000 * Math.pow(2, a));
    }
    throw lastErr || new Error('Request failed');
  }

  function loadSource(src) {
    if (src.inflight) return src.inflight;
    if (!src.hasData) src.status = 'loading';
    src.checking = true;
    src.inflight = (async () => {
      try {
        const text = await fetchWithRetry(src.url);
        if (looksLikeHtml(text)) {
          src.confirmed = false;
          if (!src.hasData) src.status = 'invalid';
        } else {
          applyText(src, text, true);
          writeCache(src, text);
        }
      } catch (e) {
        src.confirmed = false;
        if (!src.hasData) src.status = 'failed';
      } finally {
        src.checking = false;
        src.inflight = null;
        schedule();
      }
    })();
    return src.inflight;
  }

  /* ------------------------------------------------------------------
   * Status line and count
   * ------------------------------------------------------------------ */
  let merged = [];
  let autoRounds = 0;
  let recoverTimer = 0;

  function recompute() {
    merged = [];
    for (const s of sources) {
      if (s.hasData) for (const p of s.posts) merged.push(p);
    }
  }

  function updateStatus() {
    const n = merged.length;
    let pending = 0, missing = 0, invalid = 0, stale = 0;
    for (const s of sources) {
      if (s.status === 'loading' || s.checking) pending++;
      if (!s.hasData) {
        if (s.status === 'failed') missing++;
        else if (s.status === 'invalid') invalid++;
      } else if (!s.confirmed && !s.checking) {
        stale++;
      }
    }
    const total = sources.length;
    const allConfirmed = sources.every((s) => s.hasData && s.confirmed);

    let main, note = '', showRetry = false;
    if (allConfirmed) {
      main = n ? plural(n) : 'No posts yet';
      autoRounds = 0;
    } else if (pending) {
      main = n ? plural(n) + ' so far' : 'Loading posts';
      note = sources.some((s) => s.status === 'loading') ? 'Still loading' : 'Checking for updates';
    } else {
      main = n ? plural(n) + ' loaded' : 'No posts loaded';
      const parts = [];
      if (missing) parts.push(missing + ' of ' + total + ' sources could not be loaded, so the count is incomplete.');
      if (invalid) parts.push(invalid + ' of ' + total + ' sources returned unreadable content.');
      if (stale) parts.push(stale + ' of ' + total + ' shown from a saved copy and may be out of date.');
      note = parts.join(' ');
      showRetry = true;
    }
    countMain.textContent = main;
    countNote.textContent = note;
    retryBtn.hidden = !showRetry;

    skeletons.hidden = !(n === 0 && pending);
    if (n === 0 && !pending) {
      emptyEl.hidden = false;
      emptyEl.textContent = (missing || invalid)
        ? 'Posts could not be loaded. Check your connection and try again.'
        : 'No posts yet.';
    } else {
      emptyEl.hidden = true;
    }

    // A few slow, bounded automatic attempts for sources that are still missing.
    if (showRetry && autoRounds < MAX_AUTO_RECOVERY && !recoverTimer) {
      recoverTimer = setTimeout(() => {
        recoverTimer = 0;
        autoRounds++;
        retryUnconfirmed();
      }, 30000 * (autoRounds + 1));
    }
  }

  function retryUnconfirmed() {
    for (const s of sources) if (!s.hasData || !s.confirmed) loadSource(s);
    schedule();
  }

  /* ------------------------------------------------------------------
   * Post bodies: text via text nodes only, validated links, lazy media
   * ------------------------------------------------------------------ */
  const OPEN_TO_CLOSE = { ')': '(', ']': '[', '}': '{' };

  function trimUrl(s) {
    let url = s, tail = '';
    for (;;) {
      const last = url.slice(-1);
      if (/[.,;:!?'"\u0964\u0965\u2026]/.test(last)) {
        tail = last + tail; url = url.slice(0, -1); continue;
      }
      const opener = OPEN_TO_CLOSE[last];
      if (opener && url.split(last).length > url.split(opener).length) {
        tail = last + tail; url = url.slice(0, -1); continue;
      }
      break;
    }
    return [url, tail];
  }

  function linkifyLine(line, parent) {
    const re = /https?:\/\/[^\s<>"`]+/gi;
    let last = 0, m;
    while ((m = re.exec(line))) {
      const [url, tail] = trimUrl(m[0]);
      if (m.index > last) parent.append(line.slice(last, m.index));
      const u = safeUrl(url);
      if (u) parent.append(externalLink(u.href, url)); else parent.append(url);
      if (tail) parent.append(tail);
      last = m.index + m[0].length;
    }
    if (last < line.length) parent.append(line.slice(last));
  }

  const IMG_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp)$/i;
  const VID_RE = /\.(?:mp4|webm|mov|m4v|ogv)$/i;
  const AUD_RE = /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;

  function classify(str) {
    const u = safeUrl(str);
    if (!u) return null;
    const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');

    let id = null, shorts = false;
    if (host === 'youtu.be') {
      id = u.pathname.slice(1).split('/')[0];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const p = u.pathname.split('/').filter(Boolean);
      if (p[0] === 'watch') id = u.searchParams.get('v');
      else if (['shorts', 'embed', 'live', 'v'].includes(p[0])) { id = p[1]; shorts = p[0] === 'shorts'; }
    }
    if (id && /^[\w-]{11}$/.test(id)) return { type: 'youtube', id, shorts, href: u.href };

    // GitHub blob links to media become raw links so they can be embedded.
    let media = u;
    if (host === 'github.com') {
      const p = u.pathname.split('/').filter(Boolean);
      if (p.length >= 5 && p[2] === 'blob') {
        try { media = new URL('https://raw.githubusercontent.com/' + p[0] + '/' + p[1] + '/' + p.slice(3).join('/')); }
        catch (e) { media = u; }
      }
    }
    const path = media.pathname;
    if (IMG_RE.test(path)) return { type: 'image', src: media.href };
    if (VID_RE.test(path)) return { type: 'video', src: media.href };
    if (AUD_RE.test(path)) return { type: 'audio', src: media.href };
    return null; // an ordinary web page is just a link, never assumed to be media
  }

  function unavailable(label, href) {
    const d = el('div', 'broken');
    d.append(label + ' ');
    d.append(externalLink(href, 'Open link'));
    return d;
  }

  function buildMedia(info) {
    const wrap = el('div', 'media');

    if (info.type === 'image') {
      wrap.classList.add('pending');
      const a = externalLink(info.src, '');
      const img = new Image();
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = 'Image attached to this post';
      img.addEventListener('load', () => wrap.classList.remove('pending'), { once: true });
      img.addEventListener('error', () => {
        wrap.classList.remove('pending');
        wrap.replaceChildren(unavailable('Image unavailable.', info.src));
      }, { once: true });
      img.src = info.src;
      a.append(img);
      wrap.append(a);
    } else if (info.type === 'video') {
      const v = document.createElement('video');
      v.controls = true;
      v.preload = 'none';
      v.playsInline = true;
      v.addEventListener('error', () => wrap.replaceChildren(unavailable('Video unavailable.', info.src)), { once: true });
      v.src = info.src;
      wrap.append(v);
    } else if (info.type === 'audio') {
      const a = document.createElement('audio');
      a.controls = true;
      a.preload = 'none';
      a.addEventListener('error', () => wrap.replaceChildren(unavailable('Audio unavailable.', info.src)), { once: true });
      a.src = info.src;
      wrap.append(a);
    } else if (info.type === 'youtube') {
      const box = el('div', 'yt' + (info.shorts ? ' short' : ''));
      const btn = el('button', 'yt-play');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Play YouTube video');
      const th = new Image();
      th.loading = 'lazy';
      th.decoding = 'async';
      th.alt = '';
      th.referrerPolicy = 'no-referrer';
      th.addEventListener('error', () => th.remove(), { once: true });
      th.src = 'https://i.ytimg.com/vi/' + info.id + '/hqdefault.jpg';
      btn.append(th);
      btn.addEventListener('click', () => {
        const f = document.createElement('iframe');
        f.src = 'https://www.youtube-nocookie.com/embed/' + info.id + '?autoplay=1&rel=0&playsinline=1';
        f.title = 'YouTube video player';
        f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        f.allowFullscreen = true;
        f.referrerPolicy = 'strict-origin-when-cross-origin';
        btn.replaceWith(f);
      }, { once: true });
      box.append(btn);
      const link = externalLink(info.href, 'Watch on YouTube');
      link.className = 'yt-link';
      wrap.append(box, link);
    }
    return wrap;
  }

  function buildBody(text) {
    const textLines = [];
    const media = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (/^https?:\/\/\S+$/i.test(t)) {
        const [url, tail] = trimUrl(t);
        if (!tail) {
          const info = classify(url);
          if (info) { media.push(info); continue; }
        }
      }
      textLines.push(line);
    }
    while (textLines.length && !textLines[0].trim()) textLines.shift();
    while (textLines.length && !textLines[textLines.length - 1].trim()) textLines.pop();

    const frag = document.createDocumentFragment();
    let txt = null;
    if (textLines.length) {
      txt = el('p', 'txt clamp');
      textLines.forEach((line, i) => {
        if (i) txt.append('\n');
        linkifyLine(line, txt);
      });
      frag.append(txt);
    }
    for (const info of media) frag.append(buildMedia(info));
    return { frag, txt, hasMedia: media.length > 0 };
  }

  /* ------------------------------------------------------------------
   * Cards and "See more"
   * ------------------------------------------------------------------ */
  function addMore(card) {
    const txt = card._txt;
    const btn = el('button', 'more');
    btn.type = 'button';
    btn.textContent = 'See more';
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      txt.classList.toggle('clamp', !open);
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'See less' : 'See more';
      if (!open && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' });
    });
    txt.after(btn);
  }

  // Measure clamped text once, when a card nears the viewport. Reads are
  // batched before writes so one callback costs one layout.
  const measureIO = new IntersectionObserver((entries) => {
    const cards = [];
    for (const e of entries) {
      if (e.isIntersecting) { measureIO.unobserve(e.target); cards.push(e.target); }
    }
    if (!cards.length) return;
    const overflow = cards.map((c) => c._txt.scrollHeight > c._txt.clientHeight + 1);
    cards.forEach((c, i) => {
      if (overflow[i]) addMore(c);
      else c._txt.classList.remove('clamp');
      if (!c._hasMedia) c.classList.add('cv'); // let the browser skip off-screen text cards
    });
  }, { rootMargin: '600px 0px' });

  function makeCard(post) {
    const card = el('article', 'card');
    const pos = el('div', 'pos');
    pos.setAttribute('aria-hidden', 'true');
    card.append(pos);
    const body = buildBody(post.text);
    card.append(body.frag);
    card._txt = body.txt;
    card._hasMedia = body.hasMedia;
    if (body.txt) measureIO.observe(card);
    return card;
  }

  /* ------------------------------------------------------------------
   * Rendering: keyed reconciliation in batches
   * Existing cards are reused, so expanding a post, scrolling, or a late
   * source arriving never rebuilds the whole feed.
   * ------------------------------------------------------------------ */
  const nodes = new Map();
  let limit = BATCH;

  function reconcile() {
    const total = merged.length;
    feed.style.setProperty('--total', JSON.stringify(total.toLocaleString('en-US')));
    const count = Math.min(limit, total);

    const want = new Set();
    for (let i = 0; i < count; i++) want.add(merged[i].key);
    for (const [k, node] of nodes) {
      if (!want.has(k)) { measureIO.unobserve(node); node.remove(); nodes.delete(k); }
    }

    let cursor = feed.firstElementChild;
    for (let i = 0; i < count; i++) {
      const p = merged[i];
      let node = nodes.get(p.key);
      if (!node) { node = makeCard(p); nodes.set(p.key, node); }
      if (node === cursor) cursor = cursor.nextElementSibling;
      else feed.insertBefore(node, cursor);
    }

    sentinel.hidden = count >= total;
    if (count < total) { sentinelIO.unobserve(sentinel); sentinelIO.observe(sentinel); }
  }

  const sentinelIO = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      limit += BATCH;
      reconcile();
    }
  }, { rootMargin: '1400px 0px' });

  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      recompute();
      updateStatus();
      reconcile();
    });
  }

  /* ------------------------------------------------------------------
   * Refresh
   * ------------------------------------------------------------------ */
  let lastCheck = 0;
  function refreshAll() {
    lastCheck = Date.now();
    for (const s of sources) loadSource(s);
    schedule();
  }

  retryBtn.addEventListener('click', () => {
    autoRounds = 0;
    if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = 0; }
    retryUnconfirmed();
  });

  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('paused', document.hidden);
    if (!document.hidden && Date.now() - lastCheck > RECHECK_MS) refreshAll();
  });

  window.addEventListener('online', () => {
    if (sources.some((s) => !s.hasData || !s.confirmed)) retryUnconfirmed();
  });

  /* ------------------------------------------------------------------
   * Start: show saved copies immediately, then confirm over the network
   * ------------------------------------------------------------------ */
  readCache();
  recompute();
  updateStatus();
  reconcile();
  refreshAll();
})();
