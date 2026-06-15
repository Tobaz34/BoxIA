// Plugin dashboard — WHITE-LABEL. Remplace la marque « Hermes Agent » / « Hermes »
// / « Nous Research » par « AI Box » dans le chrome du dashboard (logo, pied de
// page, libellés, titre d'onglet), pour que le produit ne révèle pas Hermes au
// client. Update-safe : vit dans $HERMES_HOME/plugins/aibox-brand/, jamais dans
// ~/hermes-agent/. Sélecteur-agnostique (remplacement de texte + MutationObserver),
// donc robuste aux mises à jour du dashboard. N'affecte PAS les iframes (chat/doc).
(function () {
  "use strict";
  var BRAND = "AI Box";
  // Placeholder caché (le plugin n'a pas de page ; il agit sur le DOM).
  window.__HERMES_PLUGINS__.register("aibox-brand", function () { return null; });

  var TEST = /Hermes|Nous Research/;
  function clean(s) {
    return s.replace(/Hermes Agent/g, BRAND).replace(/Hermes/g, BRAND).replace(/Nous Research/g, BRAND);
  }
  var busy = false;
  function relabel() {
    if (busy || !document.body) return;
    busy = true;
    try {
      if (TEST.test(document.title)) document.title = clean(document.title);
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n, nodes = [];
      while ((n = w.nextNode())) { if (TEST.test(n.nodeValue)) nodes.push(n); }
      for (var i = 0; i < nodes.length; i++) nodes[i].nodeValue = clean(nodes[i].nodeValue);
      // Attributs visibles fréquents (title/alt/aria-label/placeholder)
      var els = document.querySelectorAll('[title*="Hermes"],[alt*="Hermes"],[aria-label*="Hermes"],[placeholder*="Hermes"]');
      for (var j = 0; j < els.length; j++) {
        ["title", "alt", "aria-label", "placeholder"].forEach(function (a) {
          var v = els[j].getAttribute(a); if (v && TEST.test(v)) els[j].setAttribute(a, clean(v));
        });
      }
    } finally { busy = false; }
  }
  var sched = false;
  function schedule() { if (sched) return; sched = true; setTimeout(function () { sched = false; relabel(); }, 150); }
  function start() {
    relabel();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(relabel, 2000);   // filet de sécurité (re-render SPA, changements de titre)
  }
  if (document.body) start(); else window.addEventListener("DOMContentLoaded", start);
})();
