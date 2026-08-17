# ArgosCareer Post-Remediation Change Audit

## 1. Executive Summary

Esta auditoria revisou adversarialmente as alterações produzidas depois da auditoria original, usando como baseline `12b4a3b` e como estado final `12a5154` (`fix/llm-retry-taxonomy-backoff-circuit-breaker`). O delta contém 27 commits, 122 arquivos alterados, 14.121 inserções e 568 remoções.

O resultado não sustenta a interpretação de que os 34 findings originais foram resolvidos. Sete estão efetivamente fechados, dezenove receberam correção parcial, cinco continuam sem remediação, dois foram explicitamente aceitos como risco/gap e AC-008 sofreu uma regressão funcional na própria correção.

As melhorias mais sólidas são: dispatch correto de collectors, preservação de páginas anteriores, invalidação semântica dos caches Stage A/Stage B, persistência do prefilter, invariantes do score e accounting de tentativas de rede. Os maiores riscos remanescentes são:

- evidências acadêmicas/declaradas válidas são apresentadas ao modelo e depois rejeitadas pelo próprio validador Stage B;
- uma falha transitória de scoring é entregue uma vez e torna a vaga permanentemente inelegível para reprocessamento;
- recência de recovery continua global, não por fonte;
- o dedup executado antes do delivery não constitui uma barreira atômica contra ingest concorrente;
- prompt injection continua capaz de associar uma evidência real, porém irrelevante, a um requirement malicioso;
- o similarity dedup continua destruindo pares legítimos acima do threshold baixo;
- a nova política de erro permanente evita retry dentro de uma operação, mas repete 401/403 uma vez para cada posting do backlog e, combinada com o comportamento de delivery, pode marcar todo o backlog como notificado.

### Finding counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 7 |
| Medium | 14 |
| Low | 3 |
| Info | 0 |

### Resolution status of the original 34 findings

| Status | Count |
| --- | ---: |
| Verified closed | 7 |
| Partial | 19 |
| Regression | 1 |
| Open | 5 |
| Accepted open risk/gap | 2 |

No pre-existing working-tree changes existed at the start of this audit. While the audit was running, another process created and committed AC-016 on a separate branch. Those changes were not touched by this audit; after commit `12a5154` they were included in the final review and validation.

## 2. Scope and Methodology

The review did not trust commit titles, comments, ADRs, or tests as proof of correctness. For each remediation it compared:

1. the original finding and remediation acceptance criteria;
2. the actual runtime call path;
3. schema and migration behavior;
4. unit and integration tests;
5. failure, retry, concurrency, cache, and re-execution scenarios;
6. documentation claims against executable behavior.

No real collector or OpenRouter call was made. No migration was executed against a user database. Diagnostic tests used local temporary databases and fakes.

