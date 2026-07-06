// AI Box — extension white-label pour hermes-webui (nesquena/hermes-webui).
// UPDATE-SAFE : vit hors du code upstream (HERMES_WEBUI_EXTENSION_DIR), injectée
// via HERMES_WEBUI_EXTENSION_SCRIPT_URLS. Un `git pull` de hermes-webui n'y touche pas.
// Rôle : masquer la marque « Hermes / Nous Research » et afficher « AI Box ».
// Additif & réversible (cf. docs/EXTENSIONS.md) : aucune réécriture de innerHTML,
// garde anti-réinjection, observation des changements pour re-appliquer après i18n.
(function () {
  "use strict";
  var ME = document.currentScript;
  var ROLE = (function () {
    try {
      var r = new URL(ME.src).searchParams.get("role");
      return r === "admin" ? "admin" : "client";
    } catch (e) { return "client"; }
  })();

  if (window.__aiboxBranded) return;
  window.__aiboxBranded = true;

  var BRAND = "AI Box";
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
      if (TEST.test(document.title)) document.title = clean(document.title);
      var tb = document.getElementById("appTitlebarTitle");
      if (tb && TEST.test(tb.textContent)) tb.textContent = BRAND;
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n, nodes = [];
      while ((n = w.nextNode())) { if (TEST.test(n.nodeValue)) nodes.push(n); }
      for (var i = 0; i < nodes.length; i++) nodes[i].nodeValue = clean(nodes[i].nodeValue);
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
    if (ROLE === "client") document.documentElement.classList.add("aibox-client");
    relabel();
    applyLogo();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(function () { relabel(); applyLogo(); }, 2000);
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();

// ─────────────────────────────────────────────────────────────────────────────
// AI Box — « Connexions » : item dans le menu de gauche (rail natif) + panneau
// de gestion par boîte email. Lit l'API du plugin aibox-connections (exposée par
// Caddy vers le dashboard du user, même origine → cookie de session). Réservé
// admin. Actions par boîte : tester, désactiver/réactiver (réversible), changer
// le mot de passe. + formulaire « Configurer Odoo » (PUT natif /api/mcp/servers).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";
  if (window.__aiboxConnexions) return;
  window.__aiboxConnexions = true;

  var me = document.currentScript;
  var role = "client";
  try { role = new URL(me.src).searchParams.get("role") === "admin" ? "admin" : "client"; } catch (e) {}
  if (role !== "admin") return;

  var API = "/api/plugins/aibox-connections";
  var KIND_ICON = { "IMAP": "✉️", "Microsoft 365": "✉️", "Exchange (EWS)": "✉️" };

  var CSS = ""
    + "#aibox-cx-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;}"
    + "#aibox-cx-panel{width:min(480px,94vw);height:100%;overflow:auto;background:var(--color-card,#0f172a);color:var(--color-foreground,#e5e7eb);"
    + "border-right:1px solid rgba(255,255,255,.12);box-shadow:2px 0 24px rgba(0,0,0,.4);padding:1.1rem 1.2rem;font:14px Inter,Segoe UI,system-ui,sans-serif;}"
    + "#aibox-cx-panel h2{margin:0;font-size:1.1rem;}"
    + ".aibox-cx-sub{color:#9ca3af;font-size:.82rem;margin:.2rem 0 1rem;}"
    + ".aibox-cx-cat{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:#9ca3af;margin:1rem 0 .3rem;}"
    + ".aibox-cx-card{border:1px solid rgba(255,255,255,.1);border-radius:11px;padding:.6rem .7rem;margin-bottom:.5rem;}"
    + ".aibox-cx-head{display:flex;align-items:center;gap:.55rem;}"
    + ".aibox-cx-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;}"
    + ".aibox-cx-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}"
    + ".aibox-cx-kind{font-size:.75rem;color:#9ca3af;}"
    + ".aibox-cx-st{margin-left:auto;font-size:.78rem;white-space:nowrap;}"
    + ".aibox-cx-acts{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.55rem;}"
    + ".aibox-cx-btn2{padding:.3rem .65rem;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:inherit;font:inherit;font-size:.78rem;cursor:pointer;}"
    + ".aibox-cx-btn2:hover{background:rgba(255,255,255,.12);}"
    + ".aibox-cx-btn2.danger{border-color:rgba(220,38,38,.5);color:#fca5a5;}"
    + ".aibox-cx-msg{font-size:.78rem;margin-top:.4rem;min-height:1em;}"
    + ".aibox-cx-close{margin-left:auto;cursor:pointer;border:none;background:transparent;color:#9ca3af;font-size:1.4rem;line-height:1;}"
    + ".aibox-cx-pwrow{display:flex;gap:.4rem;margin-top:.5rem;}"
    + ".aibox-cx-pwrow input{flex:1 1 auto;min-width:0;padding:.35rem .55rem;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:inherit;font:inherit;}"
    + ".aibox-cx-foot{margin-top:1rem;font-size:.75rem;color:#9ca3af;}"
    + ".aibox-cx-rail{color:var(--rail-fg,inherit);}";

  function injectCSS() {
    if (document.getElementById("aibox-cx-css")) return;
    var s = document.createElement("style"); s.id = "aibox-cx-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function jfetch(url, opts) {
    opts = opts || {}; opts.credentials = "same-origin";
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.status === 204 ? {} : r.json();
    });
  }
  function close() { var o = document.getElementById("aibox-cx-ov"); if (o) o.remove(); }

  // Rebond d'un connecteur MCP via l'API native (applique un changement d'env).
  function bounce(name) {
    if (!name) return Promise.resolve();
    var u = "/api/mcp/servers/" + encodeURIComponent(name);
    return jfetch(u, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) })
      .then(function () { return jfetch(u, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) }); })
      .catch(function () {});
  }

  function boxCard(it) {
    var card = document.createElement("div"); card.className = "aibox-cx-card";
    var color = it.disabled ? "#6b7280" : (it.enabled ? "#16a34a" : "#f59e0b");
    var stTxt = it.disabled ? "Désactivée" : (it.enabled ? "Connectée" : "À configurer");

    var head = document.createElement("div"); head.className = "aibox-cx-head";
    var dot = document.createElement("span"); dot.className = "aibox-cx-dot"; dot.style.background = color;
    var mid = document.createElement("div"); mid.style.cssText = "flex:1 1 auto;min-width:0";
    var nm = document.createElement("div"); nm.className = "aibox-cx-name"; nm.textContent = (KIND_ICON[it.kind] || "🔌") + "  " + it.label;
    var kd = document.createElement("div"); kd.className = "aibox-cx-kind"; kd.textContent = it.kind;
    mid.appendChild(nm); mid.appendChild(kd);
    var st = document.createElement("span"); st.className = "aibox-cx-st"; st.style.color = color; st.textContent = stTxt;
    head.appendChild(dot); head.appendChild(mid); head.appendChild(st);
    card.appendChild(head);

    var msg = document.createElement("div"); msg.className = "aibox-cx-msg";
    var acts = document.createElement("div"); acts.className = "aibox-cx-acts";
    var actions = it.actions || [];

    function setMsg(txt, ok) { msg.style.color = ok ? "#16a34a" : (ok === false ? "#f87171" : "#9ca3af"); msg.textContent = txt; }

    // Tester
    if (it.checkable) {
      var bt = document.createElement("button"); bt.className = "aibox-cx-btn2"; bt.textContent = "Tester";
      bt.addEventListener("click", function () {
        bt.disabled = true; setMsg("Test…");
        jfetch(API + "/check/" + encodeURIComponent(it.id))
          .then(function (r) { setMsg((r.ok ? "✓ " : "✗ ") + r.message, r.ok); })
          .catch(function (e) { setMsg("✗ " + e.message, false); })
          .then(function () { bt.disabled = false; });
      });
      acts.appendChild(bt);
    }

    // Désactiver / Réactiver
    if (actions.indexOf("toggle") >= 0) {
      var tg = document.createElement("button"); tg.className = "aibox-cx-btn2" + (it.disabled ? "" : " danger");
      tg.textContent = it.disabled ? "Réactiver" : "Déconnecter";
      tg.addEventListener("click", function () {
        var action = it.disabled ? "enable" : "disable";
        tg.disabled = true; setMsg(it.disabled ? "Réactivation…" : "Déconnexion…");
        jfetch(API + "/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id, action: action }) })
          .then(function (r) { return (r.needs_reconnect ? bounce(r.connector) : Promise.resolve()).then(function () { return r; }); })
          .then(function (r) { setMsg("✓ " + r.message, true); setTimeout(refresh, 800); })
          .catch(function (e) { setMsg("✗ " + e.message, false); tg.disabled = false; });
      });
      acts.appendChild(tg);
    }

    // Changer le mot de passe
    if (actions.indexOf("set_password") >= 0) {
      var pb = document.createElement("button"); pb.className = "aibox-cx-btn2"; pb.textContent = "Changer le mot de passe";
      var pwrow = document.createElement("div"); pwrow.className = "aibox-cx-pwrow"; pwrow.style.display = "none";
      var pin = document.createElement("input"); pin.type = "password"; pin.placeholder = "nouveau mot de passe";
      var psave = document.createElement("button"); psave.className = "aibox-cx-btn2"; psave.textContent = "OK";
      pwrow.appendChild(pin); pwrow.appendChild(psave);
      pb.addEventListener("click", function () { pwrow.style.display = pwrow.style.display === "none" ? "flex" : "none"; if (pwrow.style.display === "flex") pin.focus(); });
      psave.addEventListener("click", function () {
        if (!pin.value) { setMsg("Mot de passe vide.", false); return; }
        psave.disabled = true; setMsg("Enregistrement…");
        jfetch(API + "/manage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id, action: "set_password", value: pin.value }) })
          .then(function (r) { pin.value = ""; return (r.needs_reconnect ? bounce(r.connector) : Promise.resolve()).then(function () { return r; }); })
          .then(function (r) { setMsg("✓ " + r.message, true); pwrow.style.display = "none"; setTimeout(refresh, 800); })
          .catch(function (e) { setMsg("✗ " + e.message, false); psave.disabled = false; });
      });
      acts.appendChild(pb);
      card.appendChild(acts); card.appendChild(pwrow); card.appendChild(msg);
      return card;
    }

    card.appendChild(acts); card.appendChild(msg);
    return card;
  }

  var _panel = null;
  function refresh() {
    if (!_panel) return;
    var body = _panel.querySelector("#aibox-cx-body");
    body.textContent = "Chargement…";
    jfetch(API + "/inventory").then(function (d) {
      body.innerHTML = "";
      var sub = _panel.querySelector(".aibox-cx-sub");
      if (sub && d.summary) sub.textContent = d.summary.configured + " / " + d.summary.total + " intégration(s) active(s)";
      (d.categories || []).forEach(function (cat) {
        var h = document.createElement("div"); h.className = "aibox-cx-cat"; h.textContent = cat.name;
        body.appendChild(h);
        cat.items.forEach(function (it) { body.appendChild(boxCard(it)); });
      });
      body.appendChild(odooForm(d));
    }).catch(function (e) {
      body.innerHTML = "";
      var er = document.createElement("div"); er.style.color = "#f87171";
      er.textContent = "Impossible de charger les connexions (" + e.message + "). Recharge la page si la session a expiré.";
      body.appendChild(er);
    });
  }

  function openPanel() {
    injectCSS();
    close();
    var ov = document.createElement("div"); ov.id = "aibox-cx-ov";
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    var p = document.createElement("div"); p.id = "aibox-cx-panel"; _panel = p;
    var head = document.createElement("div"); head.style.cssText = "display:flex;align-items:center;";
    var title = document.createElement("h2"); title.textContent = "Connexions";
    var x = document.createElement("button"); x.className = "aibox-cx-close"; x.textContent = "×"; x.addEventListener("click", close);
    head.appendChild(title); head.appendChild(x);
    var sub = document.createElement("div"); sub.className = "aibox-cx-sub"; sub.textContent = "Chargement…";
    var bodyEl = document.createElement("div"); bodyEl.id = "aibox-cx-body";
    var foot = document.createElement("div"); foot.className = "aibox-cx-foot";
    foot.textContent = "Déconnecter met la boîte en pause (réversible). Les boîtes Microsoft 365 utilisent l'authentification par application (pas de mot de passe individuel).";
    p.appendChild(head); p.appendChild(sub); p.appendChild(bodyEl); p.appendChild(foot);
    ov.appendChild(p); document.body.appendChild(ov);
    refresh();
  }

  // Déduit le chemin d'un connecteur MCP à partir d'un autre installé (portable).
  function deriveCmd(items, target) {
    // On ne connaît pas les commandes côté /inventory ; on lit /api/mcp/servers.
    return jfetch("/api/mcp/servers").then(function (d) {
      var servers = (d && d.servers) || [];
      for (var i = 0; i < servers.length; i++) {
        var s = servers[i];
        if (!s.command || String(s.command).indexOf("mcp-connectors/") < 0) continue;
        return {
          command: String(s.command).replace(/mcp-connectors\/[^/]+\//, "mcp-connectors/" + target + "/"),
          args: (s.args || []).map(function (a) { return String(a).replace(/mcp-connectors\/[^/]+\//, "mcp-connectors/" + target + "/"); }),
        };
      }
      return null;
    });
  }

  function odooForm(inv) {
    var hasOdoo = (inv.categories || []).some(function (c) { return (c.items || []).some(function (it) { return it.id === "odoo" && it.kind !== "ERP"; }); });
    var wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:1rem;border-top:1px solid rgba(255,255,255,.1);padding-top:.7rem";
    var title = document.createElement("div");
    title.style.cssText = "font-weight:600;cursor:pointer";
    title.textContent = "⚙️ " + (hasOdoo ? "Reconfigurer Odoo" : "Configurer Odoo");
    var form = document.createElement("div"); form.style.display = "none"; form.style.marginTop = ".6rem";
    title.addEventListener("click", function () { form.style.display = form.style.display === "none" ? "block" : "none"; });
    function field(label, ph, type) {
      var l = document.createElement("label"); l.style.cssText = "display:block;font-size:.78rem;color:#9ca3af;margin:.45rem 0 .15rem"; l.textContent = label;
      var i = document.createElement("input"); i.type = type || "text"; i.placeholder = ph || "";
      i.style.cssText = "width:100%;box-sizing:border-box;padding:.4rem .55rem;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:inherit;font:inherit";
      form.appendChild(l); form.appendChild(i); return i;
    }
    var u = field("URL Odoo", "https://odoo.exemple.fr"), db = field("Base de données", "nom_base"),
        lg = field("Login", "prenom.nom@exemple.fr"), k = field("Clé API Odoo", "collée ici — jamais affichée", "password");
    var msg = document.createElement("div"); msg.className = "aibox-cx-msg";
    var b = document.createElement("button"); b.className = "aibox-cx-btn2"; b.style.marginTop = ".6rem"; b.textContent = "Enregistrer et connecter";
    b.addEventListener("click", function () {
      if (!u.value || !db.value || !lg.value || !k.value) { msg.style.color = "#f87171"; msg.textContent = "Tous les champs sont requis."; return; }
      b.disabled = true; msg.style.color = "#9ca3af"; msg.textContent = "Enregistrement…";
      deriveCmd(null, "odoo").then(function (d) {
        if (!d) throw new Error("chemin connecteur introuvable");
        return jfetch("/api/mcp/servers/odoo", { method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: d.command, args: d.args, timeout: 60, env: { ODOO_URL: u.value.trim(), ODOO_DB: db.value.trim(), ODOO_USERNAME: lg.value.trim(), ODOO_API_KEY: k.value } }) });
      }).then(function () { msg.style.color = "#16a34a"; msg.textContent = "✓ Odoo enregistré."; k.value = ""; setTimeout(refresh, 1000); })
        .catch(function (e) { msg.style.color = "#f87171"; msg.textContent = "Échec : " + e.message; b.disabled = false; });
    });
    form.appendChild(msg); form.appendChild(b);
    wrap.appendChild(title); wrap.appendChild(form);
    return wrap;
  }

  // ── Item dans le menu de gauche (rail natif), au même style que les autres ──
  function addRailItem() {
    var rail = document.querySelector("nav.rail");
    if (!rail || rail.querySelector("#aibox-cx-rail")) return;
    var btn = document.createElement("button");
    btn.id = "aibox-cx-rail";
    btn.className = "rail-btn nav-tab has-tooltip aibox-cx-rail";
    btn.setAttribute("data-tooltip", "Connexions");
    btn.setAttribute("aria-label", "Connexions");
    btn.type = "button";
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v6"/></svg>';
    btn.addEventListener("click", openPanel);
    var spacer = rail.querySelector(".rail-spacer");
    if (spacer) rail.insertBefore(btn, spacer); else rail.appendChild(btn);
  }

  function boot() {
    injectCSS();
    addRailItem();
    setInterval(addRailItem, 2500);  // ré-injecte si la SPA redessine le rail
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
