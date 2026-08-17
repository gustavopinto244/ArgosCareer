# ArgosCareer Remediation and Resolution Plan

## 1. Purpose and Scope

Este documento transforma os 34 findings de `AUDIT_REPORT.md` em sugestões de alteração e resolução executáveis em tarefas futuras.

Ele não contém código, patches, migrations, comandos destrutivos ou mudanças de implementação. Seu objetivo é definir:

- resultado esperado de cada correção;
- dependências entre correções;
- critérios de aceite;
- testes necessários;
- observabilidade exigida;
- estratégia de rollout e recuperação;
- pontos do design atual que não devem ser perdidos.

As propostas se referem ao estado auditado no commit `12b4a3b`. Antes de implementar qualquer uma, a tarefa futura deve confirmar se o finding ainda existe no commit corrente.

## 2. Principles for Remediation

### 2.1 Preserve evidence before changing behavior

Mudanças em collection, fingerprint, dedup, caches ou states podem tornar impossível comparar o antes e o depois. Sempre que possível, primeiro deve ser criada observabilidade suficiente para medir:

- volume recebido por source/query;
- rejeições por motivo;
- relações entre duplicata e canonical;
- chamadas, retries, cache hits e custo do OpenRouter;
- estado de cada posting ao longo de um run.

As duas perdas críticas do Catho são a exceção: devem ser contidas imediatamente, mesmo antes da plataforma completa de métricas.

### 2.2 Avoid destructive data rewrites as the first step

Fingerprint e dedup afetam histórico, notification state e caches. A primeira implementação deve preferir:

- novos campos/tabelas em paralelo;
- backfill auditável;
- modo de comparação sem alterar o canonical atual;
- dry run de dedup;
- feature flag ou rollout por source;
- capacidade de retornar ao comportamento anterior.

### 2.3 Separate identity, similarity and lifecycle

Uma correção futura não deve continuar usando uma única chave para três conceitos diferentes:

- identidade do anúncio na fonte;
- agrupamento da mesma oportunidade entre fontes;
- repost ou nova abertura ao longo do tempo.

Esses conceitos precisam de regras e estados independentes.

### 2.4 Treat OpenRouter inputs as versioned artifacts

Cache válido deve representar todos os inputs semânticos que influenciam a resposta, incluindo conteúdo da vaga, extraction usada, profile evidence derivada, prompt e modelo. Versões manuais continuam úteis, mas não devem ser a única proteção contra stale data.

### 2.5 Keep deterministic scoring

Nenhuma remediação deve delegar score numérico ou verdict final ao LLM. O modelo pode continuar extraindo e comparando evidências; a validação das evidências e o cálculo devem permanecer em código determinístico.

### 2.6 Make failure visible without exposing sensitive content

Observabilidade deve registrar identifiers, source, stage, reason code, contagens, timings e usage. Descrição integral da vaga, profile evidence, secrets e prompts completos não devem ser necessários em logs operacionais.

### 2.7 One behavioral change per rollout

Alterar simultaneamente queries, fingerprint, prompts, modelo, cache e pesos elimina a possibilidade de atribuir resultados. Cada entrega deve declarar qual variável mudou e qual métrica demonstrará sucesso ou regressão.

## 3. Recommended Program Sequence

| Phase | Objective | Findings primarily addressed | Exit condition |
| --- | --- | --- | --- |
| 0 | Conter perda permanente no Catho | AC-001, AC-002 | nenhuma falha transitória ou de ingest avança o checkpoint |
| 1 | Criar audit trail e accounting confiável | AC-012, AC-013, AC-015, AC-019, AC-027, AC-029 | todo drop/call/cache/retry é explicável por source e run |
| 2 | Corrigir coleta e dispatch | AC-003, AC-004, AC-023, AC-024, AC-028, AC-030, AC-034 | coleta parcial é preservada e coverage/truncation são visíveis |
| 3 | Redesenhar identidade e dedup | AC-005, AC-010, AC-011, AC-014, AC-020, AC-031 | reposts e vagas distintas sobrevivem; duplicates não chegam ao LLM |
| 4 | Endurecer LLM, caches e custo | AC-006, AC-007, AC-008, AC-009, AC-016, AC-017, AC-018, AC-025 | cache representa inputs; evidence é validada; falhas não repetem tudo |
| 5 | Reduzir blast radius e tornar delivery idempotente | AC-021, AC-022, AC-026 | credentials têm escopo e envio parcial é retomável |
| 6 | Performance, constraints e alinhamento documental | AC-032, AC-033 | hot paths medidos; docs refletem runtime; legado rotulado |

As phases não precisam corresponder a um único pull request. Findings de identidade/cache normalmente exigirão várias entregas: schema aditivo, dual-read/dual-write, backfill, comparação, ativação e remoção do caminho antigo.

## 4. Immediate Containment

### AC-001 — Catho checkpoints before durable ingest

**Target outcome:** Um posting Catho só deixa de ser elegível para coleta quando existir confirmação durável de ingest ou prova confiável de estado terminal na fonte.

**Suggested resolution:**

- Separar no state file os conceitos de descoberto, coletado, ingest confirmado, expirado confirmado e falha retryable.
- Adiar o avanço para “ingest confirmado” até receber resposta de sucesso da API principal.
- Manter payloads coletados em uma fila local durável enquanto aguardam envio, evitando reabrir páginas já extraídas após falha de rede.
- Tornar a gravação do state atômica e recuperável após interrupção.
- Adicionar identificador de batch/idempotency no envio para que repetir o mesmo batch seja seguro.
- Definir política explícita para 409: aguardar/repetir em vez de descartar.

**Dependencies:** Nenhuma para contenção. A integração completa deve depois usar o audit trail da Phase 1.

**Acceptance criteria:**

- Falha de rede, timeout, 409, 429 ou 5xx após coleta não remove IDs do próximo retry.
- Encerramento do processo entre coleta, state write e ingest não perde payload.
- Repetição do mesmo batch não cria duas oportunidades.
- É possível reconciliar todos os IDs do batch com um estado terminal ou retryable.

**Required tests:**

- crash em cada boundary do fluxo;
- ingest success, 4xx terminal definido, 409, 429, 5xx, timeout e connection reset;
- state file truncado e recuperação;
- duas execuções repetindo o mesmo batch;
- execução manual concorrente com o systemd unit.

**Rollout:** Primeiro em modo que mantenha o state antigo como backup somente leitura. Comparar contagem de IDs descobertos, enfileirados, confirmados e retryable antes de remover o formato anterior.

### AC-002 — Catho conflates transient page failure with expiration

**Target outcome:** Apenas sinais definidos e testados de expiração encerram permanentemente um candidate.

**Suggested resolution:**

