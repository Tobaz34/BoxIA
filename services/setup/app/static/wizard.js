// AI Box - Wizard de configuration
const state = {
  step: 1,
  data: {
    client_name: '',
    client_sector: 'services',
    users_count: 10,
    domain: '',
    admin_fullname: '',
    admin_username: '',
    admin_email: '',
    admin_password: '',
    hw_profile: 'tpe',
    technologies: {},
  },
  questionnaire: null,
};

function checkPasswordStrength(p) {
  if (!p) return { ok: false, msg: '' };
  if (p.length < 12) return { ok: false, msg: '⚠ Trop court (12 caractères minimum)' };
  if (!/[A-Z]/.test(p)) return { ok: false, msg: '⚠ Manque une majuscule' };
  if (!/[0-9]/.test(p)) return { ok: false, msg: '⚠ Manque un chiffre' };
  if (!/[^A-Za-z0-9]/.test(p)) return { ok: false, msg: '⚠ Manque un caractère spécial' };
  return { ok: true, msg: '✓ Mot de passe robuste' };
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'admin_password') {
    const r = checkPasswordStrength(e.target.value);
    const el = document.getElementById('pwd-strength');
    if (el) {
      el.textContent = r.msg;
      el.style.color = r.ok ? 'var(--accent)' : 'var(--warn)';
    }
  }
});

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
    state.data.admin_password = document.getElementById('admin_password').value;
    const confirm = document.getElementById('admin_password_confirm').value;

    if (!state.data.domain) { alert('Le domaine est requis'); return false; }
    if (!state.data.admin_fullname) { alert('Nom complet requis'); return false; }
    if (!state.data.admin_username || !/^[a-z0-9_]+$/.test(state.data.admin_username)) {
      alert('Identifiant invalide (lettres minuscules, chiffres, underscore uniquement)');
      return false;
    }
    if (!state.data.admin_email) { alert('Email requis'); return false; }

    const pwd = checkPasswordStrength(state.data.admin_password);
    if (!pwd.ok) { alert('Mot de passe trop faible : ' + pwd.msg); return false; }
    if (state.data.admin_password !== confirm) {
      alert('Les mots de passe ne correspondent pas');
      return false;
    }
  }
  if (step === 3) {
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
  return true;
}

function next(from) {
  if (!gather(from)) return;
  if (from === 2 && !state.questionnaire) loadQuestionnaire();
  if (from === 3) renderRecap();
  show(from + 1);
}

function prev(from) { show(from - 1); }

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
  document.getElementById('recap').textContent =
    `Entreprise   : ${d.client_name}\n` +
    `Secteur      : ${d.client_sector}\n` +
    `Utilisateurs : ${d.users_count}\n` +
    `Profil HW    : ${d.hw_profile}\n` +
    `Domaine      : ${d.domain}\n\n` +
    `Compte administrateur (premier utilisateur) :\n` +
    `  Nom    : ${d.admin_fullname}\n` +
    `  Login  : ${d.admin_username}\n` +
    `  Email  : ${d.admin_email}\n` +
    `  Mot de passe : (saisi par vous, non affiché)\n\n` +
    `Technologies sélectionnées :\n${techs}${actsStr}`;
}

async function deploy() {
  show(5);
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
      out.textContent += '\n[1/2] Création du compte administrateur dans Authentik...\n';
      try {
        const r3 = await fetch('/api/deploy/create-admin-user', { method: 'POST' });
        const j3 = await r3.json();
        if (j3.created) out.textContent += '  ✓ Authentik : compte créé (ou mis à jour)\n';
        else out.textContent += '  ⚠ Authentik : ' + (j3.stderr || 'non créé') + '\n';
      } catch (e) {
        out.textContent += '  ⚠ Erreur Authentik : ' + e + '\n';
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
      } catch (e) {
        out.textContent += '  ⚠ Erreur import templates : ' + e + '\n';
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
