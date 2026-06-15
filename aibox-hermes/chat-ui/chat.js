// AI Box — fenêtre de chat épurée sur le protocole JSON-RPC de Hermes (/api/ws).
// Trames event : {method:"event", params:{type, session_id, payload}}.
// Features : streaming, raisonnement, outils, approval/clarify, Markdown +
// coloration code, pièces jointes image (vision) ET documents (PDF/Office),
// artefacts (/api/media), historique (liste/rechercher/renommer/supprimer),
// régénérer, éditer, dictée vocale + lecture à voix haute.
'use strict';

const $ = (s) => document.querySelector(s);
const thread = $('#thread'), input = $('#input'), composer = $('#composer'),
      sendBtn = $('#send'), statusEl = $('#status'), convList = $('#conv-list'),
      attachmentsEl = $('#attachments'), fileInput = $('#file'), modelBadge = $('#model-badge'),
      micBtn = $('#mic'), convSearch = $('#conv-search');
let emptyEl = $('#empty');

if (window.marked) marked.setOptions({ gfm: true, breaks: true });

// --- Indicateur d'activité (toolset → libellé) ------------------------------
const GROUP_LABEL = {
  clarify: ['❓', 'Clarification'], cronjob: ['⏰', 'Tâche planifiée'], delegation: ['🤝', 'Délégation'],
  code_execution: ['🐍', 'Exécution de code'], image_gen: ['🎨', "Génération d'image"], memory: ['🧠', 'Mémoire'],
  file: ['📁', 'Fichiers'], terminal: ['⌨️', 'Commande système'], session_search: ['🔎', 'Recherche historique'],
  skills: ['🧩', 'Compétence'], tts: ['🔊', 'Synthèse vocale'], todo: ['✅', 'Tâches'],
  vision: ['👁️', 'Vision (image)'], web: ['🌐', 'Recherche web'],
};
let toolGroup = {};
function categorize(name) {
  const g = toolGroup[name];
  if (g && GROUP_LABEL[g]) return GROUP_LABEL[g];
  if (g) return ['🔌', 'Connecteur ' + g];
  return ['🔧', name || 'Outil'];
}
function updateInfo(pl) {
  const model = pl.model || '';
  if (modelBadge) { modelBadge.textContent = model ? '🧠 ' + model : ''; modelBadge.title = 'Moteur IA : ' + model + (pl.provider === 'custom' ? ' (local)' : (pl.provider ? ' (' + pl.provider + ')' : '')); }
  toolGroup = {}; const tools = pl.tools || {};
  for (const g in tools) (tools[g] || []).forEach((t) => { toolGroup[t] = g; });
}

// --- Rendu Markdown + coloration + artefacts --------------------------------
function renderMarkdown(text) {
  const html = window.marked ? marked.parse(text || '') : (text || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : html;
}
const LOCAL_PATH = /^(\/home\/|\/tmp\/|\/root\/|\/var\/|\/mnt\/)/;
function enhance(el, highlight) {
  el.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.code-wrap')) return;
    const code = pre.querySelector('code');
    const lang = (code && (code.className.match(/language-([\w-]+)/) || [])[1]) || 'code';
    const wrap = document.createElement('div'); wrap.className = 'code-wrap';
    const head = document.createElement('div'); head.className = 'code-head';
    const ls = document.createElement('span'); ls.className = 'lang'; ls.textContent = lang;
    const cp = document.createElement('button'); cp.className = 'code-copy'; cp.type = 'button'; cp.textContent = 'Copier';
    head.appendChild(ls); head.appendChild(cp);
    pre.parentNode.insertBefore(wrap, pre); wrap.appendChild(head); wrap.appendChild(pre);
    cp.addEventListener('click', () => copyText(pre.innerText, cp, 'Copier'));
    if (highlight && window.hljs && code) { try { hljs.highlightElement(code); } catch (e) {} }
  });
  el.querySelectorAll('img').forEach((im) => { const s = im.getAttribute('src') || ''; if (LOCAL_PATH.test(s)) im.src = '/api/media?path=' + encodeURIComponent(s); });
  el.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (LOCAL_PATH.test(href)) { a.href = '/api/media?path=' + encodeURIComponent(href); a.className = 'dl-chip'; a.setAttribute('download', ''); a.textContent = '📥 ' + (a.textContent || href.split('/').pop()); }
    else if (/^(https?:|mailto:)/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
}
function copyText(t, btn, label) { navigator.clipboard?.writeText(t).then(() => { if (!btn) return; btn.textContent = 'Copié ✓'; setTimeout(() => { btn.textContent = label; }, 1500); }).catch(() => {}); }