- Introduzir resultado explícito de page collection com estados separados para sucesso, expiração confirmada, resposta retryable e payload inválido.
- Classificar HTTP 429/5xx, response ausente, timeout e falha de parse como retryable.
- Definir quais redirects realmente comprovam expiração, preferindo regras baseadas no destino/estrutura observada em vez de qualquer desvio de URL.
- Tratar JSON-LD ausente ou temporariamente inválido como retryable por um número limitado de ciclos antes de uma quarentena, nunca como expiração imediata.
- Registrar contagem e reason code por estado.

**Dependencies:** Pode ser entregue junto com AC-001, mas os dois critérios devem permanecer testáveis separadamente.

**Acceptance criteria:**

- 429/5xx/no-response/invalid-JSON não entram no conjunto terminal.
- Log e métricas não chamam falha transitória de “expired”.
- Um candidate só expira após condição explicitamente documentada.
- Itens em quarentena continuam visíveis operacionalmente e podem ser reprocessados.

**Required tests:** Matriz de status HTTP, redirect destinations, HTML sem JSON-LD, JSON-LD inválido, página recuperada no ciclo seguinte e expiração real confirmada.

## 5. Observability and Accounting Foundation

### AC-012 — Invisible internal schema and normalization rejection

**Target outcome:** Cada item retornado pela fonte termina em exatamente uma categoria observável.

**Suggested resolution:**

- Criar counters por source, query e run para received, schema-valid, schema-rejected, normalized, normalization-rejected, too-old, exact-existing e persisted-new.
- Usar reason codes estáveis e cardinalidade baixa; detalhes extensos ficam em amostra controlada, sem descrição integral.
- Fazer collectors reportarem número de itens brutos antes da validação.
- Fazer o fluxo interno contabilizar normalizer `null` da mesma forma que o ingest externo.
- Alertar mudança abrupta de validation/normalization rate por source.

**Acceptance criteria:** A soma das categorias reconcilia exatamente o total recebido; uma mudança simulada de campo obrigatório gera alerta e run explicável.

**Required tests:** Invariantes de reconciliação, batches mistos, 100% schema rejection, 100% normalization rejection e proteção contra alta cardinalidade nos labels.

### AC-013 — Silent collection truncation

**Target outcome:** Nenhum collector termina “success” sem informar que interrompeu uma fonte ainda paginável.

**Suggested resolution:**

- Padronizar metadata de collection result: total conhecido, itens escaneados, itens retornados, páginas lidas, next-page disponível e truncation reason.
- Comparar caps locais com total/pagination do source quando disponível.
- Para sources opacas, marcar cap reached mesmo sem conhecer o total.
- Definir estratégia por source: ampliar cap, continuar em cursor no próximo run ou aceitar truncamento como política explícita.
- Exibir truncation no run summary e alertar repetição contínua.

**Acceptance criteria:** Cenário de 100 vagas com cap 50 produz 50 itens e `truncated=true`, nunca um success indistinguível de resultado completo.

**Required tests:** Total maior/igual/menor que cap, source sem total, última página exata, cursor retomado e cap configurado por query.

### AC-015 — Underreported OpenRouter usage

**Target outcome:** Produção diferencia tentativas de rede, respostas aceitas, tokens/custo reportados e custo potencial não reconciliado.

**Suggested resolution:**

- Contabilizar toda tentativa antes do request, com outcome separado: success, HTTP error, timeout, network error, invalid envelope e invalid model output.
- Persistir usage retornado pelo provider mesmo quando o conteúdo falhar posteriormente no schema Stage A/B.
- Distinguir custo reportado pelo provider de estimativa e de custo desconhecido.
- Expor o collector de usage do scorer construído em produção ao run lifecycle.
- Criar reconciliação periódica com dados oficiais do provider, se disponível, sem depender apenas do processo local.

**Acceptance criteria:** Número de attempts local coincide com chamadas feitas pelo fake em todos os failure paths; runs mostram custo conhecido e quantidade de attempts sem usage.

**Required tests:** HTTP errors com/sem usage, body inválido, timeout após envio, valid chat/invalid Stage schema, retries e dois postings no mesmo client.

### AC-019 — Prefilter state not persisted

**Target outcome:** É possível descobrir qual regra rejeitou cada posting, sob qual criteria version e em qual run.

**Suggested resolution:**

- Definir identidade estável da configuração de prefilter.
- Persistir outcome, primeira rejection reason, tracks calculadas, timestamp e run association.
- Manter decisões antigas para comparação, sem tratá-las como verdade após criteria change.
- Separar “rejeitado neste run” de um estado permanente; alteração de criteria deve permitir reevaluation.
- Agregar counts por reason/source.

**Acceptance criteria:** Toda diferença entre candidate pool e filtered count é explicável por rows/eventos; criteria change cria nova decisão sem apagar a anterior.

**Required tests:** Reexecução same criteria, criteria changed, age boundary, posting reingested e query de auditoria por reason.

### AC-027 — Runs lack source and posting-level traceability

**Target outcome:** Um run responde de ponta a ponta o que aconteceu com cada posting sem armazenar secrets/conteúdo sensível.

**Suggested resolution:**

- Criar eventos ou relation table entre run, source/query, posting identity, stage, outcome e reason.
- Persistir breakdown de Stage A failure, Stage B failure, score verdict e delivery status.
- Separar counts de attempts, successes, cache hits e failures.
- Corrigir alert labels para source real ou ciclo multi-source.
- Garantir que catches de ingest externo persistam failure reason e counters já calculados.
- Definir retention/aggregation para evitar crescimento ilimitado.

**Acceptance criteria:** As perguntas da seção de observabilidade do audit report têm resposta por query/run; nenhum log precisa conter prompt/profile/secret.

**Required tests:** Trace completo de posting em cada drop path, redaction, retention e reconciliação dos aggregates com events.

### AC-029 — Invalid or future publication dates

**Target outcome:** Missing, invalid and future-skewed publication dates são estados distintos, observáveis e governados por política.

**Suggested resolution:**

- Preservar raw date e resultado de parse/validation.
- Definir tolerância de clock skew e faixa temporal plausível.
- Não converter invalid silenciosamente em missing.
- Escolher política por source para invalid/future: quarantine, fallback conservador ou reject antes do LLM.
- Alertar alteração súbita na parse-success rate.

**Acceptance criteria:** Datas malformadas/futuras geram reason específico; nenhuma recebe frescor indefinido por acidente.

**Required tests:** Formatos conhecidos, timezone, data futura dentro/fora da tolerância, datas muito antigas, missing legítimo e schema drift.

## 6. Collection and Source Reliability

### AC-003 — REST/MCP multi-source dispatch

**Target outcome:** Scheduler, CLI, REST e MCP usam uma única resolução de collector por source.

**Suggested resolution:**

- Substituir o provider de collector único por uma abstração de registry/resolver compartilhada.
- Tornar query ad-hoc explícita sobre source; definir Gupy como default somente por compatibilidade consciente.
- Validar source desconhecida antes de abrir run ou registrá-la como wiring failure claro.
- Remover diferenças de composition root entre scheduler e API.

