/* gallery.js: the index page. Reads config.js and sketches.json, then lists every sketch. */

const S = window.SITE || {};
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function header() {
  document.title = `${S.title || 'Zentangles'}${S.artist ? ' · ' + S.artist : ''}`;
  $('artist').textContent = S.artist || '';
  // Italicise the last word of the title, like a signature flourish.
  const words = (S.title || 'Zentangles').split(' ');
  const last = words.pop();
  $('site-title').innerHTML = (words.length ? esc(words.join(' ')) + ' ' : '') + `<em>${esc(last)}</em>`;
  $('tagline').textContent = S.tagline || '';
  $('links').innerHTML = (S.links || []).map(l => `<a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`).join('');
  const about = (S.about || '').trim();
  if (about) $('about').innerHTML = about.split(/\n\s*\n/).map(p => `<p>${esc(p)}</p>`).join('');
  else $('about-section').hidden = true;
}

function render(list, all) {
  const g = $('gallery');
  g.innerHTML = list.map(s => {
    const n = all.indexOf(s) + 1;
    return `<a class="card" href="sketch.html?s=${encodeURIComponent(s.slug)}" aria-label="${esc(s.title)}: open and play">
      <div class="art"><img src="${esc(s.file)}" alt="${esc(s.title)}" loading="lazy" decoding="async"
           style="aspect-ratio:${s.aspect || 1}"><span class="play">Play →</span></div>
      <div class="meta"><span class="name">${esc(s.title)}</span><span class="num">${String(n).padStart(2, '0')}</span></div>
    </a>`;
  }).join('');
  $('count').textContent = list.length === all.length
    ? `${all.length} sketch${all.length === 1 ? '' : 'es'}`
    : `${list.length} of ${all.length} sketches`;
}

function showEmpty(html) {
  $('gallery').hidden = true;
  const e = $('empty'); e.hidden = false; e.innerHTML = html;
  $('count').textContent = '';
}

async function main() {
  header();
  let data;
  try {
    const r = await fetch('sketches.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch (e) {
    const fileUrl = location.protocol === 'file:';
    showEmpty(fileUrl
      ? `This page needs to be served by a web server, not opened as a file.<br>In this folder run
         <code>python3 -m http.server 8000</code> and open <code>http://localhost:8000</code>.`
      : `No sketch list yet. Put your SVGs in <code>sketches/</code> and run <code>python3 update_index.py</code>.`);
    return;
  }
  const all = data.sketches || [];
  if (!all.length) {
    showEmpty(`No sketches yet. Put your SVGs in <code>sketches/</code> and run <code>python3 update_index.py</code>.`);
    return;
  }
  render(all, all);
  $('search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    render(q ? all.filter(s => s.title.toLowerCase().includes(q)) : all, all);
  });
  $('random').addEventListener('click', e => {
    e.preventDefault();
    const s = all[Math.floor(Math.random() * all.length)];
    location.href = `sketch.html?s=${encodeURIComponent(s.slug)}`;
  });
}

main();
