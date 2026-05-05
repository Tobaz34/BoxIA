// AI Box - Wizard de configuration
//
// Note : pas de saisie de mot de passe ici. La box est livrée avec un
// mot de passe par défaut (aibox-changeme2026) que l'utilisateur devra changer
// à sa 1re connexion. Plus simple, plus tolérant aux fautes de frappe,
// pratique appliance standard (Synology / TrueNAS / Proxmox).
const DEFAULT_ADMIN_PASSWORD = 'aibox-changeme2026';
const state = {
  step: 1,
  data: {
    client_name: '',
    client_sector: 'services',
    users_count: 10,
    domain: '',
    admin_fullname: '',
    admin_username: 'admin',
    admin_email: '',
    admin_password: DEFAULT_ADMIN_PASSWORD,
    hw_profile: 'tpe',
    technologies: {},
    // Cloudflare (rempli à l'étape 3, validé via /api/cloudflare/test)
    cloudflare_subdomain: '',
    cf_account_id: '',
    cf_tunnel_id: '',
    cf_api_token: '',
    cf_zone_id: '',
    // Branding (étape 5, optionnel)
    brand_name_display: '',
    brand_logo_url: '',
    brand_primary_color: '#3b82f6',
    brand_accent_color: '#10b981',
    brand_footer_text: '',
  },
  questionnaire: null,
  cloudflareDefaults: null,  // chargé via /api/cloudflare/defaults au load
  cloudflareValidated: false,  // bouton Suivant désactivé tant que !validé
};

function show(step) {
  document.querySelectorAll('.step-content').forEach(el => {
    el.hidden = parseInt(el.dataset.step) !== step;
  });
  document.querySelectorAll('.progress .step').forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.toggle('active', s === step);
    el.classList.toggle('done', s < step);
  });
  state.step = step;
}

function gather(step) {
  if (step === 1) {
    state.data.client_name = document.getElementById('client_name').value.trim();
    state.data.client_sector = document.getElementById('client_sector').value;
    state.data.users_count = parseInt(document.getElementById('users_count').value);
    state.data.hw_profile = document.getElementById('hw_profile').value;
    if (!state.data.client_name) { alert('Le nom de l\'entreprise est requis'); return false; }
  }
  if (step === 2) {
    state.data.domain = document.getElementById('domain').value.trim().toLowerCase();
    state.data.admin_fullname = document.getElementById('admin_fullname').value.trim();
    state.data.admin_username = document.getElementById('admin_username').value.trim().toLowerCase();
    state.data.admin_email = document.getElementById('admin_email').value.trim();
    // Mot de passe par défaut (constant) — l'utilisateur le changera à
    // sa 1re connexion. Pas de saisie ici → pas de risque de faute de frappe.
    state.data.admin_password = DEFAULT_ADMIN_PASSWORD;

    if (!state.data.domain) { alert('Le domaine est requis'); return false; }
    if (!state.data.admin_fullname) { alert('Nom complet requis'); return false; }
    if (!state.data.admin_username || !/^[a-z0-9_]+$/.test(state.data.admin_username)) {
      alert('Identifiant invalide (lettres minuscules, chiffres, underscore uniquement)');
      return false;
    }
    if (!state.data.admin_email) { alert('Email requis'); return false; }
  }
  if (step === 3) {
    // Cloudflare obligatoire
    state.data.cloudflare_subdomain = document.getElementById('cloudflare_subdomain').value.trim().toLowerCase();
    state.data.cf_account_id = document.getElementById('cf_account_id').value.trim();
    state.data.cf_tunnel_id = document.getElementById('cf_tunnel_id').value.trim();
    state.data.cf_api_token = document.getElementById('cf_api_token').value.trim();
    state.data.cf_zone_id = document.getElementById('cf_zone_id').value.trim();
    if (!/^[a-z0-9-]{2,30}$/.test(state.data.cloudflare_subdomain)) {
      alert('Sous-domaine invalide (lettres minuscules, chiffres, tiret, 2-30 chars)');
      return false;
    }
    if (!state.cloudflareValidated) {
      alert('Cliquez d\'abord sur « Tester la connexion Cloudflare » pour valider les credentials');
      return false;
    }
  }
  if (step === 4) {
    state.data.technologies = {};
    state.data.activates = [];
    document.querySelectorAll('#questionnaire select.item-input').forEach(sel => {
      const id = sel.dataset.id;
      const val = sel.value;
      const opt = sel.options[sel.selectedIndex];
      const acts = (opt.dataset.activates || '').split(',').filter(Boolean);
      // 'none' / vide = pas concerné
      state.data.technologies[id] = (val && val !== 'none') ? val : false;
      acts.forEach(a => state.data.activates.push(a));
    });
  }
  if (step === 5) {
    // Branding (tout optionnel — pas de validation bloquante)
    state.data.brand_name_display = document.getElementById('brand_name_display').value.trim();
    state.data.brand_logo_url = document.getElementById('brand_logo_url').value.trim();
    state.data.brand_primary_color = document.getElementById('brand_primary_color').value;
    state.data.brand_accent_color = document.getElementById('brand_accent_color').value;
    state.data.brand_footer_text = document.getElementById('brand_footer_text').value.trim();
  }
  return true;
}

