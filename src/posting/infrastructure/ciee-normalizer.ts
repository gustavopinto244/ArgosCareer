import { createPosting, Location, Posting } from "../domain/posting";
import { RawPosting } from "../domain/raw-posting";
import { CieeVaga, CieeVagaSchema } from "./ciee-schema";

/** CIEE publishes the neighbourhood and city, never a street address. */
function mapLocation(vaga: CieeVaga): Location {
  const city = vaga.local?.cidade?.trim();
  return city ? { kind: "known", city } : { kind: "unknown" };
}

/**
 * CIEE has no job title. `descricao` is the **company's line of business**
 * ("Ensino fundamental", "Serviço de táxi aéreo") and `areaProfissional` is
 * the role category ("Informática"), so the title is composed from the two
 * facts the source does state: that this is an internship (`tipoVaga` is
 * "ESTAGIO" on every observed posting) and which area it is in.
 *
 * The word "Estágio" is therefore in the title because the source says the
 * posting *is* one — not to satisfy the pre-filter's `titleRequired` rule.
 * The distinction matters: a normalizer that wrote words in to slip past a
 * filter would be lying to the rest of the pipeline about what it collected.
 */
function composeTitle(vaga: CieeVaga): string | null {
  const area = vaga.areaProfissional?.trim();
  const isInternship = (vaga.tipoVaga ?? "").toUpperCase() === "ESTAGIO";
  if (!area) return isInternship ? "Estágio" : null;
  return isInternship ? `Estágio em ${area}` : area;
}

/**
 * What stage A reads. `atividades` is the real content — a list of the work
 * the intern would do — and it is the only prose this source carries.
 * `descricao` (the employer's sector) is appended as context rather than
 * dropped: it is genuinely informative about the workplace, just not about
 * the role.
 */
function composeDescription(vaga: CieeVaga): string | null {
  const parts: string[] = [];
  const activities = (vaga.atividades ?? [])
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (activities.length > 0) {
    parts.push(`Atividades: ${activities.join("; ")}.`);
  }
  const sector = vaga.descricao?.trim();
  if (sector) parts.push(`Setor da empresa: ${sector}.`);

  const req = vaga.requisitos;
  if (req?.semestreInicio != null || req?.semestreFinal != null) {
    parts.push(
      `Semestre exigido: ${req?.semestreInicio ?? "?"} a ${req?.semestreFinal ?? "?"}.`,
    );
  }
  if (vaga.nivelEscolar) parts.push(`Nível escolar: ${vaga.nivelEscolar}.`);
  if (vaga.bolsaAuxilio != null) {
    parts.push(`Bolsa-auxílio: R$ ${vaga.bolsaAuxilio}.`);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * `RawPosting` → `Posting`, for CIEE. Same contract as `normalizeGupyJob`:
 * returns `null` rather than throwing when the payload cannot become a valid
 * `Posting`, because principle 1 applies to Normalize too.
 *
 * Two fields normalize to null on every CIEE posting, and both were verified
 * absent across 300 real records rather than assumed:
 *
 * - `publishedAt` — the source states no date. ADR-019 lets a null through
 *   the recency window deliberately, so CIEE postings are never filtered on
 *   age. The practical effect is that a full sweep re-sees the whole board
 *   each cycle; the fingerprint upsert (ADR-007) makes that cheap, and it
 *   shows up honestly as `alreadySeen` rather than as new volume.
 * - `sourceUrl` — no per-posting link is published on this endpoint. The
 *   digest treats a missing link as a stated absence rather than omitting
 *   the line (docs/02), so this degrades visibly instead of silently.
 */
export function normalizeCieeVaga(raw: RawPosting, now: Date): Posting | null {
  const parsed = CieeVagaSchema.safeParse(raw.payload);
  if (!parsed.success) return null;

  const vaga = parsed.data;
  const company = vaga.nomeEmpresa?.trim();
  if (!company) return null;

  const title = composeTitle(vaga);
  if (!title) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company,
      title,
      location: mapLocation(vaga),
      // CIEE publishes no remote/work-mode flag. `unknown` is the honest
      // answer, and ADR-011's leniency rule handles it without discarding.
      workMode: "unknown",
      applicationDeadline: null,
      publishedAt: null,
      sourceUrl: null,
      description: composeDescription(vaga),
      collectedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      rawPayload: vaga,
    });
  } catch {
    return null;
  }
}
