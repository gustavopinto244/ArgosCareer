/**
 * Dumps every scoring assertion the model produced, as Markdown.
 *
 *   npm run report:scoring > relatorio.md
 *
 * "Assertion" is meant literally: Stage B answers, per requirement, whether
 * the profile meets it — and ADR-005 forces a verbatim quote from the profile
 * as evidence, with `evidence: null` collapsing the answer to `not_met`. This
 * report puts each of those claims next to the requirement it answers, so a
 * score can be argued with rather than believed.
 *
 * Reads only. It recomputes Stage C from the cached Stage A/B results
 * (`computeScore`, the same pure function `ApiScorer` calls) rather than
 * storing a score anywhere — the score has never been persisted, by design,
 * so that changing a weight in `criteria.yaml` re-answers the whole corpus
 * without a migration.
 *
 * `--verdict apply|review|discard` narrows the output; `--limit n` caps it.
 */
import { parseArgs } from "node:util";
import {
  createDatabase,
  runMigrations,
} from "../src/persistence/infrastructure/db";
import { ExtractionsRepository } from "../src/persistence/infrastructure/extractions-repository";
import { MatchesRepository } from "../src/persistence/infrastructure/matches-repository";
import { PostingsRepository } from "../src/persistence/infrastructure/postings-repository";
import { classifyTrack } from "../src/prefilter/domain/classify-track";
import { loadCriteria } from "../src/prefilter/infrastructure/criteria-loader";
import { hashProfile } from "../src/profile/domain/profile-hash";
import { loadProfile } from "../src/profile/infrastructure/profile-loader";
import { normalizePostingContent } from "../src/scoring/domain/posting-content-hash";
import { hashRequirements } from "../src/scoring/domain/requirements-hash";
import { computeScore } from "../src/scoring/domain/score";
import { Match, Requirement, Verdict } from "../src/scoring/domain/types";
import { buildScoringConfig } from "../src/scoring/infrastructure/scoring-config";
import {
  STAGE_A_PROMPT_VERSION,
  STAGE_B_PROMPT_VERSION,
} from "../src/scoring/infrastructure/prompts";
import { DEFAULT_MAX_DESCRIPTION_CHARS } from "../src/scoring/infrastructure/stage-a-extractor";

