# Audit des branches Git — nettoyage « base saine »

> Généré le 2026-06-14 après `git fetch --all --prune`. **À valider par André avant exécution** — je ne supprime rien sur le remote partagé `Tobaz34/BoxIA` sans ton OK.

## Constat

- **`origin/main` (9c2f6a6) inclut déjà `claude/hardening-review-030`** (le hardening 0.3.0 validé live est sur main). ✅ Plus besoin de merger quoi que ce soit pour avoir main = vérité.
- Le travail du pivot Hermes est sur **`claude/hermes-pivot`** (branche locale, à pousser).

## Branches FUSIONNÉES dans `origin/main` → suppression sûre

Leur contenu est intégralement dans main. Rien n'est perdu.

| Branche | Note |
|---|---|
| `claude/hardening-review-030` | source du pivot ; garde-la jusqu'à ce que `hermes-pivot` soit mergé, puis supprime |
| `claude/bold-bhabha-eabe99` | mergée |
| `claude/competent-burnell-e01b12` | mergée |
| `claude/festive-boyd-5f7cbf` | mergée |
| `claude/reverent-davinci-6cef54` | mergée |
| `claude/sharp-rhodes-2832ae` | mergée |

## Branches NON fusionnées → NE PAS supprimer sans examen

Elles contiennent du travail unique absent de main :

| Branche | Commits uniques | Quoi (mémoire) |
|---|---|---|
| `claude/eager-buck-3b6e79` | **+41** | à examiner — gros volume, vérifier si abandonné ou à récupérer |
| `claude/v2-oss-inspired` | **+7** | roadmap OSS-inspired (audits AutoGPT/Agent Zero/OpenClaw…) — peut être utile au pivot |

## Script de nettoyage (à lancer toi-même après validation)

```bash
# 1. Sync local main avec le remote
git checkout main && git merge --ff-only origin/main

# 2. Supprimer les branches fusionnées (remote + local). Décommente quand tu valides.
for b in bold-bhabha-eabe99 competent-burnell-e01b12 festive-boyd-5f7cbf \
         reverent-davinci-6cef54 sharp-rhodes-2832ae ; do
  echo "git push origin --delete claude/$b"
  echo "git branch -D claude/$b"
done
# (hardening-review-030 : supprime APRÈS le merge de hermes-pivot)

# 3. eager-buck / v2-oss-inspired : examiner d'abord
git log --oneline origin/main..origin/claude/eager-buck-3b6e79
git log --oneline origin/main..origin/claude/v2-oss-inspired
```

## Branches locales orphelines (worktrees / sessions passées)

`git branch -a` montrait aussi des branches **locales sans remote** (busy-cray, ecstatic-hermann, gracious-taussig, happy-bhaskara, gifted-leavitt…). Sûres à supprimer en local une fois leurs worktrees retirés :
```bash
git worktree list          # voir lesquelles sont des worktrees actifs
git branch -D <branche>    # une fois le worktree retiré
```