**Acceptance criteria:** Um ciclo com queries Gupy, CIEE e Sólides aciona exatamente o adapter correspondente em todos os entry points.

**Required tests:** Collectors fake distinguíveis, ordem de dispatch, source inexistente, body vazio e query ad-hoc.

### AC-004 — Later-page failures discard successful pages

**Target outcome:** Dados válidos de páginas anteriores permanecem utilizáveis e são marcados como collection parcial.

**Suggested resolution:**

- Estender o contrato de collection para representar postings parciais e erro simultaneamente.
- Fazer `executeCollect` normalizar/persistir postings parciais antes de finalizar o run degraded/partial.
- Registrar página/cursor da falha e permitir retomada.
- Definir quando partial é considerado success, degraded ou failed para alerts sem esconder o ocorrido.
- Evitar que retry do ciclo inteiro duplique efeitos além do upsert esperado.

**Acceptance criteria:** Primeira página válida e segunda falha resulta em postings persistidos, run marcado partial e cursor/reason visível.

**Required tests:** Para cada collector: non-2xx, malformed body, invalid envelope, timeout e backoff exhausted em página posterior.

### AC-023 — Query coverage gaps

**Target outcome:** Coverage intencional por source, cidade, modalidade e track é explícito e medido.

**Suggested resolution:**

- Criar uma matriz de search-profile versus queries reais por source.
- Classificar gaps como accepted, deferred ou unintended, com owner/review date.
- Executar probes periódicos de baixo volume para termos/cidades excluídos, sem promovê-los automaticamente.
- Separar discovery recall de prefilter precision; não usar somente “on-track atual” para concluir que um termo jamais terá valor.
- Centralizar parâmetros externos Indeed em configuração versionada ou documentar formalmente sua independência.
- Medir overlap entre queries para quantificar requests redundantes.

**Acceptance criteria:** Toda cidade/modo/track desejada tem ao menos um caminho de discovery ou uma exceção explícita; alterações de query mostram delta de volume, precision e LLM eligibility.

**Required tests:** Config coverage tests e fixtures que provem que oportunidades-alvo são alcançáveis por ao menos uma query.

### AC-024 — Fragile Catho location parsing

**Target outcome:** Degradação do parser de cidade não libera volume nacional silenciosamente ao LLM.

**Suggested resolution:**

- Combinar sinais de page title, metadata e endereço somente quando consistentes e comprovados.
- Versionar parser por padrões observados e registrar qual estratégia produziu a cidade.
- Medir unknown-location rate por batch/source.
- Definir circuit breaker: aumento anormal de unknown deixa postings em review/quarantine antes de scoring pago.
- Ampliar fixture corpus Catho antes de afirmar suporte geral.

**Acceptance criteria:** Mudança simulada de title não converte silenciosamente o batch inteiro em eligible unknown; alerta/circuit breaker entra em ação.

**Required tests:** Variações reais de title, metadata discordante, remote, city outside/inside RJ e batch com unknown spike.

### AC-028 — Recency gap after outage

**Target outcome:** Retomada cobre o intervalo desde a última coleta bem-sucedida dentro de um bound seguro.

**Suggested resolution:**

- Derivar cutoff de recovery do último sucesso por source, não apenas da existência de qualquer sucesso histórico.
- Definir maximum recovery window para impedir backfills ilimitados.
- Diferenciar operação normal de catch-up no run.
- Alertar quando o gap exceder o bound e exigir backfill manual explícito.
- Evitar usar um sucesso de outra source para concluir que uma source específica não precisa de recovery.

**Acceptance criteria:** Outage de três dias não perde postings ainda disponíveis; recovery mostra janela usada e volume backfilled.

**Required tests:** Primeiro run, run normal, outage curta/longa, source parcialmente falha e relógio/timezone.

### AC-030 — External collector reproducibility

**Target outcome:** Rebuild do mesmo commit produz dependências e comportamento previsíveis.

**Suggested resolution:**

- Manter lock/manifest resolvido para Python e usar instalação determinística.
- Fazer a imagem Catho consumir o lock existente e evitar ranges não resolvidos no build.
- Registrar versões das imagens-base por digest ou política equivalente.
- Adicionar contract smoke test da imagem, sem acessar serviços reais.
- Automatizar atualização de dependências como mudança revisável, nunca implícita no rebuild.

**Acceptance criteria:** Dois builds do mesmo commit resolvem as mesmas versões e passam o mesmo contract test.

**Required tests:** Inspect de versões instaladas, payload fixture, startup com env incompleta e image build em CI.

### AC-034 — Catho candidate host validation

**Target outcome:** O browser só navega para protocolos/hosts Catho explicitamente permitidos.

**Suggested resolution:**

- Validar URL completa na descoberta, incluindo protocolo, hostname, porta e path.
- Revalidar URL final após redirects.
- Bloquear endereços locais/privados e hosts não permitidos independentemente do path.
- Registrar candidate rejeitado sem abrir a página.

**Acceptance criteria:** URLs Catho válidas passam; URLs externas, localhost, IP privado, protocolo inesperado e redirect externo são bloqueados.

**Required tests:** Matriz de URLs/redirects adversariais sem tráfego real.

## 7. Identity, Deduplication, and Concurrency

### AC-005 — Deduplication must precede paid scoring in every entry path

**Target outcome:** Nenhuma vaga que já possa ser reconhecida como duplicata chega ao OpenRouter antes da decisão de identidade/deduplicação.

**Suggested resolution:**

- Criar uma única barreira de admissão para scoring, compartilhada por scheduler, API, MCP, CLI e ingest externo.
- Fazer a barreira executar persistência idempotente, deduplicação exata e avaliação de similaridade antes de liberar trabalho pago.
- Remover a responsabilidade de cada caller decidir se dedup deve ou não acontecer; callers apenas submetem candidatos.
- Registrar a decisão da barreira, incluindo posting canônico, método e versão do algoritmo.
- Tratar importações históricas e reprocessamento como modos explícitos, sem bypass implícito.
- Incluir uma guarda imediatamente antes do primeiro request ao OpenRouter para impedir regressões de wiring.

**Dependencies:** AC-010, AC-011, AC-014 e AC-020 devem definir identidade segura e atomicidade; AC-027 deve medir admissões e bloqueios.

**Acceptance criteria:** Todos os entry points atravessam a mesma barreira; duplicatas exatas e similares confirmadas geram zero novas chamadas; a decisão é auditável.

**Required tests:** End-to-end por scheduler/API/MCP/CLI/Indeed/Catho/LinkedIn, com contador fake do OpenRouter e duas submissões concorrentes da mesma vaga.

### AC-010 — Separate source identity, canonical identity, similarity, and repost lifecycle

**Target outcome:** O sistema deixa de usar um único fingerprint como resposta para quatro problemas diferentes.

**Suggested resolution:**