const STATUS_MARK: Record<Match["status"], string> = {
  met: "atende",
  partial: "parcial",
  not_met: "não atende",
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { verdict: { type: "string" }, limit: { type: "string" } },
  });

  const db = createDatabase(process.env.DATABASE_PATH ?? "./data/argos.db");
  runMigrations(db);

  const criteria = loadCriteria(
    process.env.CRITERIA_PATH ?? "./config/criteria.yaml",
  );
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? "./config/profile.yaml",
  );
  const profileHash = hashProfile(profile);
  const scoringConfig = buildScoringConfig(criteria);
  // Same env var build-scorer.ts reads for the real scorer (docs/audit
  // PR-017) -- this report reads exactly what the run under that model
  // actually cached, not a bulk scan that can't tell one model's answers
  // from another's.
  const model = process.env.LLM_MODEL ?? "unknown";

  const postings = new PostingsRepository(db).findActive();
  const extractionsRepo = new ExtractionsRepository(db);
  const matchesRepo = new MatchesRepository(db);

  const extractions = new Map<
    string,
    { seniority: string | null; experienceYears: number | null }
  >();

  const scored = postings.flatMap((posting) => {
    const { contentHash } = normalizePostingContent(
      posting.title,
      posting.description,
      DEFAULT_MAX_DESCRIPTION_CHARS,
    );
    const extraction = extractionsRepo.find(
      posting.fingerprint,
      STAGE_A_PROMPT_VERSION,
      model,
      contentHash,
    );
    if (extraction) {
      extractions.set(posting.fingerprint, {
        seniority: extraction.seniority,
        experienceYears: extraction.experienceYears,
      });
    }
    const requirements: readonly Requirement[] = extraction?.requirements ?? [];

    const matches = matchesRepo.find(
      posting.fingerprint,
      profileHash,
      STAGE_B_PROMPT_VERSION,
      model,
      hashRequirements(requirements),
    );
    if (!matches) return [];

    const tracks = classifyTrack(
      posting.title,
      criteria.tracks,
      criteria.trackExclusions,
    );
    const outcome = computeScore(matches, tracks, scoringConfig);
    return [{ posting, matches, tracks, outcome }];
  });
  scored.sort((a, b) => b.outcome.score - a.outcome.score);

  const wanted = values.verdict as Verdict | undefined;
  const filtered = wanted
    ? scored.filter((s) => s.outcome.verdict === wanted)
    : scored;
  const limit = values.limit ? Number(values.limit) : filtered.length;
  const shown = filtered.slice(0, Math.max(0, limit));

  // ---- header -------------------------------------------------------------
  const counts: Record<Verdict, number> = { apply: 0, review: 0, discard: 0 };
  for (const s of scored) counts[s.outcome.verdict] += 1;
  const lowConfidence = scored.filter((s) => s.outcome.lowConfidence).length;
  const blocked = scored.filter((s) => s.outcome.blockingFailure).length;

  console.log(`# Asserções de pontuação\n`);
  console.log(
    `Gerado em ${new Date().toISOString()} · perfil \`${profileHash.slice(0, 12)}\` · ` +
      `prompts \`${STAGE_A_PROMPT_VERSION}\` / \`${STAGE_B_PROMPT_VERSION}\`\n`,
  );
  console.log(
    `Cada linha é uma afirmação do modelo sobre um requisito, com a citação ` +
      `literal do perfil que a sustenta. Sem citação, ADR-005 obriga \`não atende\`.\n`,
  );
  console.log(`## Resumo\n`);
  console.log(`| Métrica | Valor |`);
  console.log(`| --- | --- |`);
  console.log(`| Vagas pontuadas | ${scored.length} |`);
  console.log(
    `| \`candidatar\` (≥${scoringConfig.thresholds.apply}) | ${counts.apply} |`,
  );
  console.log(
    `| \`avaliar\` (${scoringConfig.thresholds.review}–${scoringConfig.thresholds.apply - 1}) | ${counts.review} |`,
  );
  console.log(
    `| \`descartar\` (<${scoringConfig.thresholds.review}) | ${counts.discard} |`,
  );
  console.log(`| Com requisito eliminatório falhando | ${blocked} |`);
  console.log(`| Baixa confiança | ${lowConfidence} |`);
  if (shown.length !== scored.length) {
    console.log(`\n_Exibindo ${shown.length} de ${scored.length}._`);
  }

  // ---- per posting --------------------------------------------------------
  for (const { posting, matches, tracks, outcome } of shown) {
    const city =
      posting.location.kind === "known"
        ? posting.location.city
        : "local não informado";
    console.log(`\n---\n`);
    console.log(`## ${escapeCell(posting.title)}\n`);
    console.log(
      `**${escapeCell(posting.company)}** · ${city} · ${posting.workMode} · ` +
        `trilha: ${tracks.length ? tracks.join(", ") : "unknown"}\n`,
    );
    console.log(
      `**${Math.round(outcome.score)}** · \`${outcome.verdict}\`` +
        (outcome.lowConfidence ? " · baixa confiança" : "") +
        (outcome.blockingFailure ? " · **eliminatório falhou**" : "") +
        "\n",
    );
    console.log(
      `Cobertura obrigatória ${(outcome.breakdown.mandatoryCoverage * 100).toFixed(0)}% · ` +
        `desejável ${(outcome.breakdown.desirableCoverage * 100).toFixed(0)}% · ` +
        `alinhamento de trilha ${outcome.breakdown.trackAlignment.toFixed(2)}\n`,
    );

    if (outcome.blockingFailure) {
      console.log(
        `> **Eliminatório:** ${escapeCell(outcome.blockingFailure.text)}\n`,
      );
    }

    if (matches.length === 0) {
      console.log(`_Nenhum requisito extraído._`);
      continue;
    }

    console.log(`| Requisito | Peso | Resposta | Evidência no perfil |`);
    console.log(`| --- | --- | --- | --- |`);
    for (const m of matches) {
      const verifiable = m.requirement.verifiable === false ? " ⃰" : "";
      console.log(
        `| ${escapeCell(m.requirement.text)}${verifiable} ` +
          `| ${m.requirement.weight} ` +
          `| ${STATUS_MARK[m.status]} ` +
          `| ${m.evidence ? escapeCell(m.evidence) : "—"} |`,
      );
    }
    if (matches.some((m) => m.requirement.verifiable === false)) {
      console.log(
        `\n⃰ Requisito não verificável (ADR-015): traço pessoal que nenhum ` +
          `portfólio evidencia. Excluído da pontuação em vez de contado como falha.\n`,
      );
    }

    const ext = extractions.get(posting.fingerprint);
    if (ext?.seniority || ext?.experienceYears !== null) {
      console.log(
        `_Extraído: senioridade ${ext?.seniority ?? "não informada"} · ` +
          `experiência ${ext?.experienceYears ?? "não informada"} ano(s)._`,
      );
    }
  }
}

main();
