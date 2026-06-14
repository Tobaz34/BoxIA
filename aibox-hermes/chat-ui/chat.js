// AI Box — fenêtre de chat épurée, branchée sur le protocole JSON-RPC de Hermes
// (/api/ws). Flux : gateway.ready → session.create → prompt.submit → events
// message.delta / reasoning.delta / tool.* / approval.request / clarify.request /
// message.complete / run.cancelled. Rendu Markdown sûr (marked + DOMPurify).
'use strict';

const $ = (s) => document.querySelector(s);
const thread = $('#thread'), input = $('#input'), composer = $('#composer'),
      sendBtn = $('#send'), statusEl = $('#status'), emptyEl = $('#empty');

if (window.marked) marked.setOptions({ gfm: true, breaks: true });
function renderMarkdown(text) {
  const html = window.marked ? marked.parse(text || '') : (text || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : html;
}
function enhance(el) {
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
  });
  el.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}
function copyText(t, btn, label) {
  navigator.clipboard?.writeText(t).then(() => {
    if (!btn) return; const o = btn.textContent; btn.textContent = 'Copié ✓';
    setTimeout(() => { btn.textContent = label || o; }, 1500);
  }).catch(() => {});
}

let TOKEN = '';
function wsUrl() {
  return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host +
         '/api/ws' + (TOKEN ? ('?token=' + encodeURIComponent(TOKEN)) : '');
}

let ws, nextId = 0, ready = false, sessionId = null, busy = false;
const pending = new Map();            // rpc id -> {resolve}
let cur = null;                       // turn assistant en cours

function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.classList.toggle('err', !!err); }
function setBusy(b) { busy = b; document.body.classList.toggle('busy', b); sendBtn.title = b ? 'Arrêter' : 'Envoyer'; }
function rpc(method, params) {
  const id = 'r' + (++nextId);
  return new Promise((resolve) => { pending.set(id, resolve);
    ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params: params || {} })); });
}
function scroll() {
  const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  if (near) thread.scrollTop = thread.scrollHeight;
}

function addRow(role) {
  emptyEl?.remove();
  const row = document.createElement('div'); row.className = 'row ' + role;
  const b = document.createElement('div'); b.className = 'bubble';
  row.appendChild(b); thread.appendChild(row); return { row, b };
}
function userMessage(text) {
  const { b } = addRow('user'); b.textContent = text; thread.scrollTop = thread.scrollHeight;
}
function startAssistant() {
  emptyEl?.remove();
  // bloc raisonnement (repliable, fermé par défaut)
  const tw = document.createElement('div'); tw.className = 'think';
  tw.innerHTML = '<details><summary><span class="chev">▸</span><span class="spin"></span>' +
    '<span class="label">Réflexion…</span><span class="count"></span></summary>' +
    '<div class="think-body"></div></details>';
  tw.style.display = 'none'; thread.appendChild(tw);
  const toolWrap = document.createElement('div'); thread.appendChild(toolWrap);
  const { row, b } = addRow('assistant');
  b.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  cur = { row, bubble: b, thinkWrap: tw, thinkBody: tw.querySelector('.think-body'),
          toolWrap, text: '', think: '', started: false, lastRender: 0, raf: 0 };
}
function renderNow() {
  if (!cur) return;
  cur.bubble.innerHTML = renderMarkdown(cur.text); enhance(cur.bubble); cur.lastRender = Date.now(); scroll();
}
function scheduleRender() {
  if (!cur) return;
  const since = Date.now() - cur.lastRender;
  if (since > 60) { renderNow(); }
  else if (!cur.raf) { cur.raf = setTimeout(() => { cur.raf = 0; renderNow(); }, 60 - since); }
}
function appendAnswer(t) {
  if (!t) return; if (!cur) startAssistant();
  if (!cur.started) { cur.bubble.textContent = ''; cur.started = true; }
  cur.text += t; scheduleRender();
}
function appendThinking(t) {
  if (!t) return; if (!cur) startAssistant();
  cur.thinkWrap.style.display = ''; cur.thinkWrap.classList.add('active');
  cur.think += t; cur.thinkBody.textContent = cur.think;
  cur.thinkWrap.querySelector('.count').textContent = cur.think.split('\n').length + ' lignes'; scroll();
}
function addTool(name) {
  if (!cur) startAssistant();
  const el = document.createElement('div'); el.className = 'tool';
  el.innerHTML = '<span class="tdot"></span>'; el.appendChild(document.createTextNode(' ' + (name || 'outil') + '…'));
  cur.toolWrap.appendChild(el); scroll();
}
function finishAssistant(note) {
  if (!cur) return;
  if (cur.raf) { clearTimeout(cur.raf); cur.raf = 0; }
  if (cur.started) renderNow(); else cur.bubble.textContent = note || '…';
  if (note && cur.started) { const n = document.createElement('p'); n.style.cssText = 'opacity:.6;font-size:.85em;margin:.4rem 0 0'; n.textContent = note; cur.bubble.appendChild(n); }
  cur.thinkWrap.classList.remove('active');
  const lbl = cur.thinkWrap.querySelector('.label'); if (lbl) lbl.textContent = 'Raisonnement';
  if (cur.started && cur.text) addCopyAction(cur);
  cur = null; setBusy(false); setStatus(''); input.focus();
}
function addCopyAction(turn) {
  const acts = document.createElement('div'); acts.className = 'msg-actions';
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Copier';
  b.addEventListener('click', () => copyText(turn.text, b, 'Copier'));
  acts.appendChild(b); turn.row.appendChild(acts);
}