function next(from) {
  if (!gather(from)) return;
  // Pré-charge le questionnaire à l'arrivée sur l'étape 4 (ex-étape 3)
  if (from === 3 && !state.questionnaire) loadQuestionnaire();
  if (from === 5) renderRecap();
  show(from + 1);
}

function prev(from) { show(from - 1); }

async function loadCloudflareDefaults() {
  try {
    const r = await fetch('/api/cloudflare/defaults');
    const j = await r.json();
    state.cloudflareDefaults = j;

    // Met à jour le suffix affiché .ialocal.pro / .autre-domaine.pro
    const root = document.getElementById('cf_root_domain');
    if (root) root.textContent = j.root_domain || 'ialocal.pro';

    // Si l'admin a pré-injecté les 4 IDs CF via env du container, on
    // pré-remplit les champs ET on cache la section "Credentials master"
    // (le client final ne devrait pas les voir).
    if (j.has_master_creds) {
      const acc = document.getElementById('cf_account_id');
      const tun = document.getElementById('cf_tunnel_id');
      const zone = document.getElementById('cf_zone_id');
      const tok = document.getElementById('cf_api_token');
      if (acc) acc.value = j.account_id;
      if (tun) tun.value = j.tunnel_id;
      if (zone) zone.value = j.zone_id;
      // Token : on n'a pas la valeur (sensible) côté API, on met un placeholder
      // qui sera renvoyé tel quel — le backend remplacera par celui de l'env.
      if (tok) {
        tok.value = '__USE_MASTER_TOKEN__';
        tok.placeholder = '(injecté depuis env du container)';
      }
      // Cache la section credentials
      const sec = document.getElementById('cf_master_creds_section');
      if (sec) sec.hidden = true;
    }
  } catch (e) {
    console.warn('Cloudflare defaults indisponibles :', e);
  }
}

async function testCloudflare() {
  const btn = document.getElementById('cf_test_btn');
  const result = document.getElementById('cf_test_result');
  const nextBtn = document.getElementById('cf_next_btn');

  // Capture les valeurs sans appeler gather() (qui bloquerait sur cloudflareValidated)
  const subdomain = document.getElementById('cloudflare_subdomain').value.trim().toLowerCase();
  const account = document.getElementById('cf_account_id').value.trim();
  const tunnel = document.getElementById('cf_tunnel_id').value.trim();
  const token = document.getElementById('cf_api_token').value.trim();
  const zone = document.getElementById('cf_zone_id').value.trim();

  if (!/^[a-z0-9-]{2,30}$/.test(subdomain)) {
    result.innerHTML = '<span style="color:var(--danger)">✗ Sous-domaine invalide</span>';
    return;
  }
  if (!account || !tunnel || !token || !zone) {
    result.innerHTML = '<span style="color:var(--danger)">✗ Tous les champs Cloudflare sont requis</span>';
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Test en cours…';
  result.innerHTML = '<span style="color:var(--muted)">Validation auprès de l\'API Cloudflare…</span>';

  try {
    const r = await fetch('/api/cloudflare/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cloudflare_subdomain: subdomain,
        cf_account_id: account,
        cf_tunnel_id: tunnel,
        cf_api_token: token,
        cf_zone_id: zone,
      }),
    });
    const j = await r.json();

    if (!r.ok) {
      const detail = j.detail || j;
      const msg = detail.message || j.error || `HTTP ${r.status}`;
      result.innerHTML = `<span style="color:var(--danger)">✗ ${msg}</span>`;
      state.cloudflareValidated = false;
      nextBtn.disabled = true;
    } else {
      const warning = j.subdomain_already_used
        ? `<br><span style="color:var(--warning,#fa0)">⚠ ${j.existing_records_count} record(s) DNS existent déjà pour ${j.subdomain_full} — ils seront remplacés</span>`
        : '';
      result.innerHTML = `<span style="color:var(--success,#3a3)">✓ Tunnel « ${j.tunnel_name} », zone « ${j.zone_name} ». URL future : <code>https://${j.subdomain_full}</code></span>${warning}`;
      state.cloudflareValidated = true;
      nextBtn.disabled = false;
    }
  } catch (e) {
    result.innerHTML = `<span style="color:var(--danger)">✗ Erreur réseau : ${e}</span>`;
    state.cloudflareValidated = false;
    nextBtn.disabled = true;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Tester la connexion Cloudflare';
  }
}

