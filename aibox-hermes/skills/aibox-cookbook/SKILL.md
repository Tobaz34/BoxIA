---
name: aibox-cookbook
description: Recommande le meilleur modèle IA local (Ollama) selon le matériel de la machine (RAM, GPU/VRAM). À utiliser quand l'utilisateur demande quel modèle installer/utiliser, si sa machine est assez puissante, ou veut optimiser vitesse vs qualité.
version: 0.1.0
trigger_phrases:
  - quel modèle
  - quel modele
  - ma machine est-elle assez puissante
  - optimiser le modèle
  - changer de modèle
  - modèle plus rapide
  - modèle plus puissant
---

# Skill : aibox-cookbook

Recommande le modèle Ollama local adapté au matériel (idée reprise d'Odysseus,
adaptée à l'AI Box). Repose sur le CLI `cookbook/cookbook.py`.

## Quand l'utiliser
- « Quel modèle je peux faire tourner sur ce PC ? »
- « C'est lent, y a-t-il un modèle plus rapide ? » → `--prefer speed`
- « Je veux la meilleure qualité possible » → `--prefer quality` (défaut)
- Au moment de configurer/mettre à jour l'AI Box.

## Comment
Lance le CLI et lis la sortie JSON :
```bash
python ${AIBOX_HERMES_DIR}/cookbook/cookbook.py --json
# {"recommended":"qwen3:14b","reason":"...","alternatives":[...],"ram_gb":32,"vram_gb":12}
```
Pour forcer un profil : ajouter `--prefer speed`. Pour installer : `--pull`.

Réponds à l'utilisateur avec le modèle recommandé, la raison (RAM/VRAM détectées)
et les alternatives. Ne propose **jamais** un modèle qui ne tient pas sur sa
machine (le CLI le garantit déjà). Si `--pull` est demandé, préviens que le
téléchargement peut prendre plusieurs minutes.
