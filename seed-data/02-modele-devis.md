# Modèle de devis ACME SARL — Charte commerciale 2026

**Document interne — réservé équipe commerciale · Mise à jour janv. 2026**

## Mentions obligatoires (Code de la consommation, art. L.111-1)

Tout devis émis par ACME SARL DOIT contenir :

1. **Nom, adresse et SIRET de l'émetteur**
   - ACME SARL · 12 rue de la Paix · 75001 PARIS
   - SIRET : 123 456 789 00012 · APE 6202A
   - TVA intracommunautaire : FR12345678900
2. **Coordonnées complètes du client** (raison sociale, adresse,
   SIRET pour les pros, contact référent)
3. **Date d'émission ET date de validité** (par défaut : 30 jours)
4. **Numéro de devis unique** (format : `DEV-YYYYMM-NNNN`,
   ex : `DEV-202601-0042`)
5. **Détail des prestations** (désignation, quantité, PU HT, total HT)
6. **Total HT, TVA (20% taux normal), Total TTC**
7. **Conditions de paiement** (acompte, délai, mode)
8. **Lieu et date d'exécution prévus**
9. **Mention « Devis reçu avant exécution des travaux »** (clause
   protection consommateur)
10. **Signature du client précédée de "bon pour accord"**

## Structure type d'un devis

```
┌─ EN-TÊTE ─────────────────────────────────────────────────┐
│  [Logo ACME]                          DEVIS N° DEV-YYYYMM-NNNN │
│                                       Émis le : DD/MM/YYYY    │
│                                       Valable jusqu'au : DD/MM/YYYY │
│                                                                │
│  ACME SARL                            Client :                 │
│  12 rue de la Paix                    [Raison sociale]         │
│  75001 PARIS                          [Adresse]                │
│  SIRET 12345678900012                 [SIRET pour pros]        │
└────────────────────────────────────────────────────────────────┘

┌─ DÉSIGNATION ──────────────────┬──── Qté ──┬── PU HT ──┬─ Total HT ─┐
│  [Description prestation 1]    │     1     │   500 €   │    500 €   │
│  [Description prestation 2]    │     5     │   100 €   │    500 €   │
│  ...                           │           │           │            │
└────────────────────────────────┴───────────┴───────────┴────────────┘

                                          Total HT :     1 000,00 €
                                          TVA (20%) :      200,00 €
                                          Total TTC :    1 200,00 €

CONDITIONS DE PAIEMENT
  - Acompte de 30% à la signature : 360,00 € TTC
  - Solde à réception de facture : 840,00 € TTC
  - Modes : virement IBAN FR76... ou chèque
  - Pénalité retard : 3× taux légal (CGV art. 5)

DÉLAI D'EXÉCUTION : à partir du DD/MM/YYYY · livraison sous N jours

VALIDITÉ : ce devis est valable 30 jours à compter de la date d'émission.
Au-delà, les prix peuvent être révisés.

DEVIS REÇU AVANT EXÉCUTION DES TRAVAUX

Date :                          Signature du client précédée de
                                la mention « Bon pour accord » :
```

## Règles internes ACME

### Remises commerciales autorisées

| Conditions | Remise max |
|---|---|
| Premier achat client | 5 % |
| Volume > 10 k€ HT | 10 % |
| Renouvellement annuel | 8 % |
| Public / Associatif | 15 % |
| Autres | exception, validation direction |

### Validations requises

- Devis < 5 000 € HT : commercial autonome
- 5 000 € à 20 000 € HT : visa N+1 (chef d'agence)
- 20 000 € à 100 000 € HT : direction commerciale
- > 100 000 € HT : direction générale + comité

### Délais de réponse aux demandes de devis

- Demande standard : sous **48 heures ouvrées**
- Demande urgente identifiée : sous **24 heures**
- Demande complexe (chiffrage > 1 j) : accusé de réception sous 24h
  + délai annoncé

## Outils

- **Génération** : module Devis sur Pennylane (intégré au CRM)
- **Stockage** : SharePoint `Commercial/Devis/YYYY/`
- **Suivi** : tableau de bord Acceptance Rate dans Pennylane

## Indicateurs de performance

- **Taux de transformation** : 35 % (objectif 2026 : 42 %)
- **Délai moyen d'envoi** : 18 heures (objectif : < 12 heures)
- **Délai moyen de signature client** : 12 jours

## Contacts

- **Référent commercial** : Pierre Durand · `pierre.durand@acme-sarl.fr`
- **Support administratif** : `compta@acme-sarl.fr`
- **CGV** : disponibles sur <https://acme-sarl.fr/cgv>
