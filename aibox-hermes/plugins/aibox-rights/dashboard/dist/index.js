// Onglet « Utilisateurs » — gestion des droits AI Box (admin uniquement).
// Liste les utilisateurs + bascule le rôle (client/admin). Le backend
// (/api/plugins/aibox-rights/) refuse aux non-admins. Le rôle pilote les menus
// visibles (cf. plugin aibox-brand). IIFE, SDK window.__HERMES_PLUGIN_SDK__.
(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React, h = React.createElement, H = SDK.hooks, C = SDK.components;
  var thS = { textAlign: "left", padding: ".55rem .5rem", borderBottom: "1px solid var(--color-border)", fontSize: ".78rem", textTransform: "uppercase", letterSpacing: ".03em", color: "var(--color-muted-foreground)" };
  var tdS = { padding: ".55rem .5rem", borderBottom: "1px solid var(--color-border)", verticalAlign: "middle" };

  function Page() {
    var st = H.useState({ loading: true, users: [], err: null, saved: "" }); var s = st[0], set = st[1];
    H.useEffect(function () {
      SDK.fetchJSON("/api/plugins/aibox-rights/users")
        .then(function (d) { set({ loading: false, users: (d && d.users) || [], err: null, saved: "" }); })
        .catch(function () { set({ loading: false, users: [], err: "Cette page est réservée aux administrateurs.", saved: "" }); });
    }, []);

    function change(user, role) {
      SDK.fetchJSON("/api/plugins/aibox-rights/set", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: user, role: role }),
      }).then(function () {
        set(function (p) {
          return Object.assign({}, p, {
            saved: user,
            users: p.users.map(function (u) { return u.user === user ? { user: user, role: role } : u; }),
          });
        });
      }).catch(function () {});
    }

    var body;
    if (s.loading) body = h("p", { className: "text-sm text-muted-foreground" }, "Chargement…");
    else if (s.err) body = h("p", { className: "text-sm text-destructive" }, s.err);
    else body = h("div", null,
      h("p", { className: "text-sm text-muted-foreground", style: { marginBottom: "1rem" } },
        "« client » = fenêtre de chat plein écran uniquement. « admin » = accès complet au tableau de bord. " +
        "Une modification s'applique au prochain rechargement de la session de l'utilisateur."),
      h("table", { style: { width: "100%", borderCollapse: "collapse" } },
        h("thead", null, h("tr", null,
          h("th", { style: thS }, "Utilisateur"), h("th", { style: thS }, "Rôle"), h("th", { style: thS }, ""))),
        h("tbody", null, (s.users || []).map(function (u) {
          return h("tr", { key: u.user },
            h("td", { style: tdS }, h("strong", null, u.user)),
            h("td", { style: tdS },
              h("select", {
                value: u.role, onChange: function (e) { change(u.user, e.target.value); },
                style: { padding: ".35rem .6rem", borderRadius: "8px", background: "var(--color-input)", color: "inherit", border: "1px solid var(--color-border)", font: "inherit" },
              }, h("option", { value: "client" }, "client"), h("option", { value: "admin" }, "admin"))),
            h("td", { style: tdS }, s.saved === u.user ? h("span", { style: { color: "#16a34a", fontSize: ".82rem" } }, "✓ enregistré") : ""));
        }))));

    return h(C.Card, null,
      h(C.CardHeader, null, h(C.CardTitle, null, "Utilisateurs & droits")),
      h(C.CardContent, null, body));
  }
  window.__HERMES_PLUGINS__.register("aibox-rights", Page);
})();