// --- WebSocket / état -------------------------------------------------------
let TOKEN = '';
function wsUrl() { return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/api/ws' + (TOKEN ? ('?token=' + encodeURIComponent(TOKEN)) : ''); }
let ws, nextId = 0, ready = false, sessionId = null, activeStoredId = null, busy = false, lastUserText = '';
const pending = new Map();
const attached = [];
let cur = null;

function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.classList.toggle('err', !!err); }
function setBusy(b) { busy = b; document.body.classList.toggle('busy', b); sendBtn.title = b ? 'Arrêter' : 'Envoyer'; }
function rpc(method, params) { const id = 'r' + (++nextId); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params: params || {} })); }); }
function scroll() { const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160; if (near) thread.scrollTop = thread.scrollHeight; }
function clearThread() { thread.innerHTML = ''; emptyEl = null; cur = null; }

function addRow(role) { emptyEl?.remove(); const row = document.createElement('div'); row.className = 'row ' + role; const b = document.createElement('div'); b.className = 'bubble'; row.appendChild(b); thread.appendChild(row); return { row, b }; }
function userMessage(text) {
  const { row, b } = addRow('user'); b.textContent = text; thread.scrollTop = thread.scrollHeight;
  const acts = document.createElement('div'); acts.className = 'msg-actions';
  const ed = document.createElement('button'); ed.type = 'button'; ed.textContent = '✏ Modifier';
  ed.addEventListener('click', () => { input.value = text; input.focus(); input.dispatchEvent(new Event('input')); });
  acts.appendChild(ed); row.appendChild(acts);
}
function assistantStatic(text) { const { row, b } = addRow('assistant'); b.innerHTML = renderMarkdown(text); enhance(b, true); addTurnActions({ row, text }); }
function startAssistant() {
  emptyEl?.remove();
  const tw = document.createElement('div'); tw.className = 'think';
  tw.innerHTML = '<details><summary><span class="chev">▸</span><span class="spin"></span><span class="label">Réflexion…</span><span class="count"></span></summary><div class="think-body"></div></details>';
  tw.style.display = 'none'; thread.appendChild(tw);
  const toolWrap = document.createElement('div'); thread.appendChild(toolWrap);
  const { row, b } = addRow('assistant');
  b.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  cur = { row, bubble: b, thinkWrap: tw, thinkBody: tw.querySelector('.think-body'), toolWrap, tools: {}, text: '', think: '', started: false, lastRender: 0, raf: 0 };
}
function renderNow(final) { if (!cur) return; cur.bubble.innerHTML = renderMarkdown(cur.text); enhance(cur.bubble, final); cur.lastRender = Date.now(); scroll(); }
function scheduleRender() { if (!cur) return; const since = Date.now() - cur.lastRender; if (since > 60) renderNow(); else if (!cur.raf) cur.raf = setTimeout(() => { cur.raf = 0; renderNow(); }, 60 - since); }
function appendAnswer(t) { if (!t) return; if (!cur) startAssistant(); if (!cur.started) { cur.bubble.textContent = ''; cur.started = true; } cur.text += t; scheduleRender(); }
function appendThinking(t) { if (!t) return; if (!cur) startAssistant(); cur.thinkWrap.style.display = ''; cur.thinkWrap.classList.add('active'); cur.think += t; cur.thinkBody.textContent = cur.think; cur.thinkWrap.querySelector('.count').textContent = cur.think.split('\n').length + ' lignes'; scroll(); }
function toolEl(pl) { if (!cur) startAssistant(); const id = pl.tool_id || pl.name || ('t' + Object.keys(cur.tools).length); let el = cur.tools[id]; if (!el) { el = document.createElement('div'); el.className = 'tool'; cur.toolWrap.appendChild(el); cur.tools[id] = el; } return el; }
function addTool(pl) { const el = toolEl(pl); const [ic, lb] = categorize(pl.name); el.innerHTML = '<span class="tdot"></span>'; el.appendChild(document.createTextNode(' ' + ic + ' ' + lb + '…')); el.title = pl.name || ''; scroll(); }
function completeTool(pl) { const el = toolEl(pl); const [ic, lb] = categorize(pl.name); el.innerHTML = '<span class="tdot" style="background:#16a34a"></span>'; el.appendChild(document.createTextNode(' ' + ic + ' ' + lb + ' ✓')); el.title = pl.name || ''; scroll(); }
function finishAssistant(note) {
  if (!cur) return; if (cur.raf) { clearTimeout(cur.raf); cur.raf = 0; }
  if (cur.started) renderNow(true); else cur.bubble.textContent = note || '…';
  if (note && cur.started) { const n = document.createElement('p'); n.style.cssText = 'opacity:.6;font-size:.85em;margin:.4rem 0 0'; n.textContent = note; cur.bubble.appendChild(n); }
  cur.thinkWrap.classList.remove('active'); const lbl = cur.thinkWrap.querySelector('.label'); if (lbl) lbl.textContent = 'Raisonnement';
  if (cur.started && cur.text) addTurnActions(cur);
  cur = null; setBusy(false); setStatus(''); input.focus(); loadSessions();
}
function addTurnActions(turn) {
  const acts = document.createElement('div'); acts.className = 'msg-actions';
  const cp = document.createElement('button'); cp.type = 'button'; cp.textContent = 'Copier'; cp.addEventListener('click', () => copyText(turn.text, cp, 'Copier'));
  const sp = document.createElement('button'); sp.type = 'button'; sp.textContent = '🔊 Lire'; sp.addEventListener('click', () => readAloud(turn.text, sp));
  const rg = document.createElement('button'); rg.type = 'button'; rg.textContent = '↻ Régénérer'; rg.addEventListener('click', () => regenerate());
  acts.appendChild(cp); acts.appendChild(sp); acts.appendChild(rg); turn.row.appendChild(acts);
}

