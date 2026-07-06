// Onglet « Connexions » — inventaire des intégrations AI Box (email, compta,
// SharePoint, Odoo…). État CONFIGURÉ instantané + test de connexion à la demande.
// Backend : /api/plugins/aibox-connections/. IIFE, SDK window.__HERMES_PLUGIN_SDK__.
(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React, h = React.createElement, H = SDK.hooks, C = SDK.components;

  var CATEGORY_ICON = { "Email": "✉️", "Comptabilité": "🧾", "Documents": "📁", "ERP / CRM": "🏢", "Support IT": "🛠️" };

  function Dot(color) {
    return h("span", { style: { display: "inline-block", width: "9px", height: "9px", borderRadius: "50%", background: color, marginRight: ".5rem", flex: "0 0 auto" } });
  }

  function Row(props) {
    var it = props.item, chk = props.check, onTest = props.onTest;
    var color = it.configured ? "#16a34a" : "#9ca3af";
    var statusTxt = it.configured ? "Configuré" : "Non configuré";
    if (chk) { if (chk.loading) { color = "#f59e0b"; statusTxt = "Test…"; } else if (chk.ok) { color = "#16a34a"; statusTxt = "Connecté ✓"; } else { color = "#dc2626"; statusTxt = "Échec"; } }
    var rowS = { display: "flex", alignItems: "center", gap: ".5rem", padding: ".6rem .5rem", borderBottom: "1px solid var(--color-border)" };
    var detail = (chk && chk.message) ? chk.message : it.detail;
    return h("div", { style: rowS },
      Dot(color),
      h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
        h("div", { style: { fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, it.label),
        h("div", { style: { fontSize: ".78rem", color: "var(--color-muted-foreground)" } },
          it.kind + " · " + detail + (chk && chk.latency_ms != null && chk.ok ? "  (" + chk.latency_ms + " ms)" : ""))),
      h("div", { style: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: ".6rem" } },
        h("span", { style: { fontSize: ".8rem", color: color } }, statusTxt),
        it.checkable ? h("button", {
          onClick: onTest, disabled: chk && chk.loading,
          style: { padding: ".3rem .7rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-input)", color: "inherit", font: "inherit", fontSize: ".8rem", cursor: "pointer" },
        }, chk && chk.loading ? "…" : "Tester") : null));
  }

  function Page() {
    var st = H.useState({ loading: true, cats: [], summary: null, err: null }); var s = st[0], set = st[1];
    var ck = H.useState({}); var checks = ck[0], setChecks = ck[1];

    function load() {
      set({ loading: true, cats: [], summary: null, err: null });
      SDK.fetchJSON("/api/plugins/aibox-connections/inventory")
        .then(function (d) { set({ loading: false, cats: (d && d.categories) || [], summary: d && d.summary, err: null }); })
        .catch(function () { set({ loading: false, cats: [], summary: null, err: "Impossible de charger l'inventaire des connexions." }); });
    }
    H.useEffect(load, []);

    function test(id) {
      setChecks(function (p) { var n = Object.assign({}, p); n[id] = { loading: true }; return n; });
      SDK.fetchJSON("/api/plugins/aibox-connections/check/" + encodeURIComponent(id))
        .then(function (r) { setChecks(function (p) { var n = Object.assign({}, p); n[id] = { loading: false, ok: !!r.ok, message: r.message, latency_ms: r.latency_ms }; return n; }); })
        .catch(function () { setChecks(function (p) { var n = Object.assign({}, p); n[id] = { loading: false, ok: false, message: "erreur réseau" }; return n; }); });
    }

    function testAllIn(items) { items.forEach(function (it) { if (it.checkable) test(it.id); }); }

    var body;
    if (s.loading) body = h("p", { className: "text-sm text-muted-foreground" }, "Chargement…");
    else if (s.err) body = h("p", { className: "text-sm text-destructive" }, s.err);
    else body = h("div", null, s.cats.map(function (cat) {
      return h("div", { key: cat.name, style: { marginBottom: "1.4rem" } },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ".4rem" } },
          h("h3", { style: { fontSize: ".95rem", fontWeight: 700, margin: 0 } },
            (CATEGORY_ICON[cat.name] || "•") + "  " + cat.name),
          h("button", {
            onClick: function () { testAllIn(cat.items); },
            style: { padding: ".25rem .6rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-muted-foreground)", font: "inherit", fontSize: ".75rem", cursor: "pointer" },
          }, "Tout tester")),
        h("div", { style: { border: "1px solid var(--color-border)", borderRadius: "10px", overflow: "hidden" } },
          cat.items.map(function (it, i) {
            return h("div", { key: it.id },
              Row({ item: it, check: checks[it.id], onTest: function () { test(it.id); } }));
          })));
    }));

    var sub = s.summary ? (s.summary.configured + " / " + s.summary.total + " intégration(s) configurée(s)") : "";
    return h(C.Card, null,
      h(C.CardHeader, null,
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("div", null,
            h(C.CardTitle, null, "Connexions"),
            sub ? h("p", { style: { margin: ".2rem 0 0", fontSize: ".82rem", color: "var(--color-muted-foreground)" } }, sub) : null),
          h("button", {
            onClick: load,
            style: { padding: ".35rem .8rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-input)", color: "inherit", font: "inherit", fontSize: ".82rem", cursor: "pointer" },
          }, "Rafraîchir"))),
      h(C.CardContent, null, body));
  }

  window.__HERMES_PLUGINS__.register("aibox-connections", Page);
})();