- Preservar a identidade nativa da source como chave idempotente de ingest quando ela for estável.
- Criar uma identidade canônica de posting separada, sem descartar URL, source ID ou data de publicação.
- Tratar similaridade como relação explicável entre postings, não como identidade absoluta.
- Modelar repost como evento/lifecycle: mesma oportunidade pode ganhar uma nova publicação sem apagar o histórico anterior.
- Definir política temporal para distinguir atualização, repost e vaga independente, com evidências por source.
- Não reescrever ou fundir dados históricos até medir o impacto do novo modelo em shadow mode.
- Guardar versão e razões da decisão para permitir revisão e recomputação.

**Decision required:** Definir horizonte de repost e política por source; não há um intervalo universal comprovado pelo repositório.

**Acceptance criteria:** Duas vagas legítimas da mesma empresa/título/cidade podem coexistir; repetição do mesmo source ID é idempotente; repost é visível; cross-source match não depende apenas do fingerprint atual.

**Required tests:** Mesma vaga em Gupy/LinkedIn, pequenas variações de título, repost após uma semana, duas vagas simultâneas iguais, URL alterada e source ID reutilizado.

### AC-011 — Make similarity dedup conservative and evidence-based

**Target outcome:** Similaridade não elimina vagas quando os sinais discriminantes são insuficientes.

**Suggested resolution:**

- Impedir auto-merge quando a normalização deixa título vazio ou composto apenas por stopwords.
- Exigir múltiplos sinais independentes antes de uma decisão destrutiva, como organização normalizada, título informativo, localização compatível, descrição/URL e proximidade temporal.
- Criar uma faixa de incerteza que preserve ambos os postings e os encaminhe a revisão ou observação.
- Diferenciar “não é possível provar que são diferentes” de “há evidência de que são iguais”.
- Calibrar thresholds em corpus rotulado com positivos e negativos reais, medindo falsos positivos como risco prioritário.
- Executar a nova lógica em shadow mode e comparar decisões antes de habilitar supressão.

**Acceptance criteria:** Títulos sem sinal não produzem merge; nenhuma decisão automática depende apenas de tokens genéricos; cada supressão contém evidências e versão.

**Required tests:** Corpus adversarial de títulos curtos/genéricos, empresas com múltiplas vagas iguais, acentos, abreviações, stopwords, cidades vizinhas e datas distintas.

### AC-014 — Improve cross-source matching without turning unknowns into equality

**Target outcome:** Aliases legítimos são reconhecidos, mas ausência de informação não é tratada como confirmação.

**Suggested resolution:**

- Manter tabela/versionamento de aliases de organização com provenance, em vez de normalização puramente textual irreversível.
- Classificar compatibilidade de localização como same, compatible, conflicting ou unknown.
- Usar domínio corporativo, URL canônica, external metadata e conteúdo como sinais adicionais quando disponíveis.
- Não equiparar localização conhecida e desconhecida; permitir match somente se outros sinais fortes compensarem a ausência.
- Medir separadamente falsos negativos cross-source e merges de baixa confiança.
- Permitir correções manuais que alimentem o corpus de calibração sem alterar silenciosamente o algoritmo.

**Acceptance criteria:** Variações jurídicas comuns da mesma empresa podem convergir; unknown location isoladamente nunca confirma igualdade; matches continuam explicáveis.

**Required tests:** Razão social versus marca, sufixos empresariais, remoto versus cidade, location unknown, URLs compartilhadas e homônimos.

### AC-020 — Replace process-local coordination with atomic database claims

**Target outcome:** Duas instâncias ou processos não persistem, deduplicam nem pontuam o mesmo trabalho simultaneamente.

**Suggested resolution:**

- Usar constraints e operações atômicas do banco para identidade exata, em vez de select-then-write.
- Introduzir claim/lease persistente para cada unidade de trabalho, com owner, início, expiração e heartbeat quando necessário.
- Tornar scheduler overlap guard global ao deployment ou declarar formalmente single-instance com enforcement operacional.
- Definir recuperação de leases após crash sem liberar trabalho ainda ativo.
- Fazer conclusão/falha mudar estado condicionalmente ao claim atual, impedindo worker antigo sobrescrever resultado novo.
- Testar sob duas conexões e dois processos, não apenas promises no mesmo processo.

**Dependencies:** AC-031 para constraints e AC-005 para centralização da admissão.

**Acceptance criteria:** Corrida controlada produz uma persistência, um scoring owner e nenhuma dupla cobrança; crash permite retomada após lease válido.

**Required tests:** Barreiras concorrentes no banco real de teste, restart, lease expirado, heartbeat atrasado, deploy durante run e duas instâncias.

### AC-031 — Enforce persistence invariants in the database

**Target outcome:** Integridade não depende exclusivamente de callers cooperativos.

**Suggested resolution:**

- Inventariar relações lógicas entre postings, caches, runs, dedup decisions, scores e deliveries.
- Adicionar constraints de unicidade somente após identificar e resolver dados conflitantes de forma auditável.
- Adicionar foreign keys e políticas de retenção compatíveis com histórico e caches.
- Adicionar checks para ranges, enums efetivos, timestamps e combinações de estado inválidas.
- Fazer migrations aditivas e reversíveis em etapas: schema novo, backfill verificado, dual-read quando necessário, enforcement final.
- Criar relatório pré-migration de órfãos e conflitos; não apagar registros automaticamente.

**Acceptance criteria:** Banco rejeita duplicação exata e referências inválidas; migration é segura em base com dados existentes; schema Drizzle e migrations descrevem as mesmas garantias.

**Required tests:** Migration from representative snapshot, inserções concorrentes, órfãos, rollback operacional e comparação automatizada de schema.

## 8. OpenRouter, LLM Validation, Cache, and Cost Control

### AC-006 — Bind Stage A cache to the semantic input

**Target outcome:** Mudança relevante em title/description ou demais campos enviados invalida a extração antiga.

**Suggested resolution:**

- Definir uma representação canônica de todos os dados efetivamente enviados à Stage A.
- Derivar a identidade do cache dessa representação, da versão do prompt, do schema de saída e da configuração/modelo que possa mudar a interpretação.
- Manter o fingerprint de dedup separado da identidade semântica do cache.
- Registrar o input identity ao lado da extração e tornar mismatch um miss explícito.
- Planejar namespace novo de cache; não reinterpretar entradas antigas como compatíveis sem prova.
- Medir hit, miss por causa e stale entry detectada.

**Acceptance criteria:** Alterar descrição mantendo empresa/título/local gera miss; repetir entrada semanticamente idêntica gera hit; mudança apenas em metadata não enviada segue a política documentada.

**Required tests:** Mutação individual de cada campo enviado, whitespace/HTML normalization, prompt/schema/model version e cache legado.

### AC-007 — Bind Stage B cache to requirements, extraction, profile, prompt, schema, and model

**Target outcome:** Um match só é reutilizado quando todas as entradas que determinam seu significado continuam equivalentes.

