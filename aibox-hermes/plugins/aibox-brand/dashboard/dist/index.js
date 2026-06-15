// Plugin dashboard — PRÉSENTATION CLIENT (update-safe, hors ~/hermes-agent/).
//  1) WHITE-LABEL : « Hermes Agent » / « Hermes » / « Nous Research » → « AI Box »
//     dans le chrome (logo, footer, libellés, titre d'onglet).
//  2) MENUS PAR RÔLE : un user « client » ne voit QUE le chat ; les onglets
//     techniques (Sessions, Files, MCP, Plugins, Config…) et les contrôles admin
//     sont masqués. Le rôle vient de /aibox-chat/session ({role:"client"|"admin"}).
// Sélecteur-agnostique (texte + CSS par href + MutationObserver) → robuste aux MAJ.
(function () {
  "use strict";
  var BRAND = "AI Box";
  window.__HERMES_PLUGINS__.register("aibox-brand", function () { return null; });

  // --- 1) White-label ---------------------------------------------------------
  var TEST = /Hermes|Nous Research/;
  function clean(s) { return s.replace(/Hermes Agent/g, BRAND).replace(/Hermes/g, BRAND).replace(/Nous Research/g, BRAND); }
  var busy = false;
  function relabel() {
    if (busy || !document.body) return; busy = true;
    try {
      if (TEST.test(document.title)) document.title = clean(document.title);
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n, nodes = [];
      while ((n = w.nextNode())) { if (TEST.test(n.nodeValue)) nodes.push(n); }
      for (var i = 0; i < nodes.length; i++) nodes[i].nodeValue = clean(nodes[i].nodeValue);
      var els = document.querySelectorAll('[title*="Hermes"],[aria-label*="Hermes"],[placeholder*="Hermes"]');
      for (var j = 0; j < els.length; j++) ["title", "aria-label", "placeholder"].forEach(function (a) {
        var v = els[j].getAttribute(a); if (v && TEST.test(v)) els[j].setAttribute(a, clean(v));
      });
      if (CLIENT) hideAdminBits();
    } finally { busy = false; }
  }

  // --- 2) Masquage des menus pour les clients ---------------------------------
  var CLIENT = false;
  // Onglets visibles au client (le reste est masqué) :
  var KEEP = { "/chat": 1, "/documentation": 1 };
  var HIDE = ["/sessions", "/files", "/models", "/logs", "/cron", "/skills", "/plugins",
    "/mcp", "/channels", "/webhooks", "/pairing", "/profiles", "/config", "/env",
    "/system", "/kanban", "/achievements", "/aibox-brand", "/assistant"];
  // Libellés des contrôles admin en pied de barre (FR) à masquer :
  var ADMIN_TXT = /Redémarrer la passerelle|Mettre à jour|État de la passerelle|Sessions actives|Système/i;

  function applyClientCSS() {
    if (document.getElementById("aibox-client-style")) return;
    var css = HIDE.map(function (h) { return 'a[href="' + h + '"]'; }).join(",") + "{display:none !important;}";
    var st = document.createElement("style"); st.id = "aibox-client-style"; st.textContent = css;
    document.head.appendChild(st);
  }
  function hideAdminBits() {
    // Masque les boutons/liens admin du pied de barre par leur libellé.
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n;
    while ((n = w.nextNode())) {
      var t = (n.nodeValue || "").trim();
      if (t && ADMIN_TXT.test(t) && t.length < 40) {
        var el = n.parentElement, hops = 0;
        // remonte jusqu'à un élément cliquable / de section (max 3 niveaux)
        while (el && hops < 3 && !/^(A|BUTTON)$/.test(el.tagName)) { el = el.parentElement; hops++; }
        (el || n.parentElement)?.style && ((el || n.parentElement).style.display = "none");
      }
    }
  }

  // --- bootstrap --------------------------------------------------------------
  var sched = false;
  function schedule() { if (sched) return; sched = true; setTimeout(function () { sched = false; relabel(); }, 150); }
  function start() {
    relabel();
    if (CLIENT) applyClientCSS();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(relabel, 2000);
  }
  function boot() {
    fetch("/aibox-chat/session", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { CLIENT = (j && j.role === "client"); })
      .catch(function () {})
      .finally(function () { if (document.body) start(); else window.addEventListener("DOMContentLoaded", start); });
  }
  boot();
})();
