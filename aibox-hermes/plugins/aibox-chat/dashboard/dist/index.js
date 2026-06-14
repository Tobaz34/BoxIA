// Plugin dashboard Hermes — onglet « Assistant » : intègre la fenêtre de chat
// épurée AI Box (servie à /aibox-chat/) dans le dashboard, en mode embed.
// IIFE sans build : utilise le SDK exposé sur window.__HERMES_PLUGIN_SDK__.
// Update-safe : vit dans $HERMES_HOME/plugins/aibox-chat/dashboard/, jamais
// dans ~/hermes-agent/.
(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var h = React.createElement;

  function AssistantPage() {
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
        src: "/aibox-chat/?embed=1",
        title: "Assistant AI Box",
        loading: "eager",
        allow: "clipboard-write; microphone",
        style: { width: "100%", height: "100%", border: "0", display: "block" },
      })
    );
  }

  window.__HERMES_PLUGINS__.register("aibox-chat", AssistantPage);
})();