async function loadQuestionnaire() {
  try {
    const r = await fetch('/api/questionnaire');
    const q = await r.json();
    state.questionnaire = q;
    renderQuestionnaire(q);
  } catch (e) {
    document.getElementById('questionnaire').innerHTML =
      '<p style="color:var(--danger)">Impossible de charger le questionnaire : ' + e + '</p>';
  }
}

function renderQuestionnaire(q) {
  const root = document.getElementById('questionnaire');
  root.innerHTML = '';
  // Le YAML "essentials" a un champ `items:` au top niveau (pas de chapitres).
  // Pour rétro-compat avec le YAML complet, on accepte aussi `chapters[].items`.
  const items = q.items || (q.chapters || []).flatMap(c => c.items);

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'q-item';
    const optsHtml = (item.options || []).map(o => {
      const acts = (o.activates || []).join(',');
      return `<option value="${o.value || o}" data-activates="${acts}">${o.label || o}</option>`;
    }).join('');
    const hint = item.hint ? `<small class="hint">${item.hint}</small>` : '';
    div.innerHTML = `
      <div class="q-head">
        <span class="q-icon">${item.icon || '•'}</span>
        <label class="q-label" for="q-${item.id}">${item.label}</label>
      </div>
      ${hint}
      <select class="item-input" id="q-${item.id}" data-id="${item.id}">
        ${optsHtml}
      </select>
    `;
    root.appendChild(div);
  });
}

function renderRecap() {
  const d = state.data;
  const techs = Object.entries(d.technologies)
    .filter(([k, v]) => v)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n') || '  (aucune technologie spécifique sélectionnée)';
  const acts = (d.activates || []).filter((v, i, a) => a.indexOf(v) === i);
  const actsStr = acts.length
    ? `\nConnecteurs/templates qui seront activés :\n${acts.map(a => '  ✓ ' + a).join('\n')}`
    : '\n(aucune activation spécifique — IA générique uniquement)';

  const cfRoot = (state.cloudflareDefaults && state.cloudflareDefaults.root_domain) || 'ialocal.pro';
  const publicUrl = d.cloudflare_subdomain
    ? `https://${d.cloudflare_subdomain}.${cfRoot}`
    : '(non configuré — mode LAN-only)';

  const brandSummary = (d.brand_logo_url || d.brand_footer_text || d.brand_name_display
    || d.brand_primary_color !== '#3b82f6' || d.brand_accent_color !== '#10b981')
    ? `\n  Nom affiché : ${d.brand_name_display || '(défaut : ' + d.client_name + ')'}\n` +
      `  Logo URL    : ${d.brand_logo_url || '(défaut : hexagone)'}\n` +
      `  Couleur primaire : ${d.brand_primary_color}\n` +
      `  Couleur accent   : ${d.brand_accent_color}\n` +
      `  Footer      : ${d.brand_footer_text || '(vide)'}`
    : '\n  (défauts — modifiable plus tard via Paramètres → Branding)';

  document.getElementById('recap').textContent =
    `Entreprise   : ${d.client_name}\n` +
    `Secteur      : ${d.client_sector}\n` +
    `Utilisateurs : ${d.users_count}\n` +
    `Profil HW    : ${d.hw_profile}\n` +
    `Domaine LAN  : ${d.domain}\n` +
    `URL publique : ${publicUrl}\n\n` +
    `Compte administrateur (premier utilisateur) :\n` +
    `  Nom    : ${d.admin_fullname}\n` +
    `  Login  : ${d.admin_username}\n` +
    `  Email  : ${d.admin_email}\n` +
    `  Mot de passe par défaut : ${DEFAULT_ADMIN_PASSWORD}\n` +
    `  ⚠ À CHANGER à la 1re connexion (rappel automatique dans l'app)\n\n` +
    `Branding :${brandSummary}\n\n` +
    `Technologies sélectionnées :\n${techs}${actsStr}`;
}

