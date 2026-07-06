// AI Box — extension white-label pour hermes-webui (nesquena/hermes-webui).
// UPDATE-SAFE : vit hors du code upstream (HERMES_WEBUI_EXTENSION_DIR), injectée
// via HERMES_WEBUI_EXTENSION_SCRIPT_URLS. Un `git pull` de hermes-webui n'y touche pas.
// Rôle : masquer la marque « Hermes / Nous Research » et afficher « AI Box ».
// Additif & réversible (cf. docs/EXTENSIONS.md) : aucune réécriture de innerHTML,
// garde anti-réinjection, observation des changements pour re-appliquer après i18n.
(function () {
  "use strict";
  // Rôle passé par l'URL du script (/extensions/aibox.js?role=admin|client),
  // injecté par user via le service (HERMES_WEBUI_EXTENSION_SCRIPT_URLS).
  var ME = document.currentScript;
  // Fail-CLOSED : si currentScript est null, l'URL invalide, ou ?role absent, on
  // traite l'utilisateur comme « client » (le moins privilégié = vue chat réduite)
  // et JAMAIS comme admin. Un rôle indéterminé ne doit pas déverrouiller la vue
  // technique complète. Seul un ?role=admin explicite donne la vue admin.
  var ROLE = (function () {
    try {
      var r = new URL(ME.src).searchParams.get("role");
      return r === "admin" ? "admin" : "client";
    } catch (e) { return "client"; }
  })();

  if (window.__aiboxBranded) return;          // garde : pas de double-init
  window.__aiboxBranded = true;

  var BRAND = "AI Box";
  // Logo « AI Box » (carré bleu dégradé + « AI ») injecté dans .app-titlebar-icon.
  var LOGO = '<svg viewBox="0 0 64 64" width="16" height="16" aria-hidden="true">' +
    '<defs><linearGradient id="aibox-logo-g" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#4f86ff"/></linearGradient></defs>' +
    '<rect x="4" y="4" width="56" height="56" rx="14" fill="url(#aibox-logo-g)"/>' +
    '<text x="32" y="34" font-family="Inter,Segoe UI,system-ui,sans-serif" font-size="30" ' +
    'font-weight="800" fill="#fff" text-anchor="middle" dominant-baseline="central">AI</text></svg>';
  function applyLogo() {
    var el = document.querySelector(".app-titlebar-icon");
    if (el && el.dataset.aiboxLogo !== "1") { el.innerHTML = LOGO; el.dataset.aiboxLogo = "1"; }
  }
  var TEST = /Hermes\s*Web\s*UI|Hermes\s*Agent|Nous\s*Research|Hermes/i;
  function clean(s) {
    return s
      .replace(/Hermes\s*Web\s*UI/gi, BRAND)
      .replace(/Hermes\s*Agent/gi, BRAND)
      .replace(/Nous\s*Research/gi, BRAND)
      .replace(/Hermes/gi, BRAND);
  }

  var busy = false;
  function relabel() {
    if (busy || !document.body) return;
    busy = true;
    try {
      // Titre de l'onglet
      if (TEST.test(document.title)) document.title = clean(document.title);
      // Titre de la barre d'app (élément connu)
      var tb = document.getElementById("appTitlebarTitle");
      if (tb && TEST.test(tb.textContent)) tb.textContent = BRAND;
      // Tout le texte visible
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n, nodes = [];
      while ((n = w.nextNode())) { if (TEST.test(n.nodeValue)) nodes.push(n); }
      for (var i = 0; i < nodes.length; i++) nodes[i].nodeValue = clean(nodes[i].nodeValue);
      // Attributs visibles (title / aria-label / tooltip / placeholder)
      var sel = '[title*="Hermes"],[aria-label*="Hermes"],[data-tooltip*="Hermes"],[placeholder*="Hermes"]';
      var av = document.querySelectorAll(sel);
      for (var j = 0; j < av.length; j++) {
        ["title", "aria-label", "data-tooltip", "placeholder"].forEach(function (a) {
          var v = av[j].getAttribute(a);
          if (v && TEST.test(v)) av[j].setAttribute(a, clean(v));
        });
      }
    } finally { busy = false; }
  }

  var sched = false;
  function schedule() { if (sched) return; sched = true; setTimeout(function () { sched = false; relabel(); applyLogo(); }, 150); }
  function start() {
    // Rôle « client » → vue chat focalisée : masque la barre de nav technique
    // (la classe pilote le CSS dans aibox.css). « admin » → tout visible.
    if (ROLE === "client") document.documentElement.classList.add("aibox-client");
    relabel();
    applyLogo();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(function () { relabel(); applyLogo(); }, 2000); // re-applique après un re-rendu i18n
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();

// ─────────────────────────────────────────────────────────────────────────────
// AI Box — panneau « Connexions » (visible DANS le chat, pas dans le dashboard).
// Additif & update-safe : bouton flottant + fenêtre, lit l'API native
// /api/mcp/servers de hermes-webui (même origine → cookie de session porté).
// Réservé à l'admin (?role=admin). N'écrit rien, ne touche pas au reste de l'UI.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  if (window.__aiboxConnexions) return;
  window.__aiboxConnexions = true;

  var me = document.currentScript;
  var role = "client";
  try { role = new URL(me.src).searchParams.get("role") === "admin" ? "admin" : "client"; } catch (e) {}
  if (role !== "admin") return;   // vue technique réservée à l'admin

  // Libellés lisibles par connecteur MCP (fallback = nom brut).
  var META = {
    "email-msgraph": { label: "Emails Microsoft 365", icon: "✉️", cat: "Email" },
    "email-ews": { label: "Email Exchange", icon: "✉️", cat: "Email" },
    "odoo": { label: "Odoo", icon: "🏢", cat: "ERP / CRM" },
    "pennylane": { label: "Pennylane", icon: "🧾", cat: "Comptabilité" },
    "glpi": { label: "GLPI", icon: "🛠️", cat: "Support IT" },
  };

  var CSS = ""
    + "#aibox-cx-btn{position:fixed;left:14px;bottom:14px;z-index:99998;display:flex;align-items:center;gap:.5rem;"
    + "padding:.5rem .8rem;border-radius:10px;border:1px solid rgba(255,255,255,.15);cursor:pointer;"
    + "background:linear-gradient(180deg,#2563eb,#4f86ff);color:#fff;font:600 13px Inter,Segoe UI,system-ui,sans-serif;"
    + "box-shadow:0 4px 14px rgba(37,99,235,.35);}"
    + "#aibox-cx-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;}"
    + "#aibox-cx-modal{width:min(560px,92vw);max-height:82vh;overflow:auto;background:var(--color-card,#111827);color:var(--color-foreground,#e5e7eb);"
    + "border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:1.1rem 1.2rem;font:14px Inter,Segoe UI,system-ui,sans-serif;}"
    + "#aibox-cx-modal h2{margin:0 0 .2rem;font-size:1.05rem;}"
    + ".aibox-cx-sub{color:#9ca3af;font-size:.82rem;margin-bottom:.9rem;}"
    + ".aibox-cx-row{display:flex;align-items:center;gap:.6rem;padding:.6rem .2rem;border-bottom:1px solid rgba(255,255,255,.08);}"
    + ".aibox-cx-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}"
    + ".aibox-cx-name{font-weight:600;}"
    + ".aibox-cx-meta{font-size:.78rem;color:#9ca3af;}"
    + ".aibox-cx-st{margin-left:auto;font-size:.8rem;}"
    + "#aibox-cx-close{float:right;cursor:pointer;border:none;background:transparent;color:#9ca3af;font-size:1.2rem;line-height:1;}"
    + ".aibox-cx-foot{margin-top:.9rem;font-size:.76rem;color:#9ca3af;}";

  function injectCSS() {
    if (document.getElementById("aibox-cx-css")) return;
    var s = document.createElement("style"); s.id = "aibox-cx-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function close() { var o = document.getElementById("aibox-cx-ov"); if (o) o.remove(); }

  function render(servers, err) {
    close();
    var ov = document.createElement("div"); ov.id = "aibox-cx-ov";
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    var m = document.createElement("div"); m.id = "aibox-cx-modal";

    var closeBtn = document.createElement("button"); closeBtn.id = "aibox-cx-close";
    closeBtn.textContent = "×"; closeBtn.addEventListener("click", close); m.appendChild(closeBtn);

    var h = document.createElement("h2"); h.textContent = "Connexions"; m.appendChild(h);
    var sub = document.createElement("div"); sub.className = "aibox-cx-sub";
    m.appendChild(sub);

    if (err) {
      var e = document.createElement("div"); e.style.color = "#f87171";
      e.textContent = "Impossible de lire l'état des connexions (" + err + ").";
      m.appendChild(e);
    } else {
      var nOk = 0;
      servers.forEach(function (s) {
        var meta = META[s.name] || { label: s.name, icon: "🔌", cat: "Connecteurs" };
        var enabled = s.enabled !== false;
        var active = !!s.active;
        if (enabled) nOk++;
        var color = active ? "#16a34a" : (enabled ? "#3b82f6" : "#6b7280");
        var stTxt = active ? ("Actif · " + (s.tool_count || 0) + " outils")
                           : (enabled ? "Prêt" : "Désactivé");

        var row = document.createElement("div"); row.className = "aibox-cx-row";
        var dot = document.createElement("span"); dot.className = "aibox-cx-dot"; dot.style.background = color;
        var mid = document.createElement("div"); mid.style.flex = "1 1 auto"; mid.style.minWidth = "0";
        var nm = document.createElement("div"); nm.className = "aibox-cx-name";
        nm.textContent = meta.icon + "  " + meta.label;
        var mt = document.createElement("div"); mt.className = "aibox-cx-meta"; mt.textContent = meta.cat;
        mid.appendChild(nm); mid.appendChild(mt);
        var st = document.createElement("span"); st.className = "aibox-cx-st"; st.style.color = color; st.textContent = stTxt;
        row.appendChild(dot); row.appendChild(mid); row.appendChild(st);
        m.appendChild(row);
      });
      sub.textContent = servers.length + " connecteur(s) · " + nOk + " prêt(s)";
      var foot = document.createElement("div"); foot.className = "aibox-cx-foot";
      foot.textContent = "« Prêt » = configuré et activé. « Actif » = connecté avec ses outils chargés (au 1er usage dans une conversation).";
      m.appendChild(foot);
    }

    ov.appendChild(m); document.body.appendChild(ov);
  }

  function open() {
    injectCSS();
    render([], null);
    var sub = document.querySelector("#aibox-cx-modal .aibox-cx-sub");
    if (sub) sub.textContent = "Chargement…";
    fetch("/api/mcp/servers", { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) { render((d && d.servers) || [], null); })
      .catch(function (e) { render([], String(e.message || e)); });
  }

  function addButton() {
    if (document.getElementById("aibox-cx-btn") || !document.body) return;
    injectCSS();
    var b = document.createElement("button"); b.id = "aibox-cx-btn"; b.type = "button";
    b.innerHTML = "🔌 Connexions";
    b.addEventListener("click", open);
    document.body.appendChild(b);
  }

  function boot() {
    addButton();
    // le chat est une SPA : on ré-injecte le bouton s'il disparaît après un re-render
    setInterval(addButton, 2500);
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
