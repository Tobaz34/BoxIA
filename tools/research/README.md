# 🔬 Research — Veille comparative agents IA OSS

> Dossier de veille : analyse en profondeur de projets agents IA open source pour
> identifier les patterns à voler, à adapter, à surveiller et les anti-patterns à éviter.
>
> **Méthodologie** : pour chaque projet, un sub-agent dédié clone le repo dans
> `.research-cache/<nom>/` (gitignored), lit le code en profondeur (pas juste le README),
> croise avec notre stack BoxIA (`services/`, `tools/`), et produit un rapport markdown
> autonome avec une structure fixe (10 sections).

## Index des rapports

| Date | Projet | Rapport | Status |
|---|---|---|---|
| 2026-05-05 | **🧪 Synthèse cross-projets (6 projets)** | [00_SYNTHESE.md](00_SYNTHESE.md) | ✅ |
| 2026-05-05 | **🧭 Synthèse audits P0 + plan d'attaque** | [AUDIT-P0-SUMMARY.md](AUDIT-P0-SUMMARY.md) | ✅ |
| 2026-05-05 | **🤖 Master prompt agent (à donner tel quel)** | [MASTER-PROMPT.md](MASTER-PROMPT.md) | ✅ |
| 2026-05-05 | AutoGPT (Significant-Gravitas) | [01_autogpt.md](01_autogpt.md) | ✅ |
| 2026-05-05 | Agent Zero (agent0ai) | [02_agent_zero.md](02_agent_zero.md) | ✅ |
| 2026-05-05 | Observer AI (Roy3838) | [03_observer_ai.md](03_observer_ai.md) | ✅ |
| 2026-05-05 | OpenClaw (steipete / openclaw org) | [04_openclaw.md](04_openclaw.md) | ✅ |
| 2026-05-05 | AgenticSeek (Fosowl) | [05_agentic_seek.md](05_agentic_seek.md) | ✅ |
| 2026-05-05 | Local Operator (damianvtran) | [06_local_operator.md](06_local_operator.md) | ✅ |
| 2026-05-05 | Audit P0 #1 sandbox | [audit_P0_01_sandbox.md](audit_P0_01_sandbox.md) | ✅ |
| 2026-05-05 | Audit P0 #2 HITL générique | [audit_P0_02_hitl.md](audit_P0_02_hitl.md) | ✅ |
| 2026-05-05 | Audit P0 #3 auditor 2-pass | [audit_P0_03_auditor.md](audit_P0_03_auditor.md) | ✅ |
| 2026-05-05 | Audit P0 #4 delegate | [audit_P0_04_delegate.md](audit_P0_04_delegate.md) | ✅ |
| 2026-05-05 | Audit P0 #5 replan dynamique | [audit_P0_05_replan.md](audit_P0_05_replan.md) | ✅ |

## Structure des rapports

Chaque rapport `0X_*.md` contient :

1. **Fiche d'identité** — repo, licence, stars, activité, mainteneurs, public cible, maturité
2. **Architecture** — composants, flux, modules clés (avec chemins fichiers)
3. **Features remarquables** — 8-15 features avec chemin source + intérêt
4. **Comparatif avec BoxIA** — tableau dimension par dimension
5. **🟢 À voler tel quel** — feature → fichier source eux → cible BoxIA → effort S/M/L
6. **🟡 À adapter** — idem avec adaptation requise
7. **🔵 À surveiller** — idem sans action immédiate
8. **🔴 Pièges identifiés** — anti-patterns à éviter
9. **🎯 Top-3 préconisations BoxIA** — actions à plus fort ROI

## Comment ajouter un nouveau projet

1. Cloner shallow dans `D:\IA_TPE_PME_POWER\.research-cache\<slug>\`
   ```bash
   git clone --depth 1 https://github.com/<org>/<repo>.git \
     D:/IA_TPE_PME_POWER/.research-cache/<slug>
   ```
2. Dispatcher un sub-agent `general-purpose` avec le prompt template (voir
   [`00_SYNTHESE.md`](00_SYNTHESE.md) pour les exemples utilisés)
3. Le rapport est écrit en `tools/research/0N_<slug>.md`
4. Mettre à jour ce README + ajouter une ligne dans la matrice de patterns
   du `00_SYNTHESE.md`

## Cache local

`D:\IA_TPE_PME_POWER\.research-cache\` est gitignored.
Pour libérer l'espace après analyse :
```bash
rm -rf D:/IA_TPE_PME_POWER/.research-cache/<slug>
```

Les rapports `tools/research/0X_*.md` sont autonomes — ils citent les chemins
source mais ne dépendent pas du clone pour être lus.