**Suggested resolution:**

- Definir input identity da Stage B incluindo requirement estável, versão/identidade da extração Stage A, profile relevante, prompt, schema e modelo/configuração semântica.
- Evitar chave baseada apenas no posting fingerprint e profile hash.
- Preferir cache por requirement para preservar trabalho parcial válido e limitar reexecução.
- Manter result-set manifest que comprove cardinalidade e associação exata entre requirements e matches.
- Invalidar por namespace/versionamento, sem apagamento em massa obrigatório.
- Documentar quais mudanças de modelo/configuração são consideradas compatíveis; default deve ser miss quando a equivalência não é demonstrável.

**Dependencies:** AC-006 e AC-009.

**Acceptance criteria:** Requirements adicionados/removidos/alterados não recebem matches antigos; troca de Stage A/model/schema não reutiliza resultado incompatível; hit preserva a ordem/identidade correta.

**Required tests:** Mutação de requirement, reorder, duplicate requirement, profile change, prompt/schema/model change e result-set incompleto.

### AC-008 — Isolate untrusted job content and verify evidence provenance

**Target outcome:** Texto da vaga não consegue redefinir instruções, e evidência usada no score é verificável contra a fonte correta.

**Suggested resolution:**

- Separar claramente instruções do sistema e dados não confiáveis, com delimitadores e declaração explícita de que conteúdo da vaga não é comando.
- Na Stage B, tratar tanto requirement quanto texto derivado da vaga como dados não confiáveis.
- Validar que evidência de posting ocorre no conteúdo canônico da vaga e que evidência de profile ocorre no profile autorizado, considerando apenas normalizações documentadas.
- Rejeitar ou marcar como unverifiable qualquer citação inexistente, contraditória ou oriunda do lado errado.
- Não permitir que evidence text, reasoning ou label do modelo ignore regras determinísticas de mandatory/blocking/verifiable.
- Adicionar corpus adversarial multilíngue e monitorar taxa de evidence validation failure.

**Acceptance criteria:** Instruções embutidas na descrição não alteram schema/status; evidence inventada não contribui para score; falha fica visível e não vira not_met silencioso.

**Required tests:** Prompt injection direta/indireta, JSON dentro da vaga, evidência inventada, evidência do documento errado, Unicode confusável e conteúdo vazio.

### AC-009 — Persist partial Stage B progress and explicit scoring failures

**Target outcome:** Uma falha parcial não apaga o histórico nem repete chamadas já concluídas sem necessidade.

**Suggested resolution:**

- Persistir cada match validado por requirement com estado próprio e input identity.
- Registrar operação de scoring com estados pending, running, partial, failed e complete, incluindo categoria da falha.
- Retomar apenas requirements ausentes ou retryable, preservando sucessos compatíveis.
- Não publicar score final enquanto o conjunto exigido estiver incompleto, salvo política de degradação explicitamente aprovada e sinalizada.
- Expor falhas no resultado de run e na observabilidade; não omitir posting como se nunca tivesse existido.
- Definir limite de tentativas cumulativo por input identity, não apenas por execução do processo.

**Acceptance criteria:** Falha no requirement final preserva anteriores; reexecução chama somente pendentes; operador distingue falha de rejeição e de score baixo.

**Required tests:** Falha em cada posição, processo morto após resposta, resposta persistida antes/depois de crash, retry não elegível e retomada concorrente.

### AC-016 — Separate transport retry from output repair and add bounded backoff

**Target outcome:** Retries são previsíveis, observáveis e proporcionais à categoria de erro.

**Suggested resolution:**

- Criar taxonomia operacional para timeout, connection failure, 429, 5xx, provider error, malformed body, JSON inválido e schema inválido.
- Respeitar Retry-After quando confiável e aplicar backoff exponencial com jitter para falhas transitórias.
- Definir budgets separados para request retry e output repair, com teto cumulativo por operação lógica.
- Não repetir automaticamente erros permanentes de autenticação, configuração ou schema incompatível.
- Registrar cada tentativa, resultado, latência e possível cobrança, correlacionados à operação lógica.
- Usar circuit breaker para falha sistêmica, evitando amplificação por muitas vagas concorrentes.

**Acceptance criteria:** 429/5xx não geram tempestade imediata; auth error falha sem repetição; máximo real de requests é derivável da configuração e das métricas.

**Required tests:** Relógio fake para backoff, Retry-After, timeout após envio, conexão encerrada, 401/429/500, provider error e JSON/schema inválido.

### AC-017 — Bound and sanitize LLM inputs and outputs

**Target outcome:** Latência, tokens e falhas por tamanho possuem limites explícitos sem truncamento semântico invisível.

**Suggested resolution:**

- Definir budgets separados de input e output para Stage A e Stage B.
- Converter HTML em texto de modo determinístico, preservando estrutura relevante e registrando redução.
- Quando truncar, usar estratégia consciente de seções e sinalizar input_truncated; não cortar silenciosamente no meio de requisito.
- Definir limite de requirements por posting e encaminhar excesso a política explícita de chunking/quarantine/review.
- Solicitar formato estruturado suportado pelo provider quando disponível, mantendo validação local obrigatória.
- Rejeitar payloads externos acima dos limites antes de reservar grande volume de memória ou custo.

**Acceptance criteria:** Pior caso de tokens é limitado e mensurável; posting truncado é identificável; output excessivo/ausente não entra no score.

**Required tests:** HTML grande, texto no limite, multibyte, 0/1/muitos requirements, resposta truncada, array excessivo e provider sem structured output.

### AC-018 — Include academic-period inputs in cache identity

**Target outcome:** Mudança do período acadêmico ou da data de referência recomputa matches afetados.

**Suggested resolution:**

- Identificar todos os campos temporais/acadêmicos usados no profile, prompt e lógica determinística.
- Incluir representação canônica desses campos no profile/input identity da Stage B.
- Definir a data de referência explicitamente; evitar dependência implícita do relógio atual em resultados cacheados.
- Registrar quando a passagem do tempo, sem edição do profile, torna o cache incompatível.
- Validar timezone e boundary de semestre/período.

**Acceptance criteria:** Avanço acadêmico relevante produz miss/reavaliação; reexecução na mesma data de referência permanece idempotente.

**Required tests:** Virada de semestre, boundary de data/timezone, profile editado e cache criado antes da nova regra.

### AC-025 — Validate deterministic scoring configuration as a coherent system

**Target outcome:** Configurações inválidas não produzem score fora do range ou recomendações incoerentes.

**Suggested resolution:**

- Validar ranges, ordem de thresholds, pesos, caps e combinações mutuamente dependentes no startup e em CI.
- Definir invariantes globais para score e recommendation, não apenas tipos individuais.
- Rejeitar configuração incoerente com mensagem diagnóstica antes de coletar ou chamar LLM.
- Versionar scoring configuration e persistir a versão usada em cada resultado.
- Criar casos de calibração golden que comprovem monotonicidade e limites.