async function deploy() {
  show(7);
  const out = document.getElementById('log-output');
  out.textContent = 'Génération de la configuration...\n';

  try {
    // 1. Configure
    const r1 = await fetch('/api/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.data),
    });
    if (!r1.ok) throw new Error('configure: ' + await r1.text());
    await r1.json();
    out.textContent += '✓ Configuration écrite\n\n';

    // 2. Connecte WS pour les logs
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${wsProto}://${location.host}/api/deploy/logs`);
    ws.onmessage = (e) => {
      out.textContent += e.data + '\n';
      out.scrollTop = out.scrollHeight;
    };

    // 3. Lance le déploiement
    out.textContent += 'Démarrage des containers...\n';
    const r2 = await fetch('/api/deploy/start', { method: 'POST' });
    if (!r2.ok) throw new Error('deploy/start: ' + await r2.text());

    // 4. Attente puis création des comptes admin
    setTimeout(async () => {
      out.textContent += '\n[1/3] Création du compte administrateur dans Authentik...\n';
      try {
        const r3 = await fetch('/api/deploy/create-admin-user', { method: 'POST' });
        const j3 = await r3.json();
        if (r3.ok && j3.created) {
          out.textContent += '  ✓ Authentik : compte créé (tentative ' + (j3.attempt || '?') + ')\n';
        } else {
          // CRITIQUE : sans user admin, OIDC ne pourra pas marcher → on STOPPE
          // au lieu de continuer en mode dégradé silencieux.
          const detail = (j3.detail && typeof j3.detail === 'object') ? j3.detail : j3;
          const msg = detail.message || detail.error || 'inconnu';
          const stderr = detail.stderr_tail || j3.stderr || '';
          out.textContent += '\n  ✗ ÉCHEC création admin Authentik : ' + msg + '\n';
          if (stderr) out.textContent += '    stderr: ' + stderr.slice(0, 200) + '\n';
          out.textContent += '\n  → Le wizard s\'arrête. Une fois le problème résolu :\n';
          out.textContent += '    sudo /srv/ai-stack/recover-admin-password.sh --random\n';
          out.textContent += '    (créera/reset l\'admin et synchronisera .env)\n';
          throw new Error('create-admin failed; stopping deploy flow');
        }
      } catch (e) {
        if (String(e).includes('stopping deploy flow')) return;  // déjà loggé
        out.textContent += '  ✗ Erreur réseau Authentik : ' + e + '\n';
        return;  // STOP : pas de provision-sso si pas de user
      }

      // 5. Provisioning SSO + comptes locaux pour OWUI / Dify / n8n
      out.textContent += '\n[2/3] Provisioning SSO + comptes admin locaux (OWUI, Dify, n8n)...\n';
      try {
        const r4 = await fetch('/api/deploy/provision-sso', { method: 'POST' });
        const j4 = await r4.json();
        for (const [app, res] of Object.entries(j4)) {
          if (res.ok) {
            const action = res.created === false ? 'déjà initialisé' :
                           (res.client_id ? 'OIDC configuré' : 'compte créé');
            out.textContent += '  ✓ ' + app + ' : ' + action + '\n';
          } else {
            out.textContent += '  ⚠ ' + app + ' : ' + (res.reason || res.error || JSON.stringify(res)) + '\n';
          }
        }
      } catch (e) {
        out.textContent += '  ⚠ Erreur provisioning : ' + e + '\n';
      }

      // 6. Auto-import des templates Dify + workflows n8n selon les techs cochées
      out.textContent += '\n[3/3] Import auto des agents IA et workflows pré-configurés...\n';
      try {
        const r5 = await fetch('/api/deploy/import-templates', { method: 'POST' });
        const j5 = await r5.json();
        if (j5.dify) {
          for (const t of j5.dify) {
            const status = t.skipped ? '↻' : (t.ok ? '✓' : '⚠');
            out.textContent += `  ${status} agent Dify : ${t.name || t.id} ${t.skipped || t.error || ''}\n`;
          }
        }
        if (j5.n8n) {
          for (const t of j5.n8n) {
            const status = t.skipped ? '↻' : (t.ok ? '✓' : '⚠');
            out.textContent += `  ${status} workflow n8n : ${t.name || t.id} ${t.skipped || t.error || ''}\n`;
          }
        }
        // Marketplace n8n : workflows par défaut (healthcheck stack, snapshot
        // Qdrant, etc.) ajoutés indépendamment des techs cochées.
        if (j5.n8n_marketplace_defaults) {
          const m = j5.n8n_marketplace_defaults;
          if (m.items && m.items.length) {
            for (const it of m.items) {
              const created = it.created ? '✓' : '↻';
              const active = it.activated ? ' (activé)' : '';
              out.textContent += `  ${created} marketplace n8n : ${it.name || it.file}${active}\n`;
            }
          } else if (m.skipped) {
            out.textContent += `  ↻ marketplace n8n : ${m.skipped}\n`;
          } else if (m.error) {
            out.textContent += `  ⚠ marketplace n8n : ${m.error}\n`;
          }
        }
      } catch (e) {
        out.textContent += '  ⚠ Erreur import templates : ' + e + '\n';
      }

      // 7. Configuration du tunnel Cloudflare (DNS + ingress) si subdomain fourni
      if (state.data.cloudflare_subdomain) {
        out.textContent += '\n[4/4] Configuration du tunnel Cloudflare (DNS + ingress)...\n';
        try {
          const r6 = await fetch('/api/deploy/setup-cloudflare-tunnel', { method: 'POST' });
          const j6 = await r6.json();
          if (j6.ok) {
            out.textContent += '  ✓ Tunnel Cloudflare configuré\n';
            if (j6.stdout_tail) {
              const lines = j6.stdout_tail.split('\n').filter(l => l.includes('✓') || l.includes('→')).slice(-5);
              for (const l of lines) out.textContent += '    ' + l + '\n';
            }
          } else {
            out.textContent += '  ⚠ Cloudflare : ' + (j6.error || 'échec') + '\n';
            if (j6.stderr_tail) out.textContent += '    ' + j6.stderr_tail.slice(0, 200) + '\n';
            out.textContent += '  → Tu peux le relancer manuellement : sudo /srv/ai-stack/tools/setup-cloudflare-tunnel-hostnames.sh\n';
          }
        } catch (e) {
          out.textContent += '  ⚠ Erreur réseau Cloudflare : ' + e + '\n';
        }
      }

      ws.close();
      await fetch('/api/configure/finish', { method: 'POST' });
      finalize();
    }, 25000);

  } catch (e) {
    out.textContent += '\n❌ Erreur : ' + e.message;
    out.style.color = '#f88';
  }
}

