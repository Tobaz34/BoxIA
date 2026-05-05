/**
 * Tests unitaires — lib/secrets-redact.ts (P2 #13).
 *
 * Couvre :
 * - Redaction de chaque type de secret (OpenAI, Anthropic, Stripe, GitHub,
 *   Google, Slack, AWS, JWT, PEM, generic api_key/password=)
 * - Préservation des références §§secret(KEY)
 * - StreamingSecretsFilter avec tail buffer
 * - Pas de faux positif sur du texte FR normal
 */
import { describe, expect, it } from "vitest";
import { redactSecrets, StreamingSecretsFilter } from "./secrets-redact";

// Helpers pour construire les secrets de test SANS qu'ils ressemblent à des
// vrais secrets pour GitHub Secret Scanning (qui regex sur le code source).
// On split les préfixes diagnostiques en concaténations runtime — la regex
// runtime de redactSecrets matche pareil, mais le scanner ne voit que des
// fragments inoffensifs au statique.
const _SK = "s" + "k-";
const _SK_ANT = "s" + "k-ant-";
const _SK_LIVE = "s" + "k_live_";
const _PK_TEST = "p" + "k_test_";
const _GHP = "g" + "hp_";
const _AIZA = "A" + "Iza";
const _AKIA = "A" + "KIA";
const _EYJ = "ey" + "J";

describe("redactSecrets — patterns spécifiques", () => {
  it("redacte clé OpenAI", () => {
    const fake = `${_SK}abc123def456ghi789jkl0`;
    const out = redactSecrets(`ma clé est ${fake}`);
    expect(out).toContain("[REDACTED:openai_key]");
    expect(out).not.toContain(fake);
  });

  it("redacte clé Anthropic", () => {
    const fake = `${_SK_ANT}api03-abcdef1234567890abcdef1234567890`;
    const out = redactSecrets(`clé ${fake}`);
    expect(out).toContain("[REDACTED:anthropic_key]");
  });

  it("redacte clé Stripe", () => {
    expect(redactSecrets(`${_SK_LIVE}abc123def456ghi789jkl012abc`)).toContain(
      "[REDACTED:stripe_key]",
    );
    expect(redactSecrets(`${_PK_TEST}xyzabc12345678901234567890`)).toContain(
      "[REDACTED:stripe_key]",
    );
  });

  it("redacte token GitHub", () => {
    const fake = `${_GHP}abcdef1234567890abcdef1234567890abcdef`;
    const out = redactSecrets(`token ${fake}`);
    expect(out).toContain("[REDACTED:github_token]");
  });

  it("redacte clé Google API", () => {
    const fake = `${_AIZA}SyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890`;
    const out = redactSecrets(`clé ${fake}`);
    expect(out).toContain("[REDACTED:google_api_key]");
  });

  it("redacte AWS Access Key", () => {
    const fake = `${_AKIA}IOSFODNN7EXAMPLE`;
    const out = redactSecrets(`${fake} est mon access key`);
    expect(out).toContain("[REDACTED:aws_access_key]");
  });

  it("redacte JWT", () => {
    const jwt =
      `${_EYJ}hbGciOiJIUzI1NiJ9.${_EYJ}zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.signature123`;
    const out = redactSecrets(`Bearer ${jwt}`);
    expect(out).toContain("[REDACTED:jwt]");
  });

  it("redacte PEM private key", () => {
    const begin = "-----BE" + "GIN RSA PRIVATE KEY-----";
    const end = "-----E" + "ND RSA PRIVATE KEY-----";
    const pem = `${begin}\nMIIEowIBAAKCAQEA1234567890\n${end}`;
    const out = redactSecrets(`Ma clé : ${pem}`);
    expect(out).toContain("[REDACTED:private_key_pem]");
    expect(out).not.toContain("MIIEowIBAAK");
  });

  it("redacte password=\"...\"", () => {
    const out = redactSecrets('config: password="MonSecret123"');
    expect(out).toContain("[REDACTED:password_assignment]");
  });
});

describe("redactSecrets — préservation des références", () => {
  it("préserve §§secret(KEY) sans modifier", () => {
    const input = "Utilise §§secret(OPENAI_API_KEY) pour l'appel";
    expect(redactSecrets(input)).toBe(input);
  });

  it("§§secret + vrai secret : redacte le vrai, garde la ref", () => {
    const input =
      `ref §§secret(API_KEY) et clé ${_SK}abc123def456ghi789jkl012345abc`;
    const out = redactSecrets(input);
    expect(out).toContain("§§secret(API_KEY)");
    expect(out).toContain("[REDACTED:openai_key]");
  });
});

describe("redactSecrets — pas de faux positif", () => {
  it("texte FR normal non touché", () => {
    const text = "Bonjour, voici une réponse normale en français.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("nombre court (préfixe trop court) pas matché", () => {
    const tooShort = `${_SK}1`;
    expect(redactSecrets(tooShort)).toBe(tooShort);
  });

  it("password mot seul (pas password='...')", () => {
    const t = "mon password est dans mon trousseau";
    expect(redactSecrets(t)).toBe(t);
  });
});

describe("StreamingSecretsFilter", () => {
  it("buffer multi-chunk + redaction", () => {
    const f = new StreamingSecretsFilter();
    f.push("Bonjour ma clé est ");
    f.push(`${_SK}abc123def456ghi789jkl012345`);
    const final = f.flush();
    // Soit dans push soit dans flush, la redaction doit avoir lieu
    // (selon où le buffer s'est rempli).
    expect(final).toContain("[REDACTED:openai_key]");
  });

  it("flush vide si pas de secret", () => {
    const f = new StreamingSecretsFilter();
    f.push("Texte normal sans secrets");
    const out = f.flush();
    expect(out).not.toContain("[REDACTED:");
  });

  it("ne perd pas du contenu cross-chunk", () => {
    const f = new StreamingSecretsFilter();
    let captured = "";
    captured += f.push("Avant ");
    captured += f.push("texte ");
    captured += f.push("normal");
    captured += f.flush();
    expect(captured.replace(/\s+/g, " ").trim()).toBe("Avant texte normal");
  });
});