**Acceptance criteria:** Score final sempre fica no range aprovado; aumentar evidência positiva não piora score sem regra explícita; thresholds não se sobrepõem de forma ambígua.

**Required tests:** Property tests de range/monotonicidade, configs extremas, unknown track cap, mandatory/blocking e boundaries de recommendation.

## 9. API, Delivery, and Product Output

### AC-021 — Split credentials by trust boundary and capability

**Target outcome:** Comprometimento de um collector não concede acesso a scoring pago, delivery ou operações administrativas.

**Suggested resolution:**

- Separar credenciais por ator e capability: ingest por source, collection, scoring, delivery e administração.
- Aplicar allowlist de endpoints e source binding; uma credencial Catho não deve declarar LinkedIn ou invocar Telegram/OpenRouter.
- Implementar rotação, revogação individual e identificação do principal nos logs sem registrar o segredo.
- Adicionar rate/volume limits por principal e endpoint, com limites financeiros específicos para operações que acionam LLM.
- Manter Cloudflare/Tailscale como camada complementar, não como substituto da autorização da aplicação.
- Revisar mensagens de erro para não expor configuração, token, payload sensível ou detalhes do provider.

**Acceptance criteria:** Cada credencial acessa somente a capability/source prevista; revogar um collector não interrompe os demais; abuso é atribuível e limitado.

**Required tests:** Matriz principal-endpoint-source, token ausente/inválido/revogado, replay, rate limit, proxy headers e ausência de segredo em logs.

### AC-022 — Make Telegram delivery resumable and idempotent

**Target outcome:** Retry após falha parcial não repete chunks já confirmados nem bloqueia indefinidamente o pipeline.

**Suggested resolution:**

- Persistir uma delivery operation com conteúdo/version identity e um item por chunk.
- Atribuir ordem e identidade estável aos chunks; marcar confirmação somente após resposta válida do Telegram.
- Retomar a partir do primeiro chunk não confirmado e impedir dois workers de entregar a mesma operação.
- Configurar timeout, retry/backoff e limite cumulativo independentes do scoring.
- Se o conteúdo mudar, criar nova versão de delivery em vez de misturar chunks antigos e novos.
- Expor estados partial/failed/complete e permitir reconciliação manual segura.

**Acceptance criteria:** Falha no chunk intermediário e restart reenviam somente o necessário; duas entregas concorrentes não duplicam mensagens; timeout termina de modo observável.

**Required tests:** Falha/timeout por posição, crash após envio antes do ack persistido, conteúdo alterado, duas instâncias e resposta Telegram inválida.

### AC-026 — Deliver recommendation and blocking context already computed

**Target outcome:** A saída apresentada ao usuário reflete recommendation, bloqueios e período acadêmico calculados pelo domínio.

**Suggested resolution:**

- Definir contrato de apresentação único para API, ranking e Telegram.
- Exibir score junto de recommendation e principais razões determinísticas, sem apresentar texto do LLM como decisão autônoma.
- Tornar bloqueios e incertezas visíveis, incluindo unknown track, missing evidence e dados acadêmicos relevantes.
- Versionar o contrato para consumidores externos e manter compatibilidade durante rollout.
- Validar com exemplos golden que classificação e texto não se contradizem.

**Acceptance criteria:** O mesmo posting tem recommendation/razões consistentes em todos os canais; vaga bloqueada não parece recomendada apenas por score numérico.

**Required tests:** Golden outputs para recommendations, mandatory blocker, unknown track cap, período acadêmico e campos ausentes.

## 10. Performance, Maintainability, and Documentation

### AC-032 — Measure and remove demonstrated hot-path repetition

**Target outcome:** O pipeline escala sem mudar decisões nem sacrificar auditabilidade.

**Suggested resolution:**

- Instrumentar tempo e cardinalidade por fase antes de selecionar otimizações.
- Carregar/compilar prompts e configuração imutável uma vez por versão, com invalidation explícita em restart/reload.
- Projetar queries para buscar apenas campos necessários e evitar N+1 em cache, dedup, ranking e delivery.
- Substituir comparação quadrática de similaridade por geração de candidatos/indexação, preservando a mesma decisão final inicialmente.
- Processar backlog em páginas/batches com backpressure e limites de memória.
- Definir benchmarks representativos para 100, 1.000, 10.000 e 100.000 postings.

**Acceptance criteria:** Benchmarks registram tempo, memória, DB queries e candidatos comparados; otimizações mantêm decisões em corpus golden.

**Required tests:** Benchmark reprodutível, equivalence test do dedup, query-count assertions e backlog com memória limitada.

### AC-033 — Remove or clearly label dead and drifted configuration/documentation

**Target outcome:** Operadores conseguem distinguir runtime ativo, compatibilidade histórica e exemplo obsoleto.

**Suggested resolution:**

- Gerar inventário de env vars, prompts, registries, scripts, fixtures e docs com consumidores reais.
- Classificar cada item como active, external-only, test-only, deprecated ou dead.
- Remover somente em mudança própria, após busca de consumidores externos e janela de depreciação quando aplicável.
- Atualizar README, CLAUDE.md, docs e ADR status para o fluxo executável após as correções comportamentais estabilizarem.
- Adicionar check de CI para env/example/config keys sem consumidor conhecido e links de docs quebrados.
- Não apagar ADR histórico; marcar supersession e implementação atual.

**Acceptance criteria:** Todo parâmetro documentado tem consumidor ou rótulo explícito; registries e matrizes de sources refletem o wiring real; operadores não seguem instruções mortas.

**Required tests:** Static config-consumer inventory, documentation link check e startup matrix com as configurações suportadas.

## 11. Cross-Cutting Migration and Rollout Safety

As mudanças acima alteram identidade, cache, estado e observabilidade. Elas não devem ser lançadas como uma substituição única e destrutiva.

### 11.1 Additive schema first

- Criar novos campos/tabelas sem remover os atuais.
- Persistir versões de algoritmo, input identity, operação lógica, claim, status e reason codes.
- Validar schema novo em dados representativos antes de ativar constraints.
- Produzir contagens pré/pós-backfill e lista de conflitos; não resolver conflitos por deleção automática.

### 11.2 Shadow decisions before enforcement

- Executar novo dedup, cache compatibility e prefilter classification em paralelo sem suprimir ou cobrar novamente.
- Comparar decisão nova e antiga com amostra revisada manualmente.
- Definir thresholds de falso positivo, falso negativo e custo antes de promover a nova decisão.
- Guardar rollback switch por estágio, não apenas para o pipeline completo.

### 11.3 Namespace cache migrations

- Criar namespaces novos para Stage A e Stage B.
- Tratar cache antigo como incompatível por default, mas preservar para auditoria até a política de retenção ser aprovada.
- Controlar warming com budget; evitar que invalidation provoque spike simultâneo de chamadas.
- Acompanhar miss reason para distinguir rollout esperado de regressão.