function handleEvent(et, p) {
  const pl = p.payload || {};
  switch (et) {
    case 'gateway.ready': if (!sessionId) newConversation(true); loadSessions(); break;
    case 'session.info': updateInfo(pl); break;
    case 'message.start': if (!cur) startAssistant(); break;
    case 'message.delta': appendAnswer(pl.text || ''); break;
    case 'reasoning.delta': appendThinking(pl.text || ''); break;
    case 'tool.start': addTool(pl); break;
    case 'tool.complete': completeTool(pl); break;
    case 'message.complete': { const final = pl.text || pl.rendered; if (final && cur) { cur.text = final; cur.started = true; } finishAssistant(); break; }
    case 'run.completed': finishAssistant(); break;
    case 'run.failed': { const m = pl.message; finishAssistant(); if (m) setStatus(m, true); break; }
    case 'run.cancelled': finishAssistant(cur && cur.started ? '⏹ Réponse interrompue.' : 'Réponse interrompue.'); break;
    case 'approval.request': renderApproval(pl); break;
    case 'clarify.request': renderClarify(pl); break;
    case 'sudo.request': case 'secret.request': setStatus('Cette action requiert une autorisation système, non disponible dans le chat.', true); if (sessionId) rpc('session.interrupt', { session_id: sessionId }).catch(() => {}); finishAssistant(); break;
    case 'error': setStatus(pl.message || p.message || 'Une erreur est survenue.', true); finishAssistant(); break;
  }
}
function renderApproval(pl) {
  const div = document.createElement('div'); div.className = 'card approval';
  const txt = pl.summary || pl.command || pl.tool || 'Action sensible : confirmer ?';
  const para = document.createElement('p'); para.textContent = '🔒 ' + txt; div.appendChild(para);
  const act = document.createElement('div'); act.className = 'actions';
  const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = 'Valider';
  const no = document.createElement('button'); no.className = 'no'; no.textContent = 'Refuser';
  ok.onclick = () => { rpc('approval.respond', { session_id: sessionId, choice: 'once', all: false }).catch(() => {}); div.remove(); };
  no.onclick = () => { rpc('approval.respond', { session_id: sessionId, choice: 'deny', all: false }).catch(() => {}); rpc('session.interrupt', { session_id: sessionId }).catch(() => {}); div.remove(); };
  act.appendChild(ok); act.appendChild(no); div.appendChild(act); thread.appendChild(div); scroll();
}
function renderClarify(pl) {
  const reqId = pl.request_id; const q = pl.question || pl.prompt || 'Pouvez-vous préciser ?';
  const div = document.createElement('div'); div.className = 'card clarify';
  const para = document.createElement('p'); para.textContent = '❓ ' + q; div.appendChild(para);
  const act = document.createElement('div'); act.className = 'actions';
  const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Votre réponse…';
  const ok = document.createElement('button'); ok.className = 'send2'; ok.textContent = 'Répondre';
  const submit = () => { const a = inp.value.trim(); if (!a) return; rpc('clarify.respond', { request_id: reqId, answer: a }).catch(() => {}); div.remove(); };
  ok.onclick = submit; inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  act.appendChild(inp); act.appendChild(ok); div.appendChild(act); thread.appendChild(div); inp.focus(); scroll();
}

