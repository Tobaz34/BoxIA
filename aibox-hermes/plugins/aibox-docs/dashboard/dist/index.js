// Plugin dashboard Hermes — remplace l'onglet « Documentation » (qui iframe les
// docs EN LIGNE hermes-agent.nousresearch.com) par la doc complète servie EN
// LOCAL (/aibox-docs/), donc utilisable hors-ligne. Update-safe : vit dans
// $HERMES_HOME/plugins/aibox-docs/dashboard/, jamais dans ~/hermes-agent/.
(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var h = React.createElement;

  function DocsPage() {
    return h(
      "div",
      {
        style: {
          height: "calc(100dvh - 132px)",
          minHeight: "420px",
          width: "100%",
          borderRadius: "12px",
          overflow: "hidden",
          border: "1px solid var(--color-border)",
          background: "var(--color-card)",
        },
      },
      h("iframe", {
        src: "/aibox-docs/",
        title: "Documentation Hermes (locale)",
        loading: "eager",
        style: { width: "100%", height: "100%", border: "0", display: "block" },
      })
    );
  }

  // register() pour la route + override de /docs (cf. manifest).
  window.__HERMES_PLUGINS__.register("aibox-docs", DocsPage);
})();
