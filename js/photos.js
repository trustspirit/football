// Fetches lead images for players from the Wikipedia API (Wikimedia Commons)
// and caches the resolved URLs in localStorage. Falls back to initials.
(function () {
  const KEY = 'mdc-photos-v2';
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { cache = {}; }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) { /* ignore */ }
  }

  async function fetchChunk(players) {
    const titles = players.map((p) => p.wiki).join('|');
    const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*'
      + '&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=320'
      + '&titles=' + encodeURIComponent(titles);
    const res = await fetch(url);
    if (!res.ok) throw new Error('wiki ' + res.status);
    const q = (await res.json()).query || {};
    const norm = Object.fromEntries((q.normalized || []).map((n) => [n.from, n.to]));
    const redir = Object.fromEntries((q.redirects || []).map((n) => [n.from, n.to]));
    const byTitle = Object.fromEntries(Object.values(q.pages || {}).map((pg) => [pg.title, pg]));
    players.forEach((p) => {
      let t = norm[p.wiki] || p.wiki;
      t = redir[t] || t;
      const page = byTitle[t];
      cache[p.id] = (page && page.thumbnail && page.thumbnail.source) || '';
    });
  }

  const commonsUrl = (file) =>
    'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=320';

  async function load(players) {
    // Explicit Commons overrides win over the Wikipedia lead image.
    players.forEach((p) => { if (p.commons) cache[p.id] = commonsUrl(p.commons); });
    const missing = players.filter((p) => !(p.id in cache));
    for (let i = 0; i < missing.length; i += 50) {
      try { await fetchChunk(missing.slice(i, i + 50)); } catch (_) { save(); return i > 0; }
    }
    save();
    return missing.length > 0;
  }

  function initials(name) {
    return name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  }

  function html(player, cls) {
    const src = cache[player.id];
    const inner = src
      // upload.wikimedia.org sends CORS headers -> a cacheable (non-opaque) response for the service worker
      ? `<img src="${src}" alt="${player.name}"${src.includes('upload.wikimedia.org') ? ' crossorigin="anonymous"' : ''} loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${initials(player.name)}'))">`
      : initials(player.name);
    return `<span class="photo ${cls || ''}">${inner}</span>`;
  }

  window.Photos = { load, html };
})();
