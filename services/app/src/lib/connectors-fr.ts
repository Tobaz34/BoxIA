/**
 * Catalogue des connecteurs métier FR — déclarés via le ConnectorBuilder
 * fluent SDK (cf lib/connector-builder.ts).
 *
 * Pourquoi : les connecteurs FR (Cegid, Sage, EBP, Quadratus, MyUnisoft,
 * Pennylane Pro) sont la **roadmap critique** identifiée dans
 * 00_SYNTHESE.md (différenciateur marché vs concurrents OSS US-centric).
 * Ce fichier centralise leurs déclarations + les exporte pour merge dans
 * le catalogue principal `lib/connectors.ts`.
 *
 * Coût marginal : 1 connecteur ≈ 10-30 lignes ici (vs 60-80 lignes dispersées
 * dans connectors.ts + oauth-providers.ts + form components).
 *
 * Tous en `implStatus: "coming_soon"` pour V1 (worker Python pas encore écrit).
 * Quand un worker sera implémenté → bump à "beta" puis "implemented".
 *
 * Référence : tools/research/00_SYNTHESE.md §P1 #14 (ProviderBuilder).
 */

import {
  defineConnector,
  defineFrenchAccountingConnector,
  defineSelfHostedBusinessConnector,
} from "@/lib/connector-builder";

/** Cegid Loop — comptabilité moderne SaaS française (TPE/PME). */
export const cegidConnector = defineFrenchAccountingConnector("cegid")
  .withName("Cegid Loop")
  .withIcon("📊")
  .withDescription(
    "Comptabilité Cegid Loop — factures, écritures, exports FEC " +
      "automatiques. Idéal pour les cabinets comptables et PME en croissance.",
  )
  .withDocUrl("https://help.cegid.com/loop/api")
  .build();

/** Sage 50/100 — leader historique français (à éviter "Sage" simple → marque). */
export const sage100Connector = defineFrenchAccountingConnector("sage-100")
  .withName("Sage 100 Comptabilité")
  .withIcon("🟢")
  .withDescription(
    "Sage 100 (compta installée local Windows) via Sage API ou export FEC. " +
      "Connecteur read-only V1 (lecture facture/écriture, export comptes, BILAN/CR).",
  )
  .withDocUrl("https://www.sage.com/fr-fr/products/sage-100/")
  .build();

/** EBP — autre éditeur français très répandu en TPE. */
export const ebpConnector = defineFrenchAccountingConnector("ebp")
  .withName("EBP Compta")
  .withIcon("📘")
  .withDescription(
    "EBP Comptabilité (Pro/Open Line) — lecture journaux, balance, " +
      "export FEC. Pour les TPE/artisans avec licence locale ou cloud.",
  )
  .withDocUrl("https://www.ebp.com/api-developers")
  .build();

/** Quadratus — éditeur Cegid Group, fort en cabinet comptable FR. */
export const quadratusConnector = defineFrenchAccountingConnector("quadratus")
  .withName("Quadratus Compta")
  .withIcon("🔷")
  .withDescription(
    "Quadratus (groupe Cegid) — pour les cabinets comptables qui suivent " +
      "leurs clients TPE. Lecture écritures + génération de FEC client.",
  )
  .withDocUrl("https://www.quadratus.fr/")
  .build();

/** MyUnisoft — challenger SaaS récent, axé expert-comptable. */
export const myUnisoftConnector = defineFrenchAccountingConnector("my-unisoft")
  .withName("MyUnisoft")
  .withIcon("🎯")
  .withDescription(
    "MyUnisoft — plateforme moderne pour experts-comptables. Synchronisation " +
      "factures, écritures, exports FEC, et déclarations TVA dématérialisées.",
  )
  .withDocUrl("https://www.myunisoft.fr/")
  .build();

/** Pennylane Pro — version étendue (déjà connecteur basique, ce serait l'API plus avancée). */
export const pennylaneProConnector = defineConnector("pennylane-pro")
  .withName("Pennylane Pro")
  .withIcon("🪙")
  .withCategory("finance")
  .withHub("finance")
  .withDescription(
    "Pennylane Pro — version cabinet comptable avec accès multi-clients, " +
      "automatisations avancées, et intégrations OCR factures fournisseur.",
  )
  .withImplStatus("coming_soon")
  .withApiKey({
    label: "Clé API Pennylane Pro",
    helpText:
      "Settings → API → Generate key (différente de la clé Pennylane individuelle)",
  })
  .withField({
    key: "firm_id",
    label: "Identifiant cabinet",
    type: "text",
    required: true,
    placeholder: "firm_xxx",
  })
  .withDocUrl("https://pennylane.readme.io/")
  .build();

/** Axonaut — CRM/ERP all-in-one français (TPE/start-up). */
export const axonautConnector = defineSelfHostedBusinessConnector("axonaut")
  .withName("Axonaut")
  .withIcon("🚀")
  .withDescription(
    "Axonaut — CRM/ERP français tout-en-un (devis, factures, projets, " +
      "stock). Très utilisé par les start-ups et TPE FR.",
  )
  .withImplStatus("coming_soon")
  .withDocUrl("https://axonaut.com/api")
  .build();

/** Catalogue agrégé pour merge dans CONNECTOR_CATALOG. */
export const FRENCH_CONNECTORS = [
  cegidConnector,
  sage100Connector,
  ebpConnector,
  quadratusConnector,
  myUnisoftConnector,
  pennylaneProConnector,
  axonautConnector,
] as const;
