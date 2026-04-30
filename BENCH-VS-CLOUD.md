# Bench BoxIA vs ChatGPT vs Gemini

> **Méthode** : 2 prompts représentatifs TPE/PME, lancés en aveugle dans 3 onglets Chrome, comparaison côte à côte des réponses.
> **Date** : 2026-04-30
> **Utilisateur** : Andre (compte Free ChatGPT, compte Free Gemini)

## Setup

| Modèle | Plan | Variante observée | Mode |
|---|---|---|---|
| **BoxIA** | local sur RTX 4070 Super | qwen2.5:7b | Assistant comptable (agent dédié) |
| **ChatGPT** | Free | GPT-5 (probable, ou GPT-4o) | Web app |
| **Gemini** | Free | Gemini "Rapide" (Flash 2) | Web app |

Latence ~ comparable, toutes streamées et fluides (<25s pour ~1500 tokens).

---

## Prompt #1 — TVA simple (baseline)

> *« Calcule la TVA à 20% sur 1234.56€ HT et donne-moi le détail HT, TVA, TTC. »*

| | Réponse | Verdict |
|---|---|---|
| **BoxIA** | HT 1234,56 / TVA 246,91 / TTC 1481,47 | ✅ correct mais **LaTeX brut visible** (`\text{}` `\frac{}` `\times`) — bug rendu markdown |
| **ChatGPT** | HT 1 234,56 / TVA 246,91 / TTC 1 481,47 + sections « Calcul » / « Récapitulatif » | ✅ correct, **typographie FR propre** (espaces) |
| **Gemini** | Tableau Désignation/Montant + formules LaTeX **bien rendues** + bouton **« Exporter vers Sheets »** + **note** « 246,912 → arrondi à 246,91 selon règles comptables » | ✅✅ correct + **valeur ajoutée** (export, note pédagogique) |

**Rang baseline** : Gemini > ChatGPT > BoxIA (sur la forme — fond identique).

---

## Prompt #2 — Calcul comptable lourd (le vrai test)