### 11.4 Backfill without uncontrolled LLM spend

- Separar backfill de dados determinísticos do re-scoring pago.
- Estimar candidates, requirements e pior caso de retries antes de autorizar lote.
- Aplicar limite diário/por run e checkpoint persistente.
- Priorizar postings ativos/recentes; arquivos históricos não devem chamar OpenRouter por consequência acidental de migration.

### 11.5 Rollback and reconciliation

- Rollback deve desativar leitura/enforcement novo sem apagar evidência coletada.
- Operações parcialmente concluídas devem permanecer reconciliáveis.
- Definir owner e runbook para divergência de dedup, gasto anormal, cache miss spike e delivery duplicado.
- Validar rollback em staging com trabalho em andamento, não apenas banco vazio.

## 12. Proposed Issue and Commit Decomposition

Cada item abaixo deve virar uma issue rastreável. Commits devem permanecer pequenos, sem misturar schema, comportamento, observabilidade e documentação quando puderem ser implantados separadamente.

| Order | Work package | Primary findings | Depends on | Safe completion boundary |
| ---: | --- | --- | --- | --- |
| 1 | Catho ack state machine | AC-001, AC-002 | Nenhuma | Falhas preservam candidatos e o comportamento é coberto por fixtures |
| 2 | Run/event observability model | AC-012, AC-013, AC-019, AC-027, AC-029 | Nenhuma | Todo drop/failure possui reason code e contagem reconciliável |
| 3 | OpenRouter attempt ledger | AC-015, AC-016 | Work package 2 | Toda tentativa aparece, inclusive erros e possível cobrança |
| 4 | Collector wiring correction | AC-003 | Work package 2 | Cada source usa seu collector real, comprovado por contract test |
| 5 | Collector partial-progress preservation | AC-004, AC-028 | Work package 2 | Página válida não some por falha posterior; catch-up é explícito |
| 6 | Query/coverage controls | AC-013, AC-023, AC-024 | Work package 2 | Caps, gaps e unknown spikes são mensurados e controlados |
| 7 | Exact identity and DB constraints | AC-010, AC-020, AC-031 | Work package 2 | Ingest duplicado concorrente é atomicamente idempotente |
| 8 | Similarity shadow engine | AC-011, AC-014 | Work package 7 | Novo algoritmo produz decisões comparáveis sem suprimir vagas |
| 9 | Unified pre-score admission barrier | AC-005 | Work packages 7–8 | Todos os entry points deduplicam antes do OpenRouter |
| 10 | Stage A semantic cache identity | AC-006 | Work package 3 | Mudança semântica gera miss observável |
| 11 | Stage B per-requirement persistence/cache | AC-007, AC-009, AC-018 | Work packages 3 and 10 | Falha parcial retoma somente trabalho pendente compatível |
| 12 | LLM trust and bounds | AC-008, AC-017 | Work packages 10–11 | Inputs são limitados e evidências validadas contra suas fontes |
| 13 | Scoring configuration invariants | AC-025 | Work package 2 | Config inválida falha antes de coleta/custo |
| 14 | API credential scopes | AC-021 | Work package 2 | Privilégios e rate limits são separados por ator/capability |
| 15 | Delivery operation state machine | AC-022, AC-026 | Work packages 2 and 7 | Entrega parcial é retomável e a saída reflete decisão real |
| 16 | External build and navigation hardening | AC-030, AC-034 | Nenhuma | Builds são reprodutíveis e browser respeita allowlist |
| 17 | Measured performance work | AC-032 | Work packages 2 and 7 | Otimizações preservam resultados e demonstram ganho |
| 18 | Runtime/documentation reconciliation | AC-033 | Todos os comportamentais aplicáveis | Documentos descrevem o runtime lançado e itens mortos estão rotulados |

### Commit discipline

- Primeiro commit: tipos/schema aditivos e migrations, sem ativar comportamento novo.
- Segundo commit: escrita dual/telemetria ou shadow evaluation.
- Terceiro commit: testes de integração e reconciliação de dados.
- Quarto commit: feature activation com rollback switch.
- Último commit: remoção/depreciação e documentação, somente após janela de estabilidade.
- Findings independentes podem seguir em paralelo, mas nenhum commit deve combinar um hotfix de perda de vagas com uma reformulação ampla de scoring.

## 13. Definition of Done by Domain

### Collection and ingest

- Cada source relata discovered, parsed, rejected, attempted, acknowledged, persisted e failed.
- Paginação/cap e janela de recência são explícitas por run.
- Falha posterior não apaga progresso anterior.
- Retry/restart não perde nem duplica permanentemente candidates.
- Contratos externos são exercitados por fixtures versionadas.

### Identity and deduplication

- Source identity, canonical posting, similarity e repost são conceitos separados.
- Inserção concorrente é protegida no banco.
- Dedup antes de scoring vale para todo entry point.
- Decisões têm versão, evidências e caminho de revisão.
- Corpus rotulado demonstra limites aceitáveis de falso positivo e falso negativo.

### OpenRouter and scoring

- Toda chamada possui operação lógica, tentativa, estágio, posting/input identity e outcome.
- Cache hit só ocorre com compatibilidade semântica comprovada.
- Falha parcial de Stage B é retomável por requirement.
- Evidência é validada contra o texto/profile correto.
- Score/recommendation continuam determinísticos e dentro dos invariantes.
- Budget e theoretical maximum são configuráveis e observáveis antes do rollout.

### API, security, and delivery

- Credenciais têm mínimo privilégio, rotação e rate limits.
- Nenhum log contém segredo.
- Delivery é idempotente por operação/chunk e possui timeout.
- Saída ao usuário informa recommendation, blockers e incerteza de forma consistente.

### Operations and documentation

- Dashboard e alertas respondem às perguntas operacionais do audit report.
- Runbooks cobrem outage, backlog, gasto anormal, provider degradation e reconciliação.
- Docs/ADRs indicam implementação e status atuais.
- Rollback foi exercitado com dados e trabalho em andamento.

## 14. Required Test Strategy

### 14.1 Unit tests

- Parsing e normalização por source com valores ausentes, inválidos, futuros e timezone boundaries.
- Fingerprint/identity, title normalization e similarity com corpus adversarial.
- Prefilter e scoring invariants em todas as boundaries.
- Cache input identity com mutação isolada de cada entrada semântica.
- LLM schema/evidence validation, inclusive surrounding prose, enum inválido, null e cardinalidade incorreta.

### 14.2 Contract tests

- Respostas versionadas de Gupy, CIEE, Sólides, Indeed, Catho e LinkedIn.
- Paginação, rate limit, timeout e schema drift sem rede real.
- Contratos API de ingest/auth/source binding.
- Respostas OpenRouter fake para sucesso, HTTP/provider error, malformed body e output incompatível.
- Telegram fake para confirmação, falha parcial, timeout e retry.

