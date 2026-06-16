// AI Box — extension white-label pour hermes-webui (nesquena/hermes-webui).
// UPDATE-SAFE : vit hors du code upstream (HERMES_WEBUI_EXTENSION_DIR), injectée
// via HERMES_WEBUI_EXTENSION_SCRIPT_URLS. Un `git pull` de hermes-webui n'y touche pas.
// Rôle : masquer la marque « Hermes / Nous Research » et afficher « AI Box ».
// Additif & réversible (cf. docs/EXTENSIONS.md) : aucune réécriture de innerHTML,
// garde anti-réinjection, observation des changements pour re-appliquer après i18n.
(function () {
  "use strict";
  if (window.__aiboxBranded) return;          // garde : pas de double-init
  window.__aiboxBranded = true;

  var BRAND = "AI Box";
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
  function schedule() { if (sched) return; sched = true; setTimeout(function () { sched = false; relabel(); }, 150); }
  function start() {
    relabel();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(relabel, 2000); // re-applique après un re-rendu i18n
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