function handleEvent(et, p) {
  switch (et) {
    case 'gateway.ready':
      if (!sessionId) rpc('session.create', { cols: 80 }).then((res) => {
        sessionId = res && res.session_id; ready = true; setStatus(''); input.disabled = false;
      });
      break;
    case 'message.start': if (!cur) startAssistant(); break;
    case 'message.delta': appendAnswer(p.text || p.delta || p.content || ''); break;
    case 'reasoning.delta':
    case 'thinking.delta': appendThinking(p.text || p.delta || ''); break;
    case 'tool.start': case 'tool.call': addTool(p.name || p.tool); break;
    case 'message.complete': {
      const final = (p.payload && p.payload.text) || p.text;
      if (final && cur && final.length > cur.text.length) { cur.text = final; cur.started = true; }
      finishAssistant(); break;
    }
    case 'run.cancelled': finishAssistant(cur && cur.started ? '⏹ Réponse interrompue.' : 'Réponse interrompue.'); break;
    case 'approval.request': renderApproval(p); break;
    case 'clarify.request': renderClarify(p); break;
    case 'error':
      setStatus((p.payload && p.payload.message) || p.message || 'Une erreur est survenue.', true); finishAssistant(); break;
  }
}

function renderApproval(p) {
  const div = document.createElement('div'); div.className = 'card approval';
  const txt = (p.payload && (p.payload.summary || p.payload.command)) || p.summary || 'Action sensible : confirmer ?';
  const para = document.createElement('p'); para.textContent = '🔒 ' + txt; div.appendChild(para);
  const act = document.createElement('div'); act.className = 'actions';
  const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = 'Valider';
  const no = document.createElement('button'); no.className = 'no'; no.textContent = 'Refuser';
  ok.onclick = () => { rpc('approval.respond', { session_id: sessionId, choice: 'once', all: false }); div.remove(); };
  no.onclick = () => { rpc('approval.respond', { session_id: sessionId, choice: 'deny', all: false }); rpc('session.interrupt', { session_id: sessionId }); div.remove(); };
  act.appendChild(ok); act.appendChild(no); div.appendChild(act); thread.appendChild(div); scroll();
}
function renderClarify(p) {
  const reqId = (p.payload && p.payload.request_id) || p.request_id;
  const q = (p.payload && (p.payload.question || p.payload.prompt)) || p.question || 'Pouvez-vous préciser ?';
  const div = document.createElement('div'); div.className = 'card clarify';
  const para = document.createElement('p'); para.textContent = '❓ ' + q; div.appendChild(para);
  const act = document.createElement('div'); act.className = 'actions';
  const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Votre réponse…';
  const ok = document.createElement('button'); ok.className = 'send2'; ok.textContent = 'Répondre';
  const submit = () => { const a = inp.value.trim(); if (!a) return; rpc('clarify.respond', { request_id: reqId, answer: a }); div.remove(); };
  ok.onclick = submit; inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  act.appendChild(inp); act.appendChild(ok); div.appendChild(act); thread.appendChild(div); inp.focus(); scroll();
}

function connect() {
  setStatus('Connexion…');
  ws = new WebSocket(wsUrl());
  ws.onopen = () => setStatus('');
  ws.onclose = () => { setStatus('Déconnecté — reconnexion…', true); ready = false; sessionId = null; setTimeout(connect, 2000); };
  ws.onerror = () => setStatus('Erreur de connexion', true);
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.id && pending.has(f.id)) { const r = pending.get(f.id); pending.delete(f.id); r(f.result || {}); if (f.error) setStatus(f.error.message || 'Erreur', true); return; }
    const p = f.params || {}; const et = p.type || f.type;
    if (p.session_id && sessionId && p.session_id !== sessionId) return;
    if (et) handleEvent(et, p);
  };
}

function doSend(text) {
  if (!ready || !sessionId) { setStatus('Connexion en cours…'); return; }
  if (busy) return;
  userMessage(text); setBusy(true); setStatus('');
  rpc('prompt.submit', { session_id: sessionId, text }).catch(() => { setStatus('Échec de l\'envoi', true); setBusy(false); });
}
function doStop() { if (!busy || !sessionId) return; setStatus('Arrêt…'); rpc('session.interrupt', { session_id: sessionId }); }

// --- UI wiring ---
function submitFromInput() {
  const t = input.value.trim(); if (!t || busy) return;
  input.value = ''; input.style.height = 'auto'; doSend(t);
}
composer.addEventListener('submit', (e) => { e.preventDefault(); submitFromInput(); });
sendBtn.addEventListener('click', () => { busy ? doStop() : submitFromInput(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) submitFromInput(); }
});
input.addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'; });
$('#new-chat').addEventListener('click', () => location.reload());
document.querySelectorAll('.suggestion').forEach((s) => s.addEventListener('click', () => {
  const pr = s.getAttribute('data-prompt') || s.textContent.trim();
  if (pr.endsWith(': ') || pr.endsWith('：')) { input.value = pr; input.focus(); input.dispatchEvent(new Event('input')); }
  else doSend(pr);
}));

// Récupère le token de session (par utilisateur, servi derrière Authentik) puis connecte.
async function boot() {
  try {
    const r = await fetch('./session', { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) { const j = await r.json(); TOKEN = j.token || ''; }
  } catch (e) { /* fallback ci-dessous */ }
  if (!TOKEN && window.AIBOX) TOKEN = window.AIBOX.token || '';
  connect();
}

input.disabled = true;
boot();