// --- Historique : liste / recherche / renommer / supprimer ------------------
let allSessions = [];
async function loadSessions() { try { const res = await rpc('session.list', { limit: 80 }); allSessions = (res && res.sessions) || []; renderConvList(); } catch (e) {} }
function renderConvList() {
  const q = (convSearch && convSearch.value || '').trim().toLowerCase();
  const list = allSessions.filter((s) => !q || (s.title || '').toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q));
  convList.innerHTML = '';
  if (!list.length) { convList.innerHTML = '<div class="conv-empty">' + (q ? 'Aucun résultat.' : 'Aucune conversation.') + '</div>'; return; }
  list.forEach((s) => {
    const item = document.createElement('div'); item.className = 'conv-item' + (s.id === activeStoredId ? ' active' : '');
    const meta = document.createElement('button'); meta.className = 'meta conv-item'; meta.style.cssText = 'flex:1;text-align:left;border:0;background:none;cursor:pointer;font:inherit;color:inherit;min-width:0;padding:.2rem .3rem;';
    const t = document.createElement('div'); t.className = 't'; t.textContent = s.title || s.preview || 'Conversation'; meta.appendChild(t);
    if (s.preview) { const p = document.createElement('div'); p.className = 'p'; p.textContent = s.preview; meta.appendChild(p); }
    meta.onclick = () => openSession(s.id);
    const ren = document.createElement('button'); ren.className = 'act'; ren.title = 'Renommer'; ren.textContent = '✏';
    ren.onclick = (e) => { e.stopPropagation(); renameConv(s); };
    const del = document.createElement('button'); del.className = 'act'; del.title = 'Supprimer'; del.textContent = '🗑';
    del.onclick = (e) => { e.stopPropagation(); deleteConv(s); };
    item.appendChild(meta); item.appendChild(ren); item.appendChild(del); convList.appendChild(item);
  });
}
function msgText(c) { if (typeof c === 'string') return c; if (Array.isArray(c)) return c.map(msgText).join('\n'); if (c && typeof c === 'object') return c.text || c.content || ''; return ''; }
async function openSession(storedId) {
  closeNav(); setStatus('Ouverture…');
  try {
    const res = await rpc('session.resume', { session_id: storedId, cols: 80 });
    sessionId = (res && res.session_id) || storedId; activeStoredId = storedId; clearAttachments();
    let msgs = (res && res.messages) || [];
    if (!msgs.length) { const h = await rpc('session.history', { session_id: sessionId }); msgs = (h && h.messages) || []; }
    clearThread();
    msgs.forEach((m) => { const text = m.text || msgText(m.content); if (!text) return; if (m.role === 'user') userMessage(text); else if (m.role === 'assistant') assistantStatic(text); });
    if (!thread.children.length) thread.innerHTML = '<div class="empty"><p>Conversation vide.</p></div>';
    setStatus(''); loadSessions();
  } catch (e) { setStatus('Impossible d\'ouvrir la conversation', true); }
}
async function renameConv(s) {
  const title = prompt('Nouveau nom de la conversation :', s.title || ''); if (title == null) return;
  try { if (s.id !== activeStoredId) await rpc('session.resume', { session_id: s.id, cols: 80 }); await rpc('session.title', { session_id: s.id, title: title.trim() }); } catch (e) {}
  loadSessions();
}
async function deleteConv(s) {
  if (!confirm('Supprimer cette conversation ?')) return;
  try { await rpc('session.delete', { session_id: s.id }); } catch (e) {}
  if (s.id === activeStoredId) newConversation(false); else loadSessions();
}
async function newConversation(silent) {
  try { const res = await rpc('session.create', { cols: 80 }); sessionId = res && res.session_id; activeStoredId = (res && res.stored_session_id) || null; ready = true; input.disabled = false; } catch (e) {}
  clearAttachments();
  if (!silent) { thread.innerHTML = ''; const e = document.createElement('div'); e.className = 'empty'; e.innerHTML = '<div class="empty-logo">AI</div><h1>Nouvelle conversation</h1><p>Posez votre question.</p>'; thread.appendChild(e); emptyEl = e; cur = null; closeNav(); }
  setStatus(''); loadSessions();
}

