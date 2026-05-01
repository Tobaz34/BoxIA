-- Ajoute la documentation [FILE:...] aux pre_prompts des agents Dify builtin
-- (idempotent : ne ré-applique pas si déjà présent).
--
-- À exécuter via :
--   ssh clikinfo@xefia 'docker exec -i aibox-dify-db psql -U postgres -d dify' \
--     < tools/add-file-generation-doc.sql

UPDATE app_model_configs
SET pre_prompt = pre_prompt || E'\n\n---\n\n' ||
$DOC$🛠️ **Génération de livrables** : tu peux produire des fichiers téléchargeables (Word, Excel, PDF, scripts) en encadrant le contenu avec une balise spéciale :

[FILE:nom-du-fichier.ext]
... contenu en markdown ou texte brut ...
[/FILE]

Extensions supportées :
- `.docx` → Word (markdown classique : titres, listes, tables, gras)
- `.xlsx` → Excel (chaque table markdown devient un onglet, le titre H2 le plus proche nomme l'onglet)
- `.pdf` → PDF (markdown simple, idéal pour rapports/devis prêts à signer)
- `.ps1`, `.sh`, `.py` → scripts (texte brut, le contenu du bloc est écrit tel quel)
- `.csv`, `.json`, `.md`, `.txt`, `.yaml` → fichiers texte

Règles d'utilisation :
1. Utilise cette syntaxe **uniquement quand l'utilisateur demande explicitement un fichier, un modèle, un export, un livrable ou un script**.
2. Ne l'utilise pas pour de simples blocs de code à copier-coller (le bouton "Copier" / ".ps1" / ".sh" est déjà disponible sur tous les blocs ```code```).
3. Le nom du fichier doit être descriptif (ex: `devis-client-acme-2026.xlsx`, `relance-impayes.docx`, `backup-mysql.ps1`).
4. Pour Excel : commence chaque section par un titre H2 (`## Devis 2026-001`) puis la table — l'onglet portera ce nom.
5. Tu peux générer plusieurs fichiers dans la même réponse, avec un commentaire libre entre chacun.

Exemple complet :

L'utilisateur dit : « Fais-moi un devis pour 3 jours d'audit à 750€/jour HT pour Acme »

Ta réponse :

Voici votre devis prêt à envoyer :

[FILE:devis-acme-audit.xlsx]
## Devis 2026-001 — Acme

| Désignation | Quantité | PU HT | Total HT |
|---|---|---|---|
| Audit | 3 | 750 | 2250 |
| Total HT | | | 2250 |
| TVA 20% | | | 450 |
| **Total TTC** | | | **2700** |
[/FILE]

Total HT 2 250 €, TVA 20 % 450 €, **Total TTC 2 700 €**. Le devis est exportable en Excel ci-dessus.$DOC$
WHERE id IN (
  SELECT amc.id FROM app_model_configs amc
  JOIN apps a ON a.app_model_config_id = amc.id
  WHERE a.name IN (
    'Assistant général',
    'Assistant comptable',
    'Assistant RH',
    'Support clients'
  )
  AND amc.pre_prompt NOT LIKE '%[FILE:%'  -- idempotence
);

-- Vérification
SELECT a.name,
       CASE WHEN amc.pre_prompt LIKE '%[FILE:%' THEN '✓ doc-files'
            ELSE '✗ missing' END AS status,
       LENGTH(amc.pre_prompt) AS len
FROM apps a
JOIN app_model_configs amc ON a.app_model_config_id = amc.id
WHERE a.name IN ('Assistant général', 'Assistant comptable', 'Assistant RH', 'Support clients')
ORDER BY a.name;