### 14.3 Database integration tests

- Duas conexões concorrentes disputando ingest, dedup, claim, scoring e delivery.
- Constraints, foreign keys, check constraints e migrations a partir de snapshot representativo.
- Crash/restart entre request, persistência e acknowledgement.
- Lease expiration e worker antigo tentando finalizar depois da retomada.

### 14.4 End-to-end pipeline tests

- Uma vaga por cada source atravessando discovery até delivery com todos os estados observáveis.
- Cross-source duplicate antes do OpenRouter.
- Schema rejection e prefilter rejection preservados como eventos, sem scoring.
- Stage A failure, Stage B partial failure e recovery sem repetir sucessos.
- Repost e vagas distintas de mesma empresa/título/cidade.
- Scheduler e ingest externo concorrentes.

### 14.5 Property and invariant tests

- Score sempre dentro do range e recommendation compatível com blockers/caps.
- Cache nunca sobrevive a mutação de entrada semântica declarada.
- Um result-set completo tem associação exata entre requirements e matches.
- Nenhum candidate some sem estado/reason code terminal ou recuperável.
- Mesmo source identity não cria dois postings ativos por corrida.
- Uma operação lógica não excede seu request budget.
- Delivery confirmada não é repetida pela mesma content identity.

### 14.6 Load and resilience tests

- Batches de 100, 1.000, 10.000 e modelo analítico para 100.000 postings.
- Provider degradado sob concurrency real, backoff e circuit breaker.
- Banco lento, pool esgotado e processo reiniciado.
- Backlog maior que uma janela normal de scheduler.
- Cache cold start após mudança de namespace, com budget rígido.

## 15. Metrics, Reconciliation, and Alerts

### Per-source funnel

Para cada source e run, medir discovered, fetched pages, raw valid, raw rejected, normalized, exact duplicate, similar duplicate, prefilter rejected, admitted to scoring, scored, failed, ranked e delivered.

As contagens devem reconciliar. Diferenças exigem uma categoria explícita como pending, quarantined ou manual review; não deve existir um restante anônimo.

### OpenRouter ledger

Medir operações lógicas e tentativas de rede separadamente, com stage, cache status/miss reason, latency, HTTP/provider outcome, parse/schema outcome, prompt/completion/cached tokens quando reportados e custo reportado.

Como timeout pode ocorrer após o provider aceitar o request, manter também possible billed attempts. Custo observado não deve ser apresentado como limite superior quando a resposta de usage não chegou.

### Suggested alerts

- Zero discoveries inesperado por source.
- Queda abrupta de normalization success ou aumento de unknown location/date.
- Página/cap atingido repetidamente.
- Divergência entre attempted e acknowledged no collector externo.
- Crescimento de pending/partial/failed states.
- Cache miss spike fora de rollout planejado.
- Requests por posting ou por requirement acima do budget.
- 429/5xx/auth error e circuit breaker aberto.
- Dedup rate fora da faixa histórica, especialmente aumento súbito de similar duplicates.
- Run overlap, lease expirado ou delivery parcial envelhecida.
- Custo diário/por run acima do limite operacional.

### Reconciliation jobs

- Candidates externos descobertos versus acknowledgements/persistência.
- Postings elegíveis versus scoring operations.
- Requirements extraídos versus matches persistidos.
- Scores concluídos versus ranking/delivery.
- Provider usage reportado versus ledger local, preservando a incerteza de attempts sem resposta.

## 16. Decisions That Should Be Preserved

As correções futuras não devem remover decisões positivas já identificadas na auditoria:

- O score final e a recommendation devem permanecer determinísticos; o LLM extrai/compara evidências, não escolhe o número final.
- Output do LLM continua sujeito a parsing e schema validation local.
- Stage B deve manter bounded concurrency; a correção de retries não deve voltar a concurrency ilimitada.
- Prompt/provider cache pode continuar sendo otimizado, desde que não seja confundido com correção semântica do cache local.
- Collection queries devem permanecer configuráveis e revisáveis, com defaults explícitos.
- Recency, unknown track cap, verifiable requirements e prefilter devem continuar como regras de domínio testáveis, não migrar para julgamento livre do modelo.
- O overlap guard local ainda é útil como defesa em profundidade, mesmo após coordenação persistente/global.
- ADRs históricos devem ser preservados e marcados como implemented, drifted ou superseded, em vez de reescritos como se decisões anteriores nunca existissem.

## 17. Decisions Required Before Implementation

Estas escolhas afetam schema ou comportamento e precisam de decisão explícita antes do respectivo pacote:

1. Qual é a definição operacional de update versus repost por source e qual horizonte temporal se aplica?
2. Quais sinais mínimos permitem auto-merge cross-source e qual faixa exige revisão?
3. Qual é a política para postings com localização desconhecida: quarantine, score cap ou admissão condicionada?
4. Qual budget máximo de requests/tokens/custo vale por posting, run e dia?
5. Stage B incompleta bloqueia sempre a publicação ou existe modo degradado sinalizado?
6. Por quanto tempo caches, attempts, raw payload metadata e dedup decisions devem ser retidos?
7. Quais capabilities cada processo externo realmente necessita e quem é owner de rotação/revogação?
8. Qual volume de catch-up é aceitável após outage antes de exigir aprovação manual?
9. Qual corpus rotulado e quais thresholds de erro autorizam ativar o novo similarity dedup?
10. Quais campos de conteúdo/profile podem ser armazenados para verificação de evidência respeitando privacidade e retenção?

## 18. Completion Checklist

- [ ] Cada AC-001 a AC-034 possui issue, owner, dependências e critério de aceite.
- [ ] Hotfixes AC-001/AC-002 foram validados antes de refactors amplos.
- [ ] Reason codes e run model existem antes de mudar regras que descartam vagas.
- [ ] Nenhum entry point pontua antes da barreira unificada de dedup.
- [ ] Novas identidades de cache foram implantadas por namespace, com cold-start budget.
- [ ] Concorrência foi testada com múltiplas conexões/processos.
- [ ] Ledger de OpenRouter registra todas as tentativas e distingue custo conhecido de possível.
- [ ] Prompt injection/evidence provenance fazem parte do corpus de regressão.
- [ ] Credenciais foram separadas por ator/capability e rotacionadas com plano operacional.
- [ ] Delivery parcial foi testada com crash/restart.
- [ ] Migrations foram validadas em snapshot representativo e possuem reconciliação.
- [ ] Shadow comparisons atingiram thresholds aprovados antes de enforcement.
- [ ] Dashboards/alerts/runbooks estão operacionais.
- [ ] Documentação foi reconciliada somente após o comportamento de produção estabilizar.
- [ ] Positive findings listados acima permanecem verdadeiros após as alterações.

Este plano não contém implementação. Ele transforma os findings da auditoria em unidades de decisão e entrega; cada recomendação deve ser refinada contra o código e os dados operacionais no momento da futura correção.
