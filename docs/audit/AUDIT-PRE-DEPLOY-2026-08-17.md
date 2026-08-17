# Auditoria pré-deploy — 2026-08-17

Auditoria do estado atual do repositório (`main` @ `12b4a3b`) antes do deploy
no Atlas. Nenhum arquivo do repositório foi alterado — build e testes rodados
localmente (Docker, npm) não tocam em nada versionado. Consultas ao banco de
produção do Atlas foram sempre `readonly: true`, nenhuma escrita.

**Resumo executivo:** dois dos quatro PRs pendentes de deploy (#65 Cloudflare
Tunnel, #66 Sólides, #68 B2/B3) estão prontos. **O terceiro (#67, Catho) tem
um problema real e não deve ir para produção como está** — achado abaixo.
Também encontrei, sem procurar, um `AUDIT_REPORT.md` que eu não gerei — ver
seção dedicada mais abaixo, com 3 bugs reais confirmados por conta própria a
partir dele.

---

## 🔴 CRÍTICO — O collector da Catho está bloqueado, 0% de sucesso confirmado

A ADR-032 (e o resumo que te dei) partiu de um teste manual via
`claude-in-chrome` (um Chrome real, completo, guiado por extensão) e concluiu
que "qualquer browser real e honesto" seria suficiente para passar do bloqueio
por User-Agent da Catho. **Isso está errado, e o teste real prova.**

Buildei a imagem `collectors/catho/` de verdade e rodei o `collect.ts` contra
o site real da Catho (12 candidatos no total, entre dois testes):

```
collecting 10 posting(s) this run
done: 0 collected, 10 expired/redirected, 0 errored (will retry next run)
```

**0 de 10 — não uma coincidência de vagas expiradas.** Investigando com um
script isolado (mesma imagem, mesmo `chromium.launch()` default que
`collect.ts` usa):

```
status: 403
title: 403 Forbidden
json-ld present: false
```

**A Catho bloqueia especificamente o modo headless do Playwright — não é o
mesmo bloqueio por string de User-Agent que descobrimos antes.** Testei a
hipótese óbvia (o flag `navigator.webdriver`, que fica `true` por padrão em
automação):

```js
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
```

Ainda **403**. O bloqueio é mais profundo que esse flag — provavelmente
fingerprinting de TLS/HTTP2, Canvas/WebGL, ou um serviço de detecção de bot
de verdade (Cloudflare Bot Management, Datadome, etc. são comuns em sites BR
grandes), não algo que um `addInitScript` resolve.

Tentei também `headless: false` sob Xvfb (a imagem `mcr.microsoft.com/playwright`
suporta isso) — o processo travou (>2min sem resposta, matei manualmente).
Pode ser limitação deste ambiente sandboxed (Docker aninhado, `/dev/shm`), não
necessariamente prova que headful funcionaria — **não cheguei a uma conclusão
aqui, só que não é uma solução simples e rápida**.

### Por que isso passou pelo teste manual anterior

`claude-in-chrome` guia um Chrome de desktop completo e real (perfil, GPU,
extensão, sem CDP da forma que o Playwright conecta). O `collect.ts` real usa
`chromium.launch()` puro do Playwright — tecnicamente "um browser real e
honesto" no sentido ético do CLAUDE.md §6, mas **na prática, um cliente
diferente do que foi testado manualmente**, e um que a Catho consegue
distinguir e bloquear.

### O que isso significa

- **Não faça deploy do collector da Catho como está.** Rodando hoje, ele
  gastaria ciclos de CPU/rede reais contra o site da Catho sem coletar nada —
  pior, o `seen-ids` state file marcaria todo candidato como "visto" mesmo
  sem nunca ter tido sucesso real algum (ver achado secundário abaixo), então
  o backlog "esvaziaria" sem nunca ter sido realmente coletado.
- **Achado secundário, bug real de observabilidade:** `collectOne` retorna
  `null` tanto para uma vaga genuinamente expirada (redirect) quanto para um
  403 de bloqueio — o loop principal conta os dois como "expired/redirected"
  sem distinguir. Um operador olhando os logs veria "vagas expirando", não
  "toda requisição está sendo bloqueada". Isso deveria ser corrigido antes de
  reativar esse coletor, independente da questão do bloqueio em si.
- **Decisão de valores, não só técnica:** driblar um bot-detection de
  verdade (stealth plugins, fingerprint spoofing) começa a se aproximar
  exatamente do tipo de evasão que o CLAUDE.md §6 evita ("nunca forjado para
  imitar um browser" — spoofar fingerprints de um browser real que você não
  é, é uma linha diferente de simplesmente usar um browser real). Vale
  considerar tratar a Catho como o Jooble (B4 em `docs/11`) — **parqueado**,
  não perseguido mais, em vez de entrar numa corrida armamentista contra o
  anti-bot deles.

**Recomendação:** não faça deploy do `collectors/catho/` ainda. As mudanças
de código no container principal (`catho-schema.ts`, `catho-normalizer.ts`,
registrado em `normalizer-registry.ts`) são inofensivas de deployar — elas só
processam o que chegar em `/runs/collect/external` com `source: "catho"`, e
nada vai mandar isso pra lá enquanto o `collect.ts` externo não rodar. O
problema é só ligar o coletor externo de verdade.

---

## ✅ Sólides — confirmado funcionando de ponta a ponta

Testei as 9 queries reais configuradas em `criteria.yaml` direto contra a API:

```
Rio de Janeiro - RJ | estágio     -> 153
Rio de Janeiro - RJ | estagiário  -> 121
Rio de Janeiro - RJ | estagiária  -> 4
Niterói - RJ        | estágio     -> 11
Niterói - RJ        | estagiário  -> 2
Niterói - RJ        | estagiária  -> 0
São Gonçalo - RJ     | estágio     -> 4
São Gonçalo - RJ     | estagiário  -> 5
São Gonçalo - RJ     | estagiária  -> 0
```

Todas as 9 queries respondem, volume real presente (300 resultados brutos
antes de dedup/pre-filter). API pública sem autenticação, sem bloqueio. **Sem
achados — pronto pra ir.**

---

## ✅ Imagem principal — build e boot limpos

`docker build .` (Dockerfile principal, sem cache) completou sem erro. Subi o
container com env vars falsas e `config/profile.example.yaml` montado:

- Boot limpo, sem crash-loop (a classe de bug que os próprios comentários do
  Dockerfile documentam — `config/taxonomy.yaml` e `prompts/` esquecidos no
  passado).
- **Migrações rodam automaticamente no boot** — `GET /health` respondeu
  corretamente logo após o start, sem precisar rodar `npm run db:migrate`
  manualmente antes. **Isso corrige o que eu disse na conversa anterior**:
  não é preciso um passo manual de migração — só subir o container novo já
  aplica a migração 0010 (as colunas do B2) no banco existente do Atlas.
- Todas as rotas mapeadas corretamente (`/health`, `/runs`, `/mcp`,
  `/market/study-plan`, `/postings/:fingerprint/discard`, etc.).

---

## Estado do deploy no Atlas

- Atlas está em `66be6c0` (PR #64), **4 commits atrás de `main`**: falta
  #65 (Cloudflare Tunnel — já aplicado manualmente na infra, fora do git),
  #66 (Sólides), #67 (Catho — **não subir ainda**, ver acima), #68 (B2/B3).
- `git status` no checkout do Atlas está limpo — `git pull` deve ser um
  fast-forward sem conflito.
- `.env` do Atlas tem todas as chaves que o código atual usa; nenhuma nova
  variável obrigatória foi introduzida por #65/#66/#68.
- 10 migrações já aplicadas no banco (`0000`–`0009`); a `0010` (B2) aplica
  sozinha no próximo boot, confirmado acima.
- `package.json` não ganhou nenhuma dependência nova entre `66be6c0` e
  `main` — só uma entrada de script (`fixture:solides`). Build do Docker não
  deve ter surpresas.

---

## Segurança

- **Nenhum segredo no histórico do git** — busquei por padrões de
  api_key/secret/password/token/bearer em todo arquivo versionado, e por
  arquivos sensíveis (`.env`, `profile.yaml`, `*.db`, `*-raw.json`) já
  adicionados em qualquer commit de qualquer branch. Nada encontrado — o
  `.gitignore` protegeu desde o primeiro commit, como o CLAUDE.md alega.
- `.gitignore` cobre corretamente o novo diretório `collectors/catho/data/`
  (estado do seen-ids) e `collectors/catho/.env` — o padrão `data/`/`.env`
  sem barra inicial casa em qualquer profundidade.
- `npm audit --omit=dev`: **0 vulnerabilidades** (o que roda em produção).
  `npm audit` completo mostra 4 moderadas via `drizzle-kit`/`esbuild`, mas
  são dev-only — o Dockerfile faz `npm prune --omit=dev`, confirmado que não
  entram na imagem de runtime.
- CI (`ci.yml`) fixa as actions por SHA (não por tag) — boa prática contra
  supply-chain attack via tag mutável.

---

## Observações menores (não bloqueiam o deploy)

1. **CI nunca builda a imagem Docker.** Só roda lint/format/typecheck/test
   via npm direto. Os dois bugs que os comentários do próprio Dockerfile
   documentam (`config/taxonomy.yaml` e `prompts/` faltando no `COPY`) só
   foram descobertos em produção, exatamente porque nada no CI teria pego.
   Um `docker build` no CI (mesmo sem subir o container) teria custo baixo e
   fecharia essa lacuna.
2. **`.dockerignore` não exclui `collectors/`** — o build da imagem
   principal manda `collectors/indeed/` e `collectors/catho/` inteiros no
   contexto de build, mesmo que o Dockerfile nunca faça `COPY` deles.
   Inofensivo (são poucos KB de texto), só desperdício.
3. **Sem ferramenta de coverage configurada** (`vitest.config.ts` não tem
   bloco `coverage`). Pode ser intencional (o projeto depende de disciplina
   de teste via `docs/07`, não de métrica), mas significa que uma regressão
   de cobertura não teria como ser pega automaticamente.
4. **`collectOne` (Catho) não distingue bloqueio de expiração real** — ver
   achado crítico acima. Vale corrigir isso independente de resolver o
   bloqueio em si, já que hoje um bloqueio total dos logs parece
   "engagement normal com vagas expirando".

---

## O que já foi revisto e resolvido antes desta auditoria

(Da conversa anterior, não repetido aqui em detalhe — ver `docs/11-known-issues.md`)

- B2 (runs sem motivo de falha) — corrigido, testado, no PR #68.
- B3 (Telegram sem pacing/429) — corrigido, testado, no PR #68.
- C1 (rows órfãs em produção) — já estava corrigido, só a doc estava
  desatualizada.
- A1/A3 (custo do backlog) — dado real coletado, mas não é a medição que
  as issues pedem (run analisado era majoritariamente cache hit).
- B1 (resto) — precisa de decisão de design (emenda à ADR-019), não tentado.

---

## ⚠️ Arquivo inesperado encontrado: `AUDIT_REPORT.md`

Durante esta auditoria encontrei `AUDIT_REPORT.md` na raiz do repositório —
**eu não criei esse arquivo**. Não sei sua origem (outra sessão do Claude
Code rodando em paralelo? uma skill de security-review disparada antes?).
Não apaguei nem alterei — só li o conteúdo, que é uma auditoria adversarial
separada, aparentemente gerada depois do commit `12b4a3b` (referencia esse
SHA e analisa `catho-normalizer.ts`/`solides-normalizer.ts`, então é recente,
apesar do timestamp do arquivo marcar "16 de agosto").

**O arquivo parece cortado.** Promete "34 findings" com tabela de severidade
(2 critical, 11 high, 16 medium, 5 low), mas termina na seção 6 sem nunca
listar os achados individualmente — só tem resumo executivo, metodologia,
arquitetura e o "mapa de perda de vaga". Se foi gerado por outra sessão, pode
ter sido interrompido antes de terminar.

**Verifiquei 3 das alegações do resumo executivo direto no código — as 3 são
reais:**

1. **`collectors/catho/collect.ts` salva o ID como "visto" antes de
   confirmar o ingest.** `saveSeenIds(...)` (linha 261) roda **antes** do
   `fetch(.../runs/collect/external)` (linha 275). Se o POST falhar (Atlas
   fora do ar, erro de rede, 500), aquele lote de vagas fica marcado como
   visto pra sempre, mesmo nunca tendo entrado no banco do argos-career.
   Perda silenciosa e permanente. Independente do bloqueio por anti-bot já
   documentado acima, esse é outro motivo pra não ligar esse coletor ainda.

2. **Todo collector interno descarta as páginas já coletadas se uma página
   posterior falhar.** Confirmado em `gupy-collector.ts` (linhas 127-136):
   se a página 3 de 5 falhar, o `return` é com `postings: []` — as páginas 1
   e 2, já buscadas com sucesso, são jogadas fora, não devolvidas
   parcialmente. `SolidesCollector` replica exatamente esse padrão (eu
   modelei em cima do Gupy de propósito). Não é bug que introduzi agora — já
   existe desde o M3 — mas é real e vale corrigir.

3. **`POST /runs/collect` (REST/MCP) ignora a fonte declarada em cada query
   e sempre usa o Gupy.** Confirmado: `runs.service.ts` linha 132,
   `() => this.collector` — o resolver ignora o argumento `source` e sempre
   devolve a mesma instância injetada, que `collector.provider.ts` define
   como `new GupyCollector()` fixo. **Importante contextualizar**: o
   `SchedulerService` (o cron real que roda a cada 4h em produção) usa
   `collectorFor` corretamente — esse bug é só no endpoint HTTP/MCP manual
   (`POST /runs/collect`, usado por Hermes ou testes manuais), não afeta o
   ciclo automático. Ainda assim, real: se alguém chamar esse endpoint sem
   corpo (rodar o ciclo configurado inteiro), toda query de CIEE/Sólides
   seria silenciosamente mandada pro Gupy.

Dado que 3 de 3 verificações bateram, tendo a confiar no resto do conteúdo
visível do arquivo, mas **não verifiquei os outros pontos do resumo**
(cache keys de Stage A/B, "evidência literal" só existir no prompt, ordem
ingest-externo-antes-de-similarity-dedup, etc.) — trate como pista forte,
não como fato confirmado, até serem checados um a um.

**Isso não bloqueia o deploy de #65/#66/#68** — os 3 bugs verificados acima
são: (1) só relevante quando o coletor da Catho for ligado, que já está
pausado por outro motivo; (2) pré-existente desde o M3, já vive em produção
hoje sem ter sido notado — não é regressão desta leva de mudanças; (3) só
afeta o endpoint manual, não o cron. Nenhum dos três piora com o deploy
proposto. Mas merecem virar itens no `docs/11-known-issues.md` antes de
serem esquecidos.

---

## Recomendação para o deploy

1. **Deploy #65/#66/#68 no Atlas normalmente** — `git pull` + rebuild +
   restart. Sem passo manual de migração necessário (confirmado acima).
2. **Não builde nem agende o `collectors/catho/` ainda.** Decida primeiro:
   investigar contorno do bloqueio (stealth/fingerprint — questão de
   valores, ver acima), tentar headful com mais tempo/recursos, ou parquear
   a Catho como o Jooble.
3. Depois do deploy, confirmar: `GET /health` real, uma rodada real de
   `collect` pra ver o Sólides trazendo vagas de verdade, e checar
   `docker stats` pro consumo de memória (prática já estabelecida no
   projeto).