The final checks on `12a5154` were:

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm run build` | PASS |
| Root `npm test` | PASS — 80 files, 922 tests |
| `collectors/catho/npm test` | PASS — 1 file, 34 tests |

The root suite was executed with permission to open local Supertest sockets. An earlier sandboxed attempt failed only because listening on a local port was denied; the unrestricted local-only rerun passed all 52 API tests.

## 3. Change Inventory

The delta is organized around the original findings:

- Catho state machine and external collector hardening: AC-001, AC-002, AC-030, AC-034;
- collection wiring, partial results, recency, counters, truncation and location: AC-003, AC-004, AC-012, AC-013, AC-023, AC-024, AC-028, AC-029;
- dedup admission and heuristics: AC-005, AC-011, AC-014, AC-020;
- cache, scoring, evidence, failure visibility and cost: AC-006, AC-007, AC-008, AC-009, AC-015, AC-016, AC-018, AC-025, AC-026;
- persistence/traceability: AC-019, AC-027, AC-031;
- documentation cleanup: AC-033.

The delta does not materially remediate AC-010, AC-017, AC-021, AC-022, or AC-032.

## 4. Original Finding Resolution Matrix

| Finding | Change claimed | Runtime result | Tests | Status |
| --- | --- | --- | --- | --- |
| AC-001 | durable Catho acknowledgement | `ingested` only after 2xx; failed ingest payload remains queued | pure state tests | VERIFIED |
| AC-002 | retryable vs expired | 403/429/5xx/no response no longer expire immediately, but generic failures quarantine permanently after five attempts without replay path | unit matrix, no process/recovery E2E | PARTIAL |
| AC-003 | collector dispatch | REST/MCP now resolve by `source` | registry and service tests | VERIFIED |
| AC-004 | preserve prior pages | all internal collectors return successful prior pages and caller persists them despite `error` | per-collector tests | VERIFIED |
| AC-005 | dedup before paid scoring | delivery runs dedup first, but admission is not atomic with external ingest or other processes | one sequential external-ingest test | PARTIAL |
| AC-006 | Stage A semantic cache | title+description content hash is checked before hit | repository/stage tests | VERIFIED |
| AC-007 | Stage B/extraction/model cache identity | model and requirement hashes prevent sequential stale hits | repository/stage tests | VERIFIED |
| AC-008 | prompt injection/evidence provenance | fabricated text is rejected, but valid synthetic evidence is rejected and semantic relevance is not checked | isolated provenance tests only | REGRESSION |
| AC-009 | scoring failures/partial progress | failures appear in digest, but are marked notified and cannot be retried; per-requirement progress remains absent | delivery visibility tests | PARTIAL |
| AC-010 | source identity/repost lifecycle | unchanged fingerprint and one-row overwrite semantics | existing tests preserve behavior | OPEN |
| AC-011 | destructive similarity false positives | only the both-empty case was fixed; other known high-similarity false positives remain | one added regression pair | PARTIAL |
| AC-012 | schema/normalization visibility | aggregate received/schema/normalizer counters added, but unknown is stored as zero and source/business-drop reconciliation is absent | collector/CLI unit tests | PARTIAL |
| AC-013 | truncation visibility | internal sources expose a source-level flag; external sources and exact caps are not covered | internal collector tests | PARTIAL |
| AC-014 | cross-source dedup | legal suffix variants group together; known-vs-unknown location and other identity variants remain deliberately unmatched | suffix tests | PARTIAL |
| AC-015 | OpenRouter accounting | network attempts and unknown-usage floor persist; some provider usage and outcome detail remain unaccounted | client tests | PARTIAL |
| AC-016 | retry taxonomy/backoff/breaker | transport and repair budgets separated with backoff, but breaker/taxonomy/batch behaviors remain unsafe | extensive unit tests, missing adversarial composition | PARTIAL |
| AC-017 | LLM input/output bounds | no material bound or sanitization added | none | OPEN |
| AC-018 | academic cache invalidation | academic period is hashed, but prompt and hash may use different clocks | hash tests only | PARTIAL |
| AC-019 | prefilter persistence | prefilter outcome, reason and criteria hash are append-only per run | repository/CLI tests | VERIFIED |
| AC-020 | cross-process atomicity | documented and tested only for a single upsert transaction; multi-transaction delivery race accepted | repository concurrency test | ACCEPTED OPEN |
| AC-021 | credential scopes/rate limiting | unchanged shared bearer/capability boundary | existing auth tests | OPEN |
| AC-022 | resumable delivery | unchanged all-or-nothing notifier acknowledgement and posting marking | existing notifier tests | OPEN |
| AC-023 | query coverage | gaps are documented and frozen in a test, not closed | configuration allowlist test | ACCEPTED OPEN |
| AC-024 | nationwide unknown location | Catho unknown location is rejected; CIEE remains lenient despite also fetching a national board | Catho-only tests | PARTIAL |
| AC-025 | score configuration invariants | ranges, sum/order and final clamp are enforced | domain/config tests | VERIFIED |
| AC-026 | delivery context | recommendation/highlights/missing/critical gaps delivered; academic-period blocked section remains empty | digest tests | PARTIAL |
| AC-027 | posting/run traceability | prefilter/score/delivery events added; collect/normalize/dedup/cache/attempt identities absent | repository/CLI tests | PARTIAL |
| AC-028 | recovery recency | window follows last global successful collect, not each source/query | whole-run outage tests only | PARTIAL |
| AC-029 | future dates | future date falls back to firstSeenAt for prefilter, but invalid-date state is not recorded or counted | prefilter tests | PARTIAL |
| AC-030 | reproducibility | direct dependencies/lockfile pinned; images/transitive Python environment/build validation remain mutable | Catho state-only CI | PARTIAL |
| AC-031 | DB invariants/corrupt JSON | unparsable JSON degrades to miss, but valid malformed arrays and missing DB constraints remain | invalid-JSON tests | PARTIAL |
| AC-032 | measured hot paths | unchanged | none | OPEN |
| AC-033 | docs/config drift | several dead settings were labelled, but new security/retry claims overstate runtime guarantees | review only | PARTIAL |
| AC-034 | Catho host validation | candidate URL checked, but sitemap child fetch and redirect request happen before final validation | candidate tests | PARTIAL |

## 5. High Findings

## [PR-001] [HIGH] Stage B rejects valid academic and declared-field evidence that its own prompt exposes

**Confidence:** CONFIRMED

**Component:** Stage B evidence provenance / recommendation scoring

**Location:** `src/scoring/domain/evidence-provenance.ts:24`, `src/scoring/infrastructure/prompts.ts:97`, `src/scoring/infrastructure/prompts.ts:129`, `src/scoring/infrastructure/stage-b-matcher.ts:153`

**Affected flow:** Profile → Stage B prompt → valid model quote → provenance check → `createMatch` → deterministic score

**Expected behavior:** Every evidence line deliberately rendered as quotable profile evidence must be accepted verbatim by the provenance validator.

**Actual behavior:** The prompt renders `[Academic enrollment]`, `[English level]`, `[Availability]`, and `[Compensation]` lines, but `buildProfileEvidenceIndex` indexes only `profile.competencies[].evidence`. A model that correctly quotes any synthetic/derived line fails `isKnownProfileEvidence`; evidence becomes `null`, and `createMatch` coerces the status to `not_met`.

**Evidence:** `formatProfileEvidence` concatenates academic and declared fields before competencies. The validator iterates only competencies. The two behaviors are tested independently, never together.

**Real-world scenario:** A posting requires “cursando a partir do 3º período”, intermediate English, or 30-hour availability. The profile satisfies it, Stage B quotes the exact line shown, and the application converts the answer to `not_met`; a blocking requirement may cap the score.

**Impact:** Systematic false-negative classification of common internship requirements. This is a regression introduced by AC-008 and can suppress otherwise strong vacancies.

**Why existing tests did not catch it:** Provenance tests cover competency evidence only. Prompt tests verify that academic/declared lines exist, but no integration test returns one of those lines through `StageBMatcher`.

**Recommendation:** Define one canonical evidence catalog used both to render the prompt and validate returned evidence, then test every evidence class end-to-end.

## [PR-002] [HIGH] Scoring failures are permanently marked notified and the documented manual retry does not exist

**Confidence:** CONFIRMED

**Component:** Delivery lifecycle / Stage A and Stage B failure recovery

**Location:** `src/cli/main.ts:642`, `src/cli/main.ts:692`, `src/persistence/infrastructure/postings-repository.ts:240`, `docs/adr/006-llm-output-failure-policy.md:143`

**Affected flow:** scoring failure → synthetic review entry → Telegram success → `markNotified` → future runs

**Expected behavior:** A visible scoring failure must remain recoverable after the provider, prompt, model, or configuration is fixed.

**Actual behavior:** Failed postings enter `digest.review`, then every recommended/review entry is marked notified. `findUnnotified` permanently excludes it. There is no unnotify/rescore command or per-posting retry endpoint. ADR-006 says a human can re-run scoring manually, but the runtime provides no such path.

**Evidence:** `sent` includes both digest buckets and `markNotified` is unconditional after notifier success. Repository search found no code path clearing `notifiedAt`.

**Real-world scenario:** OpenRouter times out or returns invalid JSON for one posting. The user sees “não foi possível pontuar” once. The next day the provider is healthy, but the vacancy can never be automatically or manually rescored through supported interfaces.

**Impact:** Transient failure becomes permanent loss of automated evaluation. A run-wide credential/provider problem can remove the entire backlog from future scoring.

**Why existing tests did not catch it:** Tests assert visibility and write-once notification separately; none asserts recoverability after a failed scoring outcome.

**Recommendation:** Separate “failure was reported” from “vacancy was successfully evaluated/delivered” and provide an explicit, idempotent retry lifecycle with bounded policy.

## [PR-003] [HIGH] Recovery recency is global, so one healthy source hides another source's outage

**Confidence:** CONFIRMED

**Component:** Collection recovery window / runs persistence

**Location:** `src/cli/main.ts:176`, `src/cli/main.ts:241`, `src/cli/main.ts:308`, `src/persistence/infrastructure/runs-repository.ts:150`

**Affected flow:** source outage → mixed collection run → run marked success → next source query cutoff

**Expected behavior:** Each source/query must recover postings published since its own last successful collection.

**Actual behavior:** `executeCollect` reads the latest global successful `collect` run. A run is successful whenever not every query failed. If Gupy succeeds while Sólides fails, the global timestamp advances and the next Sólides run receives the ordinary one-day window.

**Evidence:** `findLatestFinished("collect", "success")` has no source dimension. `allFailed` is true only when failures equal total queries.

**Real-world scenario:** Sólides is unavailable for four days while Gupy remains healthy. Every cycle is globally successful. When Sólides recovers, jobs posted in the first three days of the outage are outside the one-day window and are never collected.

**Impact:** Silent, permanent per-source job loss despite apparently healthy collection runs.

**Why existing tests did not catch it:** The new tests model a gap with no successful collection at all, not mixed per-source success/failure.

**Recommendation:** Persist success/cursor/last-attempt per source or query and derive recovery windows from that state.

## [PR-004] [HIGH] Dedup-before-delivery is not an atomic admission barrier

**Confidence:** CONFIRMED

**Component:** External ingest / dedup / paid scoring concurrency

**Location:** `src/cli/main.ts:568`, `src/cli/main.ts:606`, `src/api/infrastructure/runs.service.ts:199`, `src/scheduling/domain/run-lock.ts:17`

**Affected flow:** external ingest or second process → dedup → candidate read → OpenRouter

**Expected behavior:** No posting should become eligible for paid scoring unless it has passed exact and similarity dedup atomically.

**Actual behavior:** Delivery runs `executeDedup` once and later calls `findUnnotified`. External ingest uses the independent `collect` lock and may insert between those operations. A separate CLI/server process bypasses the in-memory lock entirely.

**Evidence:** `collect` and `scoreAndDeliver` are distinct lock keys. `RunLock` documents that it is process-local. There is no persisted claim/admission state coupling insert, dedup, and scoring selection.

**Real-world scenario:** Catho/Indeed ingest inserts a near-duplicate after the delivery dedup pass but before candidate selection. The posting reaches Stage A/B and is only eligible for dedup on a later run, after cost has already been incurred.

**Impact:** Duplicate OpenRouter spending and duplicate recommendations remain possible in every concurrent entry path.

**Why existing tests did not catch it:** The AC-005 test performs ingest, then delivery sequentially. It does not interleave ingest at the barrier boundary or use two processes.

**Recommendation:** Create a persisted, atomic pre-score admission/claim state enforced by the database rather than relying on stage ordering alone.

## [PR-005] [HIGH] Evidence membership does not prevent semantic prompt injection

**Confidence:** CONFIRMED

**Component:** Stage A/Stage B trust boundary

**Location:** `src/scoring/infrastructure/prompts.ts:69`, `src/scoring/domain/evidence-provenance.ts:52`, `src/scoring/infrastructure/stage-b-matcher.ts:153`, `SECURITY.md:65`

**Affected flow:** untrusted description → extracted requirement → Stage B status/evidence → score

**Expected behavior:** Untrusted posting text must not be able to control which profile evidence satisfies which requirement.

**Actual behavior:** The validator proves only that the returned string occurs somewhere in the profile. It does not prove that the quote supports the current requirement. A malicious requirement can instruct the model to return `met` with any genuine profile line. Stage A also receives raw title/description as prompt content without a structural data channel or robust delimitation.

**Evidence:** `isKnownProfileEvidence` is a set-membership lookup. No category, competency, requirement-to-evidence relation, or entailment rule is validated after the model response.

**Real-world scenario:** A description says to ignore prior instructions, emit a mandatory “candidate is perfect” requirement, and quote the real Node.js evidence. The quote passes provenance even though it does not establish arbitrary unrelated requirements.

**Impact:** An attacker controlling a job description can still distort requirements, weights, blocking status, and matches, producing deterministic but corrupted scores.

**Why existing tests did not catch it:** The only adversarial test rejects invented evidence. There is no test using genuine-but-irrelevant evidence or injecting instructions through Stage A.

**Recommendation:** Treat provenance and semantic applicability as separate invariants; structurally delimit external content and verify evidence against the specific requirement/competency relationship.

## [PR-006] [HIGH] Similarity dedup still merges clearly different jobs above the 0.35 threshold

**Confidence:** CONFIRMED

**Component:** Layer-2 title similarity dedup

**Location:** `src/posting/domain/title-similarity.ts:71`, `src/persistence/application/dedup-similar-postings.ts:47`, `src/persistence/application/dedup-similar-postings.ts:144`

**Affected flow:** active postings → same-company grouping → title similarity → destructive duplicate flag

**Expected behavior:** A destructive merge must require strong evidence that two postings describe the same opening.

**Actual behavior:** AC-011 only changed the special case where both significant strings are empty. The threshold remains 0.35 and character-bigram overlap still merges distinct roles. Local diagnostic calculations produced: Direito Trabalhista vs Direito Tributário = 0.571; Jurídico Cível vs Jurídico Trabalhista = 0.438; Engenharia Civil vs Engenharia de Software = 0.545; Desenvolvimento vs Desenvolvimento Humano = 0.800.

**Evidence:** Every value exceeds the configured threshold. Same company, compatible location and 14-day window are sufficient to mark the later row duplicate.

**Real-world scenario:** One company opens legal internships in different specialties or engineering internships in civil and software disciplines in the same city. The later vacancy disappears from all downstream stages.

**Impact:** Confirmed ongoing risk of legitimate vacancy loss. The new regression test protects one edge case, not the destructive heuristic as a whole.

**Why existing tests did not catch it:** Tests are a small hand-picked set and contain no labelled negative corpus/property asserting that different specialty tokens must prevent a merge.

**Recommendation:** Calibrate against a labelled corpus, require stronger shared discriminators, and retain an auditable decision/reversal mechanism before treating similarity as a suppressing operation.

## [PR-007] [HIGH] Permanent OpenRouter errors fail once per posting, not once per run

**Confidence:** CONFIRMED

**Component:** AC-016 retry taxonomy / delivery batch control

**Location:** `src/scoring/infrastructure/openrouter-client.ts:383`, `src/scoring/infrastructure/llm-output.ts:150`, `src/scoring/infrastructure/circuit-breaker.ts:82`, `src/cli/main.ts:627`

**Affected flow:** invalid/revoked API key or invalid shared model configuration → all postings in delivery run

**Expected behavior:** A client-wide permanent failure should stop or quarantine the run after one conclusive failure.

**Actual behavior:** 401/403 and other 4xx return `permanent_error` without retry for one logical operation, but the outer delivery loop continues to the next posting. Permanent failures do not affect the shared circuit breaker. Each posting therefore sends another request with the same bad key/configuration; afterwards PR-002 can mark every failed posting notified.

**Evidence:** `onFailure(false)` is a no-op. `executeDeliver` loops through every filtered posting and converts every failure into a review entry rather than aborting on client-wide configuration errors. The new test explicitly confirms three 401 calls all reach `fetch` and the breaker remains closed.

**Real-world scenario:** The OpenRouter key is revoked before a 1.000-posting backlog is processed. The new policy reduces three requests per posting to one, but still makes 1.000 known-doomed requests and can permanently remove all 1.000 postings from the retry pool after Telegram delivery.

**Impact:** Batch-wide amplification, misleading success/delivery state, and permanent loss of future evaluation after a single configuration incident.

**Why existing tests did not catch it:** Tests stop at one client call or assert that permanent errors do not open the breaker. No delivery test simulates a permanent error across multiple postings.

**Recommendation:** Distinguish operation-local 4xx from run-wide auth/model configuration failures and propagate the latter to batch control without notifying postings as evaluated.

## 6. Medium Findings

## [PR-008] [MEDIUM] Half-open circuit breaker admits every concurrent caller, not exactly one trial

**Confidence:** CONFIRMED

**Component:** OpenRouter circuit breaker

**Location:** `src/scoring/infrastructure/circuit-breaker.ts:68`

**Affected flow:** provider cooldown → concurrent Stage B workers → recovery probe

**Expected behavior:** After cooldown, exactly one trial request should pass while all other callers remain blocked.

**Actual behavior:** The first caller changes state from `open` to `half_open`; every subsequent caller sees a state other than `open` and returns successfully from `beforeCall`.

**Evidence:** There is no half-open permit/in-flight guard. The test named “allows exactly one trial” invokes `beforeCall` only once and never asserts that a second call is rejected.

**Real-world scenario:** Several workers wake after the same 30-second `Retry-After`. All pass the half-open gate and send a recovery burst to the provider.

**Impact:** The breaker can recreate the retry storm it was introduced to prevent.

**Why existing tests did not catch it:** No concurrent or even sequential second-call assertion exists in half-open state.

**Recommendation:** Model a single half-open lease and test simultaneous callers, slow probes, success, failure and cancellation.

## [PR-009] [MEDIUM] Provider/content-local failures can trip the global breaker, while HTTP 408 is treated as permanent

**Confidence:** CONFIRMED

**Component:** OpenRouter failure taxonomy

**Location:** `src/scoring/infrastructure/openrouter-client.ts:142`, `src/scoring/infrastructure/openrouter-client.ts:173`, `src/scoring/infrastructure/openrouter-client.ts:431`

**Affected flow:** 2xx unexpected choice/content-filter response or HTTP request timeout → retry/breaker decision

**Expected behavior:** Only evidence of systemic provider unavailability should open a client-wide breaker; request timeout responses should be retryable.

**Actual behavior:** `invalidOutput` and `invalidEnvelope` are transient and count toward the shared breaker even when they can be posting/content-specific. All unclassified 4xx, including 408, are `configError` and fail permanently.

**Evidence:** `TRANSIENT_CATEGORIES` includes invalid response shapes; `complete` calls `onFailure(true)` for empty choices. `classifyHttpStatus` maps every remaining status from 400 through 499 to `configError`.

**Real-world scenario:** Five content-filtered/empty-choice answers trip the provider-wide breaker and suppress unrelated postings; conversely, a recoverable 408 receives no retry.

**Impact:** Avoidable batch suppression and missed transient recovery.

**Why existing tests did not catch it:** The status matrix omits 408 and tests taxonomy in isolation, not the blast radius of repeated content-local outcomes.

**Recommendation:** Classify failures by scope as well as retryability and add a documented status/outcome matrix exercised through the full scorer.

## [PR-010] [MEDIUM] Untrusted requirement text is inserted into operational log labels

**Confidence:** CONFIRMED

**Component:** AC-016 logging / untrusted input handling

**Location:** `src/scoring/infrastructure/stage-b-matcher.ts:140`, `src/scoring/infrastructure/llm-output.ts:129`, `docs/08-observability.md:84`

**Affected flow:** job description → Stage A requirement text → Stage B failure log

**Expected behavior:** Logs should contain stable identifiers and bounded reason codes, not attacker-controlled posting text.

**Actual behavior:** `operationLabel` includes the complete `requirement.text` and is interpolated into every warning/debug line. Requirements originate in untrusted descriptions and remain unbounded under open AC-017.

**Evidence:** The test output itself prints labels such as `stage-b:<fingerprint>:<requirement>`. No escaping, newline removal, maximum length, or structured field boundary is applied.

**Real-world scenario:** A description induces a requirement containing newlines, terminal control text, contact data, or thousands of characters. Any retry writes it into logs, enabling log forging/bloat and violating the repository's “no posting/profile text in logs” policy.

**Impact:** Log integrity, privacy, and availability risk localized to scoring failures.

**Why existing tests did not catch it:** Tests use short benign requirements and assert no logging security properties.

**Recommendation:** Log only bounded opaque identifiers/hashes and keep untrusted requirement content out of labels.

## [PR-011] [MEDIUM] Catho turns every repeated transient failure into an unrecoverable quarantine

**Confidence:** CONFIRMED

**Component:** Catho checkpoint state machine

**Location:** `collectors/catho/state.ts:93`, `collectors/catho/state.ts:221`, `collectors/catho/state.ts:232`

**Affected flow:** page 403/429/5xx/timeout/invalid JSON-LD → retryable → quarantine

**Expected behavior:** Quarantine should preserve reason, remain observable, and have a supported replay/reconciliation path.

**Actual behavior:** Every retryable reason increments the same counter; on the fifth failure the entry becomes `quarantined`, its reason is discarded, `needsPageFetch` returns false, and no command/API requeues it.

**Evidence:** Quarantined entries contain only `{state, failCount}`. No code consumes quarantined rows except to skip them.

**Real-world scenario:** Catho's known 403 lasts for five 30-minute runs. The blocker is later resolved, but every candidate already quarantined remains permanently uncollected unless the state file is manually edited/deleted.

**Impact:** Deferred permanent vacancy loss. Current deployment documentation keeps Catho disabled, lowering immediate severity but not correcting the lifecycle.

**Why existing tests did not catch it:** Tests assert that quarantine occurs and is skipped; they do not require replay or reason visibility.

**Recommendation:** Treat quarantine as an operable queue with reason/timestamps and explicit retry/reconciliation controls.

## [PR-012] [MEDIUM] Catho durability is batch-level and the state file has no cross-process coordination

**Confidence:** CONFIRMED

**Component:** Catho external process persistence

**Location:** `collectors/catho/collect.ts:252`, `collectors/catho/collect.ts:271`, `collectors/catho/state.ts:108`, `collectors/catho/state.ts:135`

**Affected flow:** long page batch or overlapping systemd/manual process → checkpoint file

**Expected behavior:** Completed page outcomes should survive a crash and concurrent processes should not overwrite each other's state.

**Actual behavior:** State is saved only after the entire page loop and browser shutdown. A crash late in a 300-page run loses all accumulated outcomes and payloads, causing re-fetch/re-cost. Atomic rename prevents torn files but not last-writer-wins between two processes that loaded different snapshots.

**Evidence:** `applyPageOutcome` mutates only the in-memory accumulator until the single post-loop `saveStateAtomic`. No file lock, generation check, merge, or systemd mutual-exclusion guard exists.

**Real-world scenario:** A process is killed after 299 successful page loads or a manual run overlaps the timer. The next state may omit one process's payloads/checkpoints and repeat the browser work/ingest.

**Impact:** Avoidable external requests, batch reprocessing and inconsistent operational state; database fingerprinting limits duplicate rows but not repeated collector work.

**Why existing tests did not catch it:** State functions are unit-tested; `collect.ts` crash boundaries and two-process execution are not.

**Recommendation:** Persist at bounded per-item/batch boundaries and coordinate writers with an explicit single-run/compare-and-swap strategy.

## [PR-013] [MEDIUM] Corrupted-cache handling validates JSON array shape but not domain content

**Confidence:** CONFIRMED

**Component:** Extraction and match repositories

**Location:** `src/persistence/infrastructure/extractions-repository.ts:25`, `src/persistence/infrastructure/matches-repository.ts:15`

**Affected flow:** restored/manually edited/stale cache row → Stage B/scoring/M10

**Expected behavior:** Any cache row violating `Requirement[]` or `Match[]` must become a cache miss/quarantine.

**Actual behavior:** Repositories accept any JSON array and type-cast it. Values such as `[{}]`, `[null]`, invalid enums, mismatched requirement/match counts, or malformed nested requirements are treated as valid hits.

**Evidence:** Both parsers perform only `JSON.parse` and `Array.isArray`. They do not call the existing Zod schemas.

**Real-world scenario:** A restore produces valid JSON with missing fields. Stage B builds prompts containing undefined fields or deterministic scoring dereferences malformed matches and fails the batch.

**Impact:** AC-031 prevents one corruption class but leaves structurally valid corruption able to poison scoring and analytics.

**Why existing tests did not catch it:** Added tests use unparsable JSON/non-array shapes, not invalid domain objects inside arrays.

**Recommendation:** Validate persisted cache payloads with versioned domain schemas and reconcile match count/identity to the current requirement set.

## [PR-014] [MEDIUM] Collection counters remain non-reconcilable and erase “unknown” as zero

**Confidence:** CONFIRMED

**Component:** Collection observability

**Location:** `src/cli/main.ts:196`, `src/cli/main.ts:235`, `src/persistence/infrastructure/schema.ts:198`, `src/posting/domain/ports/collector.port.ts:24`

**Affected flow:** source response → collector filters/schema → normalizer → run row

**Expected behavior:** Every raw item should reconcile into one source/query-specific terminal category, with unknown reporting distinct from a genuine zero.

**Actual behavior:** An absent `receivedCount` contributes zero and persists into a non-null default-zero column. Counts are aggregate across all sources/queries. Intentional CIEE education/city/area drops are not counted. Normalizer rejects are not reason-coded per source.

**Evidence:** `received += result.receivedCount ?? 0`; the schema cannot represent unknown. The port explicitly says absent means unknown, contradicting storage behavior.

**Real-world scenario:** One collector stops reporting its raw total while another returns zero. Both runs look identical; a large CIEE business-filter cut cannot be distinguished from a source/schema loss.

**Impact:** Operators still cannot reliably answer how many jobs each source returned or exactly where they disappeared.

**Why existing tests did not catch it:** Tests assert aggregate increments, not the reconciliation invariant or missing-count semantics.

**Recommendation:** Persist nullable/completeness-aware, per-source/query funnel counters with mutually exclusive reason codes.

## [PR-015] [MEDIUM] Result caps are not exact and external-source truncation is absent from run accounting

**Confidence:** CONFIRMED

**Component:** Collection pagination/truncation

**Location:** `src/posting/infrastructure/ciee-collector.ts:164`, `src/posting/infrastructure/ciee-collector.ts:177`, `src/posting/infrastructure/solides-collector.ts:138`, `src/cli/main.ts:239`

**Affected flow:** configured maxResults → pagination → normalization/scoring backlog

**Expected behavior:** A configured maximum should bound scanned/returned items exactly and every source cap should be visible.

**Actual behavior:** CIEE always requests a full `pageSize`, so `maxResults: 50` with page size 100 can scan/return 100. Sólides has fixed pages of 10, so a cap of 15 can return 20. Indeed/Catho limits are not represented in `truncatedSources`; run accounting only receives internal `CollectionResult.truncated`.

**Evidence:** CIEE does not reduce the final request size. Sólides bounds loop starts, not final item count. External ingest has no truncation metadata.

**Real-world scenario:** A supposedly bounded diagnostic/production query processes more vacancies than configured, while an external collector reaches its cap without any run-level truncation signal.

**Impact:** Unexpected source load, database volume and downstream OpenRouter candidate volume.

**Why existing tests did not catch it:** Tests cover the flag at standard page-aligned caps, not non-multiple or `pageSize > maxResults` cases; external collectors are outside the result contract.

**Recommendation:** Define whether caps bound scanned or emitted items, enforce it exactly, and carry external pagination/truncation metadata through ingest.

## [PR-016] [MEDIUM] CIEE is a nationwide crawl but is omitted from nationwide-source unknown-location rejection

**Confidence:** CONFIRMED

**Component:** Prefilter location policy

**Location:** `config/criteria.yaml:96`, `config/criteria.yaml:215`, `src/prefilter/domain/pre-filter.ts:124`

**Affected flow:** CIEE full-board fetch → missing/unparsed city → prefilter → OpenRouter

**Expected behavior:** Unknown location from a national unfiltered board should not receive ordinary unknown-axis leniency.

**Actual behavior:** Configuration lists only Catho in `nationwideSources`. CIEE deliberately fetches the entire national board and filters geography in prefilter, yet a CIEE posting with unknown city passes.

**Evidence:** The criteria comments state CIEE filters are ignored and no city is sent. The location rule rejects unknown only for sources in the list.

**Real-world scenario:** A CIEE item lacks `local.cidade`; it could be anywhere in Brazil but passes to paid scoring as if it were plausibly in Rio/remote.

**Impact:** Incorrect classifications and avoidable LLM cost during schema/data gaps.

**Why existing tests did not catch it:** AC-024 tests use Catho exclusively and the criteria default itself encodes only Catho.

**Recommendation:** Derive unknown-location policy from each acquisition mechanism and test every full-board source.

## [PR-017] [MEDIUM] New cache dimensions are post-filters, not persisted composite identities

**Confidence:** CONFIRMED

**Component:** Stage A/Stage B cache persistence

**Location:** `src/persistence/infrastructure/schema.ts:121`, `src/persistence/infrastructure/schema.ts:158`, `src/persistence/infrastructure/extractions-repository.ts:60`, `src/persistence/infrastructure/matches-repository.ts:51`

**Affected flow:** model/content/requirement changes → cache miss/upsert → later reversion or concurrent scoring

**Expected behavior:** Each semantically distinct cache input should coexist under its declared key and aggregate readers should select compatible rows.

**Actual behavior:** Database uniqueness remains only `(fingerprint,promptVersion)` for Stage A and `(fingerprint,profileHash,promptVersion)` for Stage B. Model/content/requirements hashes are checked after reading and overwrite the existing row. A→B→A switches repeatedly lose A and pay again; concurrent variants overwrite each other. M10 aggregate readers ignore model/content/requirements compatibility.

**Evidence:** Migrations 0015/0016 add nullable columns but no new unique index. `findAllForPromptVersion` and `findAllForProfile` filter only old key dimensions.

**Real-world scenario:** Calibration alternates two models or a description is temporarily edited and reverted. Previously valid results have been overwritten, causing repeated OpenRouter calls; analytics can consume a row without knowing which model/content set produced it.

**Impact:** Cost amplification, cache thrash and ambiguous retrospective analysis. Sequential stale-hit correctness is improved, but the persisted model does not match its documented key semantics.

**Why existing tests did not catch it:** Tests assert A then B causes a miss, not A→B→A reuse, concurrent variants, or M10 compatibility.

**Recommendation:** Make semantic dimensions part of the persisted identity/version model and scope all readers to compatible artifacts.

## [PR-018] [MEDIUM] Profile hash and Stage B academic evidence use different clocks

**Confidence:** CONFIRMED

**Component:** Academic-period cache invalidation

**Location:** `src/cli/main.ts:539`, `src/cli/main.ts:597`, `src/scoring/infrastructure/stage-b-matcher.ts:115`, `src/scoring/infrastructure/stage-b-matcher.ts:131`, `src/scoring/infrastructure/prompts.ts:162`

**Affected flow:** semester boundary during a run → profileHash → Stage B prompt/cache

**Expected behavior:** The same immutable evaluation instant must feed profile hash and prompt evidence.

**Actual behavior:** Delivery hashes the profile with `startedAt`, but `StageBMatcher` ignores its injected `now` while building prompts; `buildStageBPrompt` defaults to a fresh `new Date()` for each requirement.

**Evidence:** The matcher passes no date at line 131 and uses `now()` only when persisting the cache row.

**Real-world scenario:** A long run crosses a semester boundary. Its key represents the old period while later prompts contain the new period, poisoning the old-period cache identity until another invalidation occurs.

**Impact:** Rare but real stale/miskeyed academic match and false score around boundary dates.

**Why existing tests did not catch it:** Hash and prompt date tests are separate and do not cross a boundary in one matcher call.

**Recommendation:** Capture one evaluation timestamp and thread it through profile hashing, prompt construction, event timestamps and cache persistence.

## [PR-019] [MEDIUM] OpenRouter usage is a visible lower bound, but still not a reconciled account

**Confidence:** CONFIRMED

**Component:** OpenRouter accounting and run persistence

**Location:** `src/scoring/infrastructure/openrouter-client.ts:383`, `src/scoring/infrastructure/openrouter-client.ts:413`, `src/cli/main.ts:530`, `src/persistence/infrastructure/schema.ts:222`

**Affected flow:** HTTP/provider error or malformed envelope → usage totals → run row

**Expected behavior:** Every provider-reported usage record should be captured and outcomes needed for reconciliation should persist.

**Actual behavior:** HTTP error bodies are treated as text and any usage in them is ignored. If the overall 2xx envelope schema fails, a valid nested usage object is also discarded. Runs persist total attempts/cost/unknown count but not `attemptsByOutcome`, token counts, cached tokens or `blockedByCircuit`.

**Evidence:** Usage extraction happens only after full `ChatCompletionResponseSchema.safeParse`. `usageCounts` writes only three fields.

**Real-world scenario:** OpenRouter returns a charged/error envelope or usage plus malformed choices. Attempts are visible and “unknown” increases, but local cost/tokens cannot reconcile with the provider dashboard or diagnose the reason distribution historically.

**Impact:** Financial reporting remains a lower bound and retry/circuit effectiveness cannot be audited from persisted runs.

**Why existing tests did not catch it:** Tests correctly assert the lower-bound counters, but do not require partial-envelope usage extraction or persistence of the detailed taxonomy.

**Recommendation:** Persist an attempt ledger/aggregated taxonomy and reconcile provider-reported usage independently from completion-content validation.

## [PR-020] [MEDIUM] Catho still fetches sitemap-controlled URLs before applying the host allowlist

**Confidence:** CONFIRMED

**Component:** Catho SSRF boundary

**Location:** `collectors/catho/collect.ts:132`, `collectors/catho/collect.ts:136`, `collectors/catho/collect.ts:142`, `collectors/catho/state.ts:54`

**Affected flow:** fixed sitemap index → child sitemap URL → host network; candidate navigation redirect

**Expected behavior:** Every externally supplied URL must be validated before any network request.

**Actual behavior:** Child sitemap URLs are filtered only by a path regex and then passed to `fetchText`; a malicious `<loc>` with a matching suffix on another host is fetched. Candidate final host is checked only after Playwright has already followed the redirect. The allowlist checks protocol/hostname but not the documented exact origin/port.

**Evidence:** `SITEMAP_ENTRY_PATTERN` is path-only. `isAllowedCathoUrl` is called for candidate postings, not child sitemap fetches, and accepts an alternate HTTPS port.

**Real-world scenario:** A compromised index points to an internal URL ending `/sitemap2/sitemap_vagas_1.xml`, or a valid Catho candidate redirects to an internal host. The request occurs before rejection.

**Impact:** Residual SSRF-shaped access from the collector host/container.

**Why existing tests did not catch it:** Tests exercise candidate strings and post-navigation final URLs, not child sitemap fetches, redirects at request time, or ports.

**Recommendation:** Apply an exact-origin allowlist before every fetch/navigation and intercept/block disallowed redirects before the request is issued.

## [PR-021] [MEDIUM] Posting events do not provide end-to-end traceability or reproducible scoring identity

**Confidence:** CONFIRMED

**Component:** `posting_events` observability

**Location:** `src/persistence/infrastructure/schema.ts:255`, `src/cli/main.ts:600`, `src/cli/main.ts:630`

**Affected flow:** collection → normalization → dedup → prefilter → cache/scoring → delivery

**Expected behavior:** A posting-level audit trail should explain every drop and identify the exact scoring inputs/artifacts used.

**Actual behavior:** Events begin only in delivery and cover prefilter, score and delivery. Collection schema rejection, normalization rejection, too-old collection drops, exact existing, dedup canonical/duplicate relation, cache hits/misses, Stage A/Stage B attempt taxonomy, profile hash, model and prompt identity are absent. Score events record only verdict/failure reason.

**Evidence:** The event schema has `runId`, fingerprint, stage, outcome, reason, criteriaHash and time only. There are no foreign keys/checks and no event calls in collection/dedup.

**Real-world scenario:** A posting disappears before scoring or receives a surprising verdict. Events cannot show the source drop/canonical pair or reconstruct which model/cache/profile produced the result.

**Impact:** AC-019 is closed for prefilter decisions, but AC-027's end-to-end operational questions remain unanswered.

**Why existing tests did not catch it:** Tests assert rows are append-only and that the three implemented stages emit events; they do not enforce full pipeline reconciliation.

**Recommendation:** Define a versioned event vocabulary spanning every admission/drop/cache/provider boundary and persist artifact identities without sensitive payloads.

## 7. Low Findings

## [PR-022] [LOW] External collector builds are improved but not fully reproducible or build-tested

**Confidence:** CONFIRMED

**Component:** Indeed/Catho dependency supply chain and CI

**Location:** `collectors/indeed/Dockerfile:15`, `collectors/indeed/requirements.txt:9`, `collectors/catho/Dockerfile:13`, `.github/workflows/ci.yml:57`

**Affected flow:** rebuild external collector images

**Expected behavior:** The same commit should resolve the same complete dependency/image graph and CI should validate the executable collector image.

**Actual behavior:** Direct Python packages and npm lockfile are pinned, but Docker base images use mutable tags rather than digests, Python transitive dependencies are not locked/hashed, and CI tests only Catho's pure `state.ts`; it does not typecheck/build `collect.ts` or build either image.

**Evidence:** `requirements.txt` contains two direct pins; Dockerfiles use tag references; the CI comment explicitly limits the job to pure state logic.

**Real-world scenario:** A base tag or transitive Python package changes while the repository commit stays fixed, or `collect.ts` breaks only inside the image and CI stays green.

**Impact:** Residual deployment drift and late failures, with limited direct runtime impact.

**Why existing tests did not catch it:** The build artifacts are outside current CI scope.

**Recommendation:** Lock complete build inputs and add non-network image/typecheck smoke validation.

## [PR-023] [LOW] Future-date remediation changes the decision but preserves no anomaly signal

**Confidence:** CONFIRMED

**Component:** Prefilter recency observability

**Location:** `src/prefilter/domain/pre-filter.ts:81`, `src/prefilter/domain/pre-filter.ts:96`, `src/cli/main.ts:613`

**Affected flow:** implausible source date → prefilter fallback → event

**Expected behavior:** Invalid/future source dates should not bypass recency and should remain diagnosable as source-data anomalies.

**Actual behavior:** The fallback to `firstSeenAt` correctly prevents indefinite freshness, but no field/event/counter records that `publishedAt` was implausible. A newly first-seen malformed posting still passes until the ordinary age window expires.

**Evidence:** The prefilter returns only pass/first rejection reason and emits `too_old` later; it does not expose a date-anomaly flag.

**Real-world scenario:** A source begins emitting 2099 for every posting. Jobs score for up to the fallback window and operations cannot distinguish the schema/date incident from normal undated postings.

**Impact:** Reduced observability and delayed detection rather than indefinite bypass.

**Why existing tests did not catch it:** Tests assert pass/reject timing only, not anomaly reporting or source spike detection.

**Recommendation:** Preserve normalized-date validity/anomaly metadata and count it per source.

## [PR-024] [LOW] Updated documentation overstates security and retry guarantees

**Confidence:** CONFIRMED

**Component:** SECURITY.md / ADR-006 / ADR-035

**Location:** `SECURITY.md:70`, `docs/adr/006-llm-output-failure-policy.md:143`, `docs/adr/035-llm-retry-taxonomy-backoff-and-circuit-breaker.md:126`

**Affected flow:** future design and operational response

**Expected behavior:** Documentation should describe guarantees the runtime actually enforces and expose known limitations.

**Actual behavior:** SECURITY.md implies posting text cannot supply evidence, while PR-005 shows it can direct use of genuine irrelevant evidence and PR-001 shows valid non-competency evidence is rejected. ADR-006 promises manual rescoring after failure without a supported path. ADR-035 states exactly one half-open trial despite PR-008.

**Evidence:** The claims conflict directly with executable code and reachable interfaces.

**Real-world scenario:** A future change relies on these statements as already-satisfied invariants and removes compensating checks or fails to build the missing recovery operation.

**Impact:** Maintenance/design drift and false operational confidence.

**Why existing tests did not catch it:** Documentation claims are not tied to cross-layer acceptance tests.

**Recommendation:** Express guarantees as executable invariants and explicitly label residual limitations until their acceptance tests pass.

## 8. Updated OpenRouter Cost Model

At commit `12a5154`, Stage A and Stage B use separate transport (`T = 4`) and output-repair (`O = 3`) budgets. Because one terminal/success attempt is shared by the counters, the maximum network/model invocations for one logical operation is:

`maxAttemptsPerOperation = T + O - 1 = 6`

For a cold posting with `R` extracted requirements:

- normal success: `1 + R` calls;
- theoretical per-posting maximum while every logical operation eventually reaches its last permitted attempt: `6 × (1 + R)` calls;
- Stage A terminal failure: at most 6 calls and no Stage B;
- permanent 401/403/other classified 4xx: 1 call per posting, no inner retry;
- complete Stage A and Stage B cache hit: 0 calls;
- Stage B partial failure: already successful requirement calls are not persisted, so a later supported re-execution would repeat the whole Stage B set.

| Requirements (`R`) | Normal cold run | Theoretical maximum |
| ---: | ---: | ---: |
| 5 | 6 | 36 |
| 10 | 11 | 66 |
| 25 | 26 | 156 |
| 50 | 51 | 306 |

Assuming 25 requirements per posting and no cache:

| Postings | Expected normal calls | Theoretical maximum calls |
| ---: | ---: | ---: |
| 100 | 2,600 | 15,600 |
| 300 | 7,800 | 46,800 |
| 1,000 | 26,000 | 156,000 |

The shared breaker may reduce calls during sustained transport failure, but PR-008 means the half-open recovery bound is not reliable under concurrency. The maximum before AC-016 was `3 × (1 + R)`; separating the budgets therefore doubles the theoretical per-operation ceiling from 3 to 6. This is not automatically a defect—the budgets protect different failure classes—but it requires monitoring and a batch/global cost ceiling that does not currently exist.

No local authoritative model price was found, so dollar values are intentionally not invented. A cost formula is:

`cost = Σ(promptTokens_i × inputPrice + cachedPromptTokens_i × cachedInputPrice + completionTokens_i × outputPrice)`

Provider-reported `cost` remains preferable where present; PR-019 explains why persisted local totals are still a lower bound.

## 9. Test Coverage Assessment

The increase from 774 tests reported by the original audit to 922 root tests plus 34 Catho tests is meaningful. Unit protection is particularly good around:

- collector page preservation and internal truncation flags;
- registry dispatch;
- cache invalidation on content/model/requirements;
- score configuration invariants;
- retry taxonomy, `Retry-After`, accounting and basic circuit states;
- Catho state transitions;
- posting event append-only behavior.

The principal gap is composition. The suite proves parts in isolation but not the invariants across them. Missing pipeline-protection includes:

- prompt evidence catalog equals provenance catalog;
- genuine-but-irrelevant evidence cannot satisfy a requirement;
- a scoring failure remains recoverable after delivery;
- permanent client-wide OpenRouter failure aborts without iterating/marking the backlog;
- per-source outage recovery while another source succeeds;
- ingest interleaved between dedup and candidate claim;
- two half-open circuit callers;
- malformed-but-valid JSON cache arrays;
- cross-source negative dedup corpus/property tests;
- exact cap behavior at non-page-aligned values;
- child sitemap/redirect allowlist enforcement before request;
- Catho crash after each page and concurrent state writers;
- event/counter reconciliation from source receipt to notification.

Passing suites should therefore be interpreted as strong unit coverage, not proof that the remediation program is pipeline-protected.

## 10. Positive Changes to Preserve

Future fixes should preserve these successfully implemented properties:

- collectors return partial successful pages without hiding the later error;
- source dispatch uses the registry consistently for scheduler, REST and MCP;
- Stage A cache checks both semantic posting content and model;
- Stage B cache checks requirements, profile, prompt version and model before a sequential hit;
- the LLM still does not emit the numeric score; deterministic score/config ranges are enforced and clamped;
- OpenRouter attempts are counted before the network result, with explicit unknown-usage accounting;
- transport retries no longer mutate the prompt and now use bounded jitter/`Retry-After`;
- output repair remains Zod-validated and bounded;
- Catho does not mark ingest success before a confirmed 2xx;
- page 403/429/5xx are no longer mislabeled as confirmed expiration;
- prefilter reason and criteria identity are append-only per run;
- delivery surfaces recommendation context and explicit scoring failure to the human;
- no remediation deleted posting rows or delegated score computation to the model.

## 11. Recommended Fix Order

The order below follows dependencies rather than severity alone:

1. Stop the AC-008 regression by unifying prompt/provenance evidence catalogs; add semantic applicability and prompt-injection pipeline tests at the same boundary.
2. Separate failed-reporting from successful notification and define recoverable posting evaluation state before changing retry/circuit behavior further.
3. Make permanent OpenRouter auth/model errors batch-fatal and persist detailed attempt outcomes; then fix half-open exclusivity and failure-scope taxonomy.
4. Introduce persisted atomic pre-score admission/claim semantics; only then rely on dedup-before-score as a financial guarantee.
5. Replace global recovery timestamps with per-source/query progress before widening or tuning recency windows.
6. Make cache artifacts fully versioned/composite and domain-validated before adding per-requirement Stage B progress.
7. Put similarity decisions into shadow/auditable mode, calibrate negative pairs, and address source identity/repost lifecycle before further widening cross-source grouping.
8. Complete collection reconciliation: per-source counters, exact caps, external truncation, date anomaly, and nationwide-source location policy.
9. Finish Catho operational durability/replay and exact-origin request enforcement before enabling its timer.
10. Expand posting events to collection/dedup/cache/provider identities and align SECURITY/ADRs with the guarantees actually enforced.
11. Close the unchanged credential-scope, delivery idempotency, input-bound, and measured-performance findings after the state/observability foundations above exist.

## 12. Final Assessment

The remediation series is a substantial engineering improvement, not superficial churn: it adds tests, schemas, migrations, operational counters and several correct cache/collector fixes. However, commit titles systematically use “fix” for changes that often satisfy only one subcase of the original acceptance criteria. The current risk profile is dominated by cross-layer composition rather than missing unit logic.

The project should not consider the audit backlog closed. In particular, AC-008, AC-009, AC-005, AC-028 and AC-016 need another remediation pass before OpenRouter cost and vacancy-retention guarantees can be treated as reliable.
