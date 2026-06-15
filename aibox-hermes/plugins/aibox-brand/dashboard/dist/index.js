// Plugin dashboard — PRÉSENTATION CLIENT (update-safe, hors ~/hermes-agent/).
//  1) WHITE-LABEL : « Hermes Agent » / « Hermes » / « Nous Research » → « AI Box »
//     (chrome : logo, footer, libellés, titre d'onglet).
//  2) MENUS PAR RÔLE : un user « client » ne voit QUE le chat — on masque toute
//     la barre latérale (nav technique + contrôles admin), le chat passe en plein
//     écran (il a ses propres contrôles : conversations, nouvelle, modèle).
//     Le rôle vient de /aibox-chat/session ({role:"client"|"admin"}).
// Robuste (texte + CSS + MutationObserver), n'affecte PAS les iframes (chat/doc).
(function () {
  "use strict";
  var BRAND = "AI Box";
  window.__HERMES_PLUGINS__.register("aibox-brand", function () { return null; });

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
      // Logo : la marque était en 2 nœuds (« Hermes » + « Agent ») → recolle « AI Box »
      var els = document.querySelectorAll("aside *, header *");
      for (var k = 0; k < els.length; k++) {
        var el = els[k];
        if (el.children.length <= 2) {
          var t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (/^(AI Box|Hermes)\s*Agent$/i.test(t)) el.textContent = BRAND;
        }
      }
      // Attributs visibles
      var av = document.querySelectorAll('[title*="Hermes"],[aria-label*="Hermes"],[placeholder*="Hermes"]');
      for (var j = 0; j < av.length; j++) ["title", "aria-label", "placeholder"].forEach(function (a) {
        var v = av[j].getAttribute(a); if (v && TEST.test(v)) av[j].setAttribute(a, clean(v));
      });
    } finally { busy = false; }
  }

  // Mode client : masque toute la barre latérale (le chat reste, en plein écran).
  function applyClientCSS() {
    if (document.getElementById("aibox-client-style")) return;
    var st = document.createElement("style"); st.id = "aibox-client-style";
    st.textContent = "aside{display:none !important;}";
    document.head.appendChild(st);
  }

  var sched = false;
  function schedule() { if (sched) return; sched = true; setTimeout(function () { sched = false; relabel(); }, 150); }
  function start(client) {
    relabel();
    if (client) applyClientCSS();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(relabel, 2000);
  }
  function go(role) {
    var client = role === "client";
    if (document.body) start(client);
    else window.addEventListener("DOMContentLoaded", function () { start(client); });
  }
  function boot() {
    // Source de vérité = plugin de gestion des droits ; repli sur /aibox-chat/session.
    fetch("/api/plugins/aibox-rights/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.role) return j.role;
        return fetch("/aibox-chat/session", { credentials: "same-origin", cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : {}; }).then(function (k) { return (k && k.role) || "admin"; });
      })
      .then(go).catch(function () { go("admin"); });
  }
  boot();
})();
