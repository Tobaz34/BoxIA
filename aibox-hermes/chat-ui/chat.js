// AI Box — fenêtre de chat épurée, branchée sur le protocole JSON-RPC de Hermes
// (/api/ws). Protocole validé en POC : gateway.ready → session.create →
// prompt.submit → events message.delta/reasoning.delta/message.complete/...
'use strict';

const $ = (s) => document.querySelector(s);
const thread = $('#thread'), input = $('#input'), composer = $('#composer'),
      sendBtn = $('#send'), statusEl = $('#status'), emptyEl = $('#empty');

let TOKEN = '';
function wsUrl() {
  return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host +
         '/api/ws' + (TOKEN ? ('?token=' + encodeURIComponent(TOKEN)) : '');
}

let ws, nextId = 0, ready = false, sessionId = null, busy = false;
const pending = new Map();            // rpc id -> {resolve}
let cur = null;                       // bulle assistant en cours {bubble, thinkBody, text}

function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.classList.toggle('err', !!err); }
function rpc(method, params) {
  const id = 'r' + (++nextId);
  return new Promise((resolve) => { pending.set(id, resolve);
    ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params: params || {} })); });
}

function scroll() { thread.scrollTop = thread.scrollHeight; }
function addRow(role, text) {
  emptyEl?.remove();
  const row = document.createElement('div'); row.className = 'row ' + role;
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text || '';
  row.appendChild(b); thread.appendChild(row); scroll(); return b;
}
function startAssistant() {
  emptyEl?.remove();
  // bloc "réflexion" repliable (masqué par défaut)
  const tw = document.createElement('div'); tw.className = 'think';
  const det = document.createElement('details'); const sum = document.createElement('summary');
  sum.textContent = 'Réflexion'; const tb = document.createElement('div'); tb.className = 'think-body';
  det.appendChild(sum); det.appendChild(tb); tw.appendChild(det); tw.style.display = 'none';
  thread.appendChild(tw);
  const bubble = addRow('assistant', '');
  bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  cur = { bubble, thinkWrap: tw, thinkBody: tb, text: '', started: false };
}
function appendAnswer(t) {
  if (!cur) startAssistant();
  if (!cur.started) { cur.bubble.textContent = ''; cur.started = true; }
  cur.text += t; cur.bubble.textContent = cur.text; scroll();
}
function appendThinking(t) {
  if (!cur) startAssistant();
  cur.thinkWrap.style.display = ''; cur.thinkBody.textContent += t; scroll();
}
function finishAssistant() {
  if (cur && !cur.started) cur.bubble.textContent = '…';
  cur = null; busy = false; sendBtn.disabled = false; setStatus(''); input.focus();
}

function handleEvent(et, p) {
  switch (et) {
    case 'gateway.ready':
      if (!sessionId) rpc('session.create', { cols: 80 }).then((res) => {
        sessionId = res && res.session_id; ready = true;
        setStatus(''); input.disabled = false;
      });
      break;
    case 'message.start': startAssistant(); break;
    case 'message.delta':
      appendAnswer(p.text || p.delta || p.content || ''); break;
    case 'reasoning.delta':
    case 'thinking.delta':
      if (p.text) appendThinking(p.text); break;
    case 'tool.start': case 'tool.call':
      setStatus('🔧 ' + (p.name || p.tool || 'outil') + '…'); break;
    case 'message.complete': {
      const final = (p.payload && p.payload.text) || p.text;
      if (final && cur && final.length > cur.text.length) appendAnswer(final.slice(cur.text.length));
      finishAssistant(); break;
    }
    case 'approval.request': renderApproval(p); break;
    case 'error':
      setStatus((p.payload && p.payload.message) || p.message || 'Erreur', true); finishAssistant(); break;
  }
}

function renderApproval(p) {
  const id = p.request_id || p.id;
  const div = document.createElement('div'); div.className = 'approval';
  const txt = (p.payload && (p.payload.summary || p.payload.command)) || p.summary || 'Action sensible à confirmer';
  div.innerHTML = '<p>🔒 ' + txt + '</p>';
  const act = document.createElement('div'); act.className = 'actions';
  const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = 'Valider';
  const no = document.createElement('button'); no.className = 'no'; no.textContent = 'Refuser';
  ok.onclick = () => { rpc('approval.respond', { request_id: id, approved: true }); div.remove(); };
  no.onclick = () => { rpc('approval.respond', { request_id: id, approved: false }); div.remove(); };
  act.appendChild(ok); act.appendChild(no); div.appendChild(act); thread.appendChild(div); scroll();
}

function connect() {
  setStatus('Connexion…');
  ws = new WebSocket(wsUrl());
  ws.onopen = () => setStatus('');
  ws.onclose = () => { setStatus('Déconnecté — reconnexion…', true); ready = false; sessionId = null; setTimeout(connect, 2000); };
  ws.onerror = () => setStatus('Erreur de connexion', true);
  ws.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.id && pending.has(f.id)) { const r = pending.get(f.id); pending.delete(f.id); r(f.result || {}); if (f.error) setStatus(f.error.message || 'Erreur RPC', true); return; }
    const p = f.params || {}; const et = p.type || f.type;
    if (p.session_id && sessionId && p.session_id !== sessionId) return;
    if (et) handleEvent(et, p);
  };
}

async function send(text) {
  if (!ready || !sessionId) { setStatus('Pas encore prêt…'); return; }
  addRow('user', text); busy = true; sendBtn.disabled = true; setStatus('…');
  try { await rpc('prompt.submit', { session_id: sessionId, text }); }
  catch (e) { setStatus('Échec de l\'envoi', true); busy = false; sendBtn.disabled = false; }
}

// --- UI wiring ---
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = input.value.trim(); if (!t || busy) return;
  input.value = ''; input.style.height = 'auto'; send(t);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composer.requestSubmit(); }
});
input.addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'; });
$('#new-chat').addEventListener('click', () => location.reload());

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
