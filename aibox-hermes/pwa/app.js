// AI Box PWA — client de chat minimal vers l'API Hermes.
// Idée « accès mobile » reprise d'Odysseus (PWA installable), branchée sur Hermes.
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get endpoint() { return localStorage.getItem('aibox.endpoint') || ''; },
  set endpoint(v) { localStorage.setItem('aibox.endpoint', v); },
  get apikey() { return localStorage.getItem('aibox.apikey') || ''; },
  set apikey(v) { localStorage.setItem('aibox.apikey', v); },
};

const history = [];

function addMsg(text, cls) {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

// Parsing défensif : Hermes peut renvoyer plusieurs formes selon la route.
function extractReply(data) {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  return data.response || data.content || data.message || data.text
    || (data.data && extractReply(data.data)) || JSON.stringify(data);
}

async function send(text) {
  const endpoint = store.endpoint.replace(/\/+$/, '');
  if (!endpoint) { openSettings(); return; }
  history.push({ role: 'user', content: text });
  addMsg(text, 'me');
  const pending = addMsg('…', 'bot');
  try {
    const res = await fetch(`${endpoint}/api/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(store.apikey ? { Authorization: `Bearer ${store.apikey}` } : {}),
      },
      body: JSON.stringify({ messages: history }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = extractReply(await res.json());
    pending.textContent = reply || '(réponse vide)';
    history.push({ role: 'assistant', content: reply });
  } catch (e) {
    pending.remove();
    addMsg(`Erreur : ${e.message}. Vérifie l'adresse et la clé dans ⚙️.`, 'err');
  }
}

function openSettings() {
  $('endpoint').value = store.endpoint;
  $('apikey').value = store.apikey;
  $('settings').showModal();
}

// --- wiring UI ---
$('settings-btn').addEventListener('click', openSettings);
$('save').addEventListener('click', () => {
  store.endpoint = $('endpoint').value.trim();
  store.apikey = $('apikey').value.trim();
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  send(text);
});
$('input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
});

if (!store.endpoint) openSettings();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