// --- Pièces jointes (image + documents) -------------------------------------
function clearAttachments() { attachmentsEl.innerHTML = ''; attached.length = 0; }
function readDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
async function addAttachment(file) {
  if (!sessionId) { setStatus('Connexion en cours…'); return; }
  const dataUrl = await readDataURL(file);
  const isImg = (file.type || '').startsWith('image/');
  const chip = document.createElement('div'); chip.className = 'att-chip uploading'; chip.textContent = '…'; attachmentsEl.appendChild(chip);
  try {
    let res;
    if (isImg) res = await rpc('image.attach_bytes', { session_id: sessionId, content_base64: dataUrl, filename: file.name });
    else res = await rpc('file.attach', { session_id: sessionId, data_url: dataUrl, name: file.name });
    if (res && (res.attached || res.path || res.ok)) {
      chip.className = 'att-chip' + (isImg ? '' : ' doc'); chip.innerHTML = '';
      if (isImg) { const img = document.createElement('img'); img.src = dataUrl; chip.appendChild(img); }
      else { const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '📄'; const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = file.name; chip.appendChild(ic); chip.appendChild(nm); }
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '×';
      x.onclick = () => { chip.remove(); if (isImg && res.path) { const i = attached.indexOf(res.path); if (i >= 0) attached.splice(i, 1); rpc('image.detach', { session_id: sessionId, path: res.path }).catch(() => {}); } };
      chip.appendChild(x); if (res.path) attached.push(res.path);
    } else { chip.remove(); setStatus('Échec de la pièce jointe', true); }
  } catch (e) { chip.remove(); setStatus('Échec de la pièce jointe (' + file.name + ')', true); }
}

// --- Voix : dictée (entrée) + lecture (sortie) ------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recording = false;
function toggleMic() {
  if (!SR) { setStatus('Dictée vocale non supportée par ce navigateur.', true); return; }
  if (recording) { rec && rec.stop(); return; }
  rec = new SR(); rec.lang = 'fr-FR'; rec.interimResults = true; rec.continuous = false;
  const base = input.value;
  rec.onresult = (e) => { let txt = ''; for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript; input.value = (base ? base + ' ' : '') + txt; input.dispatchEvent(new Event('input')); };
  rec.onend = () => { recording = false; micBtn.classList.remove('rec'); };
  rec.onerror = () => { recording = false; micBtn.classList.remove('rec'); };
  try { rec.start(); recording = true; micBtn.classList.add('rec'); } catch (e) {}
}
function readAloud(text, btn) {
  if (!window.speechSynthesis) return;
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); if (btn) btn.textContent = '🔊 Lire'; return; }
  const u = new SpeechSynthesisUtterance(text); u.lang = 'fr-FR';
  if (btn) { btn.textContent = '⏹ Stop'; u.onend = () => { btn.textContent = '🔊 Lire'; }; }
  speechSynthesis.speak(u);
}

