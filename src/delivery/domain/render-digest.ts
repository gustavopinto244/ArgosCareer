import { WorkMode } from "../../posting/domain/posting";
import { Verdict } from "../../scoring/domain/types";
import { Digest, ScoredPosting } from "./digest";

/**
 * Translation boundary (ADR-003, docs/06-glossary.md): pt-BR text is only
 * ever produced here, never in a domain type, log message or error.
 */
const VERDICT_LABEL: Record<Verdict, string> = {
  apply: "candidatar",
  review: "avaliar",
  discard: "descartar",
};

const WORK_MODE_LABEL: Record<WorkMode, string> = {
  remote: "Remoto",
  hybrid: "Híbrido",
  onsite: "Presencial",
  unknown: "Local não informado",
};

function renderLocation(posting: ScoredPosting["posting"]): string {
  const city = posting.location.kind === "known" ? posting.location.city : null;
  const mode = WORK_MODE_LABEL[posting.workMode];
  return city ? `${city} · ${mode}` : mode;
}

/**
 * The per-posting entry (docs/02-architecture.md). Only the lines derivable
 * from stage C are rendered — Requisitos, Pontos fortes, Lacunas, Currículo
 * recomendado and Sugestão all depend on stage A/B matches and the variant
 * recommender, none of which exist until M7 (`StubScorer` never populates
 * them). Adding those lines here would be printing fields that are always
 * empty; they will be added when M7's `ScoreOutcome` actually carries the
 * data.
 *
 * The original posting link is mandatory (docs/02): when a source provided
 * none, the entry says so explicitly rather than omitting the line, since a
 * silently missing link is the one thing that breaks the under-10-minutes
 * goal.
 */
export function renderPostingEntry(entry: ScoredPosting): string {
  const { posting, outcome } = entry;
  const lines = [
    `Empresa: ${posting.company}`,
    `Cargo: ${posting.title}`,
    `Compatibilidade: ${Math.round(outcome.score)}% · ${VERDICT_LABEL[outcome.verdict]}`,
    `Local: ${renderLocation(posting)}`,
    `Fonte: ${posting.source}`,
    `→ ${posting.sourceUrl ?? "(link não informado pela fonte)"}`,
  ];
  // outcome.score reflects empty-category coverage (docs/04: "empty category
  // → coverage 1"), which reads as a strong match even when almost nothing
  // was actually extracted and verified — lowConfidence is docs/04's own
  // signal for exactly that gap, so it must be visible here or the percentage
  // above is misleading rather than merely incomplete.
  if (outcome.lowConfidence) {
    lines.push(
      "⚠ Confiança baixa — poucos requisitos verificáveis extraídos da vaga",
    );
  }
  return lines.join("\n");
}

function renderSection(
  title: string,
  entries: readonly ScoredPosting[],
): string {
  if (entries.length === 0) return `${title}\n\n(nenhuma vaga)`;
  return `${title}\n\n${entries.map(renderPostingEntry).join("\n\n")}`;
}

function renderPeriodBlockedSection(digest: Digest): string {
  const { periodBlocked } = digest;
  if (periodBlocked.length === 0)
    return "Abrem para você em breve\n\n(nenhuma vaga)";
  const lines = periodBlocked.map(
    ({ posting, opensAtLabel }) =>
      `${posting.company} — ${posting.title}\nAbre para você em ${opensAtLabel}`,
  );
  return `Abrem para você em breve\n\n${lines.join("\n\n")}`;
}

function renderSummary(digest: Digest): string {
  const { summary } = digest;
  const failedSources =
    summary.failedSources.length > 0
      ? summary.failedSources.join(", ")
      : "nenhuma";
  return [
    "Resumo da execução",
    "",
    `Coletadas: ${summary.collected}`,
    `Novas após deduplicação: ${summary.deduplicated}`,
    `Após pré-filtro: ${summary.filtered}`,
    `Pontuadas: ${summary.scored}`,
    `Fontes com falha: ${failedSources}`,
  ].join("\n");
}

/**
 * The full Telegram message body, plain text, sections in the order fixed by
 * docs/02-architecture.md: recommended, review, period-blocked, run summary.
 * Section 4 is what keeps principle 1 honest — a failed source is visible in
 * the digest instead of silently absent.
 */
export function renderDigestText(digest: Digest): string {
  const sections = [
    renderSection("Recomendadas", digest.recommended),
    renderSection("Vale avaliar", digest.review),
    renderPeriodBlockedSection(digest),
    renderSummary(digest),
  ];
  return sections.join("\n\n---\n\n");
}