function finalize() {
  document.getElementById('logs').hidden = true;
  document.getElementById('success').hidden = false;
  document.getElementById('creds-user').textContent = state.data.admin_username;
  // On ne ré-affiche pas le mdp (le user l'a saisi). On rappelle juste qu'il l'a choisi.
  document.getElementById('creds-pwd').textContent = '(celui que vous avez saisi à l\'étape 2)';
}

function goToDashboard() {
  window.location.href = '/configured';
}

// Init
show(1);
// Charge les credentials CF pré-injectées (si présentes dans l'env du
// container wizard) → permet de cacher la section "Credentials master"
// pour les futures box clients où l'admin BoxIA les a déjà fournies.
loadCloudflareDefaults();

// Pré-active le bouton « Suivant » de l'étape Cloudflare quand l'user
// modifie un champ après un test réussi (= invalide la validation).
['cloudflare_subdomain', 'cf_account_id', 'cf_tunnel_id', 'cf_api_token', 'cf_zone_id'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    if (state.cloudflareValidated) {
      state.cloudflareValidated = false;
      const nextBtn = document.getElementById('cf_next_btn');
      const result = document.getElementById('cf_test_result');
      if (nextBtn) nextBtn.disabled = true;
      if (result) result.innerHTML = '<span style="color:var(--muted)">⚠ Champs modifiés — re-tester</span>';
    }
  });
});