// --- WebSocket --------------------------------------------------------------
function connect() {
  setStatus('Connexion…'); ws = new WebSocket(wsUrl());
  ws.onopen = () => setStatus('');
  ws.onclose = () => { setStatus('Déconnecté — reconnexion…', true); ready = false; sessionId = null; setTimeout(connect, 2000); };
  ws.onerror = () => setStatus('Erreur de connexion', true);
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.id && pending.has(f.id)) { const { resolve, reject } = pending.get(f.id); pending.delete(f.id); if (f.error) { setStatus(f.error.message || 'Erreur', true); reject(f.error); } else resolve(f.result || {}); return; }
    const p = f.params || {}; const et = p.type || f.type;
    if (p.session_id && sessionId && p.session_id !== sessionId) return;
    if (et) handleEvent(et, p);
  };
}
function doSend(text) {
  if (!ready || !sessionId) { setStatus('Connexion en cours…'); return; }
  if (busy) return;
  lastUserText = text; userMessage(text); setBusy(true); setStatus('');
  rpc('prompt.submit', { session_id: sessionId, text }).then(() => { clearAttachments(); }).catch(() => { setStatus('Échec de l\'envoi', true); setBusy(false); });
}
function regenerate() { if (!lastUserText || busy || !ready || !sessionId) return; setBusy(true); setStatus('Régénération…'); rpc('prompt.submit', { session_id: sessionId, text: lastUserText }).catch(() => { setStatus('Échec', true); setBusy(false); }); }
function doStop() { if (!busy || !sessionId) return; setStatus('Arrêt…'); rpc('session.interrupt', { session_id: sessionId }).catch(() => {}); }

// --- UI wiring --------------------------------------------------------------
function submitFromInput() { const t = input.value.trim(); if (!t || busy) return; input.value = ''; input.style.height = 'auto'; doSend(t); }
function openNav() { document.body.classList.add('nav-open'); loadSessions(); }
function closeNav() { document.body.classList.remove('nav-open'); }
composer.addEventListener('submit', (e) => { e.preventDefault(); submitFromInput(); });
sendBtn.addEventListener('click', () => { busy ? doStop() : submitFromInput(); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) submitFromInput(); } });
input.addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'; });
$('#new-chat').addEventListener('click', () => newConversation(false));
$('#menu').addEventListener('click', () => document.body.classList.contains('nav-open') ? closeNav() : openNav());
$('#backdrop').addEventListener('click', closeNav);
$('#attach').addEventListener('click', () => fileInput.click());
micBtn.addEventListener('click', toggleMic);
convSearch && convSearch.addEventListener('input', renderConvList);
fileInput.addEventListener('change', async () => { const files = [...fileInput.files]; fileInput.value = ''; for (const f of files) await addAttachment(f); });
document.querySelectorAll('.suggestion').forEach((s) => s.addEventListener('click', () => { const pr = s.getAttribute('data-prompt') || s.textContent.trim(); if (pr.endsWith(': ') || pr.endsWith('：')) { input.value = pr; input.focus(); input.dispatchEvent(new Event('input')); } else doSend(pr); }));

// --- Boot -------------------------------------------------------------------
async function boot() {
  try { const r = await fetch('./session', { credentials: 'same-origin', cache: 'no-store' }); if (r.ok) { const j = await r.json(); TOKEN = j.token || ''; } } catch (e) {}
  if (!TOKEN && window.AIBOX) TOKEN = window.AIBOX.token || '';
  connect();
}
input.disabled = true;
boot();