> SARL 12 salariés, CA 487 320 €, achats 156 800 €, salaires 234 500 € (+42% charges patronales), services ext 28 400 €, dotations 18 700 €, charges fi 4 200 €, produits fi 1 850 €.
> Calcule : Résultat exploitation, financier, RCAI, IS PME (15% jusqu'à 42 500 puis 25%), Résultat net, CAF.

### Réponse correcte attendue

| Étape | Valeur | Détail |
|---|---|---|
| Charges patronales | 98 490 € | 234 500 × 0,42 |
| Charges personnel total | **332 990 €** | 234 500 + 98 490 |
| Résultat d'exploitation | **−49 570 €** | 487 320 − 156 800 − 28 400 − 332 990 − 18 700 |
| Résultat financier | −2 350 € | 1 850 − 4 200 |
| RCAI | **−51 920 €** | −49 570 + (−2 350) |
| IS PME | **0 €** | Résultat négatif → pas d'IS, déficit reportable |
| Résultat Net | **−51 920 €** | RCAI − IS |
| CAF | **−33 220 €** | Résultat Net + Dotations = −51 920 + 18 700 |

### Verdict par modèle

#### 🚨 BoxIA (qwen2.5:7b) — **3 erreurs critiques**

```
Charges salariales utilisées  : 136 910 €    ❌ (correct = 332 990 €)
Résultat exploitation         : +56 410 €    ❌ (correct = −49 570 €)
IS calculé                    : 8 109 €      ❌ (correct = 0 €, perte)
                                              + ignore la tranche 25% au-delà de 42 500
CAF interprétée comme         : « Contribution à la Formation Continue » 🚨
                                Article 320-1 CGI, formule = salaires × 7,5%
                                (correct = Capacité d'AutoFinancement)
```

**Diagnostic** : confusion sur les charges salariales (n'a pas additionné brut + cotisations), mauvaise application des tranches IS, **confusion sémantique grave** entre les deux significations de l'acronyme CAF. Pour un client TPE qui demande un conseil comptable, **réponse dangereuse — peut induire en erreur lors d'un contrôle URSSAF**.

#### ✅ ChatGPT (Free / GPT-5) — **parfait**

```
Charges patronales 98 490 €  → Charges personnel 332 990 €    ✓
Résultat exploitation = −49 570 €                              ✓
Commentaire : "L'activité est déficitaire, charges absorbent
              totalement la marge"                             ✓ analyse
RCAI = −51 920 €                                               ✓
IS = 0 + "perte reportable sur exercices futurs"               ✓
Résultat Net = −51 920 €                                       ✓
CAF = Capacité d'Autofinancement = Résultat Net + Dotations    ✓
```

#### ✅ Gemini (Free / Flash) — **excellent + analyse stratégique**

```
Tous les calculs identiques à ChatGPT, justes                  ✓
Bonus :
  - "masse salariale = ~68 % du CA" → ratio stratégique        ⭐ +
  - "déficit reportable, pourra être déduit des bénéfices
     futurs"                                                    ✓
  - CAF définition complète : « flux potentiel de trésorerie
     généré par l'activité, méthode additive »                  ⭐ +
  - "analyse des coûts de structure semble indispensable"       ⭐ + conseil action
```

**Rang Prompt #2** : Gemini ≥ ChatGPT >>> **BoxIA (faux)**.

---

## Synthèse — où le local PERD vs où il GAGNE

### 🚨 Cas où BoxIA perd nettement

| Type de prompt | Conséquence si on déploie en TPE |
|---|---|
| **Calcul comptable multi-étapes** | Risque réel d'erreur sur déclaration URSSAF, IS, bilan |
| **Sémantique d'acronymes français** (CAF, BFR, EBE…) | Confusion dommageable en contexte expert-comptable |
| **Application de tranches d'imposition** | Sur-/sous-estimation IS, taxe foncière, etc. |
| **Long raisonnement enchaîné** (10+ étapes dépendantes) | Erreurs s'accumulent, le modèle perd le fil |

→ qwen2.5:7b ne devrait **pas** être l'agent par défaut sur tâches comptables sensibles. Le mettre sur du **résumé / Q&R RAG / rédaction** où il est compétent.

### ✅ Cas où BoxIA gagne ou égale

| Cas | Pourquoi BoxIA gagne |
|---|---|
| Q&R sur **documents internes** (contrats, procédures) | Cloud doit envoyer les docs → fuite RGPD |
| Calcul **TVA simple** (1 ou 2 opérations) | Tous les LLMs égaux, pas de différence ressentie |
| **Hors-ligne** ou WAN cassé | Cloud KO, BoxIA OK |
| **Volume > 100 questions/jour × 10 users** | API cloud devient cher (3-15 €/user/mois) |
| **Conformité** (clients juridiques, médicaux, banques) | RGPD strict → données ne quittent pas l'entreprise |

---

## Recommandation produit

### Architecture hybride suggérée

> **« BoxIA pour 80% des cas usage, cloud externe pour les 20% complexes »**

1. **BoxIA local** (qwen2.5:7b) reste l'agent par défaut pour :
   - Q&R sur documents internes (RAG)
   - Rédaction emails / courriers / posts
   - Résumé de réunion, transcription
   - Recherche sémantique dans la KB
   - Calculs simples (TVA, conversion devises…)

2. **Bouton « Demander à un assistant plus puissant »** dans le chat qui :
   - Détecte un prompt « complexe » (longueur, mots-clés *calcule*, *raisonne*, *analyse*…)
   - **Suggère** d'envoyer la même question à ChatGPT/Gemini (clic le copie dans le presse-papier + ouvre l'onglet)
   - **Pas d'envoi automatique** — le client choisit consciemment quand sortir ses données

3. **Modèle plus gros sur la box** pour les clients exigeants
   - qwen2.5:**14b** (occupe ~9 Go VRAM, ok sur RTX 4070 Super 12 Go)
   - Ou Mistral Large 24b (Q4) sur RTX 5090
   - Bench à refaire pour valider que ces modèles plus gros corrigent les erreurs vues

### Dans le chat — afficher une *health warning* sur les calculs

Quand l'agent comptable génère une réponse contenant des chiffres :

> ⚠ *« Ces calculs sont indicatifs. Pour des déclarations officielles, faites valider par votre expert-comptable. »*

Réflexe disclaimer + responsabilité morale du produit.

---

## Bug à fixer dans BoxIA suite à ce bench

| Bug | Fix |
|---|---|
| Markdown LaTeX brut visible (`\text{}` `\times` `\frac{20}{100}`) | Activer `remark-math` + `rehype-katex` dans le composant `MessageMarkdown` |
| qwen2.5:7b confond CAF acronyme | Inutile de fix dans le code — c'est une limite intrinsèque du modèle 7B. Ajouter dans le pre-prompt de l'agent comptable : *« CAF = Capacité d'Autofinancement, jamais Contribution à la Formation Continue »* |
| Charges salariales mal additionnées | Idem, limitations du 7B. Pre-prompt : *« Pour les charges de personnel, rappel : charges totales = salaires bruts + (salaires bruts × taux de cotisations patronales) »* |

---

## Ce qu'on dirait à un prospect TPE

> *« Notre box répond bien à 80 % de ce que vous demandez au quotidien, en gardant vos données privées et sans coût récurrent. Pour les 20 % de raisonnements complexes (analyses comptables fines, calculs multi-tranches), vous gardez votre habitude d'aller sur ChatGPT/Gemini — la box vous y aide d'un clic. C'est complémentaire, pas en remplacement. »*

Honnêteté > over-promise. Un prospect averti détectera les faux pas du 7B s'il teste lui-même un calcul comptable complexe — autant le devancer.
