// Lecteur de documentation Hermes — offline, aux couleurs AI Box.
// Charge index.json (arbre de nav généré par build-docs.py) et rend les .md
// (copiés sous content/) avec marked + DOMPurify. Routing par hash (#/<id>).
'use strict';

const sidebarEl = document.getElementById('sidebar');
const contentEl = document.getElementById('content');
const searchEl = document.getElementById('search');
let INDEX = null, HOME = 'index';
const linkIndex = [];           // {id, title, el} pour la recherche

if (window.marked) marked.setOptions({ gfm: true, breaks: false });

function slug(s) { return (s || '').toLowerCase().trim().replace(/[^\wÀ-ſ]+/g, '-').replace(/^-+|-+$/g, ''); }
function escapeHtml(s) { return (s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// --- Résolution des liens internes (Docusaurus) -----------------------------
function resolveId(baseId, rel) {
  rel = rel.replace(/[#?].*$/, '').replace(/\.(md|mdx)$/, '').replace(/\/$/, '');
  let base;
  if (rel.startsWith('/')) { base = []; rel = rel.slice(1); }
  else { base = baseId.split('/').slice(0, -1); }
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') base.pop(); else base.push(part);
  }
  const id = base.join('/');
  return id === '' ? HOME : id;
}

// --- Sidebar -----------------------------------------------------------------
function buildNav(node, depth) {
  const frag = document.createDocumentFragment();
  (node.dirs || []).forEach((d) => {
    const det = document.createElement('details');
    if (depth < 1) det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = '<span class="chev">▸</span>';
    sum.appendChild(document.createTextNode(d.label));
    det.appendChild(sum);
    const grp = document.createElement('div'); grp.className = 'grp';
    grp.appendChild(buildNav(d, depth + 1));
    det.appendChild(grp);
    frag.appendChild(det);
  });
  (node.pages || []).forEach((p) => {
    const a = document.createElement('a');
    a.href = '#/' + p.id; a.textContent = p.title; a.dataset.id = p.id;
    frag.appendChild(a);
    linkIndex.push({ id: p.id, title: p.title.toLowerCase(), el: a });
  });
  return frag;
}
function renderSidebar() {
  sidebarEl.innerHTML = '';
  const home = document.createElement('a');
  home.href = '#/' + HOME; home.textContent = '🏠 ' + (INDEX.title || 'Accueil');
  home.className = 'home-link'; home.dataset.id = HOME;
  sidebarEl.appendChild(home);
  linkIndex.push({ id: HOME, title: (INDEX.title || 'accueil').toLowerCase(), el: home });
  sidebarEl.appendChild(buildNav(INDEX, 0));
}
function setActive(id) {
  linkIndex.forEach((l) => l.el.classList.toggle('active', l.id === id));
  const cur = linkIndex.find((l) => l.id === id);
  if (cur) { let p = cur.el.parentElement; while (p && p !== sidebarEl) { if (p.tagName === 'DETAILS') p.open = true; p = p.parentElement; } }
}

// --- Rendu d'une page --------------------------------------------------------
function preprocess(md) {
  md = md.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');          // frontmatter
  md = md.replace(/^\s*import\s.*$/gm, '').replace(/^\s*export\s.*$/gm, ''); // mdx
  // Admonitions :::type[ titre] ... :::
  md = md.replace(/^:::(note|tip|info|warning|caution|danger)[ \t]*(.*)\n([\s\S]*?)\n:::[ \t]*$/gm,
    (m, type, title, body) => '<div class="admonition adm-' + type + '"><p class="adm-title">' +
      escapeHtml(title || type) + '</p>\n' + (window.marked ? marked.parse(body) : escapeHtml(body)) + '</div>');
  return md;
}
function renderMarkdown(md) {
  const html = window.marked ? marked.parse(preprocess(md)) : escapeHtml(md);
  return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'id'] }) : html;
}
function enhance(root, baseId) {
  root.querySelectorAll('h1,h2,h3,h4').forEach((h) => { if (!h.id) h.id = slug(h.textContent); });
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.code-wrap')) return;
    const code = pre.querySelector('code');
    const lang = (code && (code.className.match(/language-([\w-]+)/) || [])[1]) || 'code';
    const wrap = document.createElement('div'); wrap.className = 'code-wrap';
    const head = document.createElement('div'); head.className = 'code-head';
    const ls = document.createElement('span'); ls.textContent = lang;
    const cp = document.createElement('button'); cp.className = 'code-copy'; cp.type = 'button'; cp.textContent = 'Copier';
    head.appendChild(ls); head.appendChild(cp);
    pre.parentNode.insertBefore(wrap, pre); wrap.appendChild(head); wrap.appendChild(pre);
    cp.addEventListener('click', () => navigator.clipboard?.writeText(pre.innerText).then(() => {
      cp.textContent = 'Copié ✓'; setTimeout(() => { cp.textContent = 'Copier'; }, 1500);
    }));
  });
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
    if (href.startsWith('#') && !href.startsWith('#/')) {            // ancre même page
      a.addEventListener('click', (e) => { e.preventDefault(); const t = document.getElementById(slug(href.slice(1))); t && t.scrollIntoView({ behavior: 'smooth' }); });
      return;
    }
    a.setAttribute('href', '#/' + resolveId(baseId, href));          // lien interne
  });
}
async function loadDoc(id) {
  setActive(id);
  contentEl.innerHTML = '<div class="loading">Chargement…</div>';
  try {
    const r = await fetch('content/' + id + '.md', { cache: 'no-store' });
    if (!r.ok) throw new Error('404');
    const md = await r.text();
    const inner = document.createElement('div'); inner.className = 'inner';
    inner.innerHTML = renderMarkdown(md);
    enhance(inner, id);
    contentEl.innerHTML = ''; contentEl.appendChild(inner); contentEl.scrollTop = 0;
    document.body.classList.remove('nav-open');
    const t = inner.querySelector('h1'); document.title = (t ? t.textContent : 'Documentation') + ' — AI Box';
  } catch (e) {
    contentEl.innerHTML = '<div class="inner"><div class="notfound"><h2>Page introuvable</h2><p>Le document <code>' + escapeHtml(id) + '</code> n\'existe pas dans la documentation embarquée.</p></div></div>';
  }
}

// --- Recherche ---------------------------------------------------------------
searchEl?.addEventListener('input', () => {
  const q = searchEl.value.trim().toLowerCase();
  linkIndex.forEach((l) => { l.el.style.display = (!q || l.title.includes(q) || l.id.includes(q)) ? '' : 'none'; });
  sidebarEl.querySelectorAll('details').forEach((d) => {
    const any = [...d.querySelectorAll('a')].some((a) => a.style.display !== 'none');
    d.style.display = any ? '' : 'none'; if (q && any) d.open = true;
  });
});
document.getElementById('burger')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));

// --- Routing -----------------------------------------------------------------
function currentId() { const h = location.hash; return h.startsWith('#/') ? decodeURIComponent(h.slice(2)) : HOME; }
window.addEventListener('hashchange', () => loadDoc(currentId()));

(async function init() {
  try {
    const r = await fetch('index.json', { cache: 'no-store' });
    INDEX = await r.json(); HOME = INDEX.home || 'index';
  } catch (e) {
    contentEl.innerHTML = '<div class="loading">Documentation indisponible (index manquant).</div>'; return;
  }
  renderSidebar();
  loadDoc(currentId());
})();
