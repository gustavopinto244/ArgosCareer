# Diagnóstico do incidente de scoring — 2026-08-18

## Resumo executivo

O alerta abaixo detectou impacto real no produto, mas atribuiu uma causa mais
específica do que os dados permitem:

> Scoring failure rate 67% on run 01M09Q92RQQF91PDS6YVD1FB4J (2/3 failed) —
> possible model or prompt regression.

O run terminou e entregou o digest, mas somente uma das três vagas que passaram
pelo prefilter recebeu um score real. As outras duas falharam ainda no Stage A,
depois de quatro tentativas cada, e chegaram ao digest como entradas de revisão
sem pontuação automática.

O diagnóstico deste documento é:

- **o alerta encontrou uma degradação real;**
- **não há evidência de regressão de prompt;** `a-v4` e `b-v4` permaneceram
  iguais entre os runs comparados;
- o modelo configurado também permaneceu
  `deepseek/deepseek-v4-flash-0731`;
- a evidência aponta primeiro para o par cliente/provedor: timeout fixo de 30 s,
  respostas HTTP 200 sem o shape esperado e routing entre provedores não
  observado;
- o problema já havia ocorrido antes e voltou a acontecer. A checagem planejada
  em [`docs/11-known-issues.md` B6](../11-known-issues.md)
  confirmou que não se tratava apenas de ruído de um run;
- a versão atualmente implantada melhorou o diagnóstico ao registrar o corpo
  truncado de respostas inválidas, mas não alterou timeout, parsing, routing ou
  a política de alertas. Portanto, **a causa subjacente continua aberta**.

Não é recomendável trocar prompt e modelo agora. Fazer isso antes de corrigir a
classificação de erros e observar o provedor efetivo mudaria várias variáveis ao
mesmo tempo e tornaria a próxima medição inconclusiva.

---

## Escopo e metodologia

Este diagnóstico usou:

1. o código do repositório em `main`;
2. o registro persistido do run em `runs`;
3. os eventos por vaga em `posting_events`;
4. o estado de cache e retry das três vagas envolvidas;
5. o histórico dos runs de scoring anteriores;
6. o reflog e o estado do container no Atlas para correlacionar código e run;
7. o contrato oficial atual do OpenRouter para erros, respostas sem conteúdo e
   routing de providers.

Todas as consultas ao SQLite de produção foram abertas com `readonly: true`.
Nenhuma chamada ao modelo foi feita durante o diagnóstico, nenhuma vaga foi
reprocessada, nenhum digest foi reenviado e nenhum dado de produção foi
alterado.

Também não foi possível recuperar o corpo bruto das respostas deste run. Ele
aconteceu antes do patch que passou a registrar esses corpos e o container que o
executou foi posteriormente recriado. Essa limitação é relevante: parte da causa
abaixo é classificada como provável, e não confirmada, justamente porque a
evidência de wire format não existe mais.

---

## Cronologia e versão efetiva

| Instante | Evento |
| --- | --- |
| 2026-08-18 03:00:00 BRT | Início do run `01M09Q92RQQF91PDS6YVD1FB4J` |
| 2026-08-18 03:06:49 BRT | Fim do run, com `outcome=success` e digest entregue |
| Durante o run | Código implantado em `58a78e7` |
| 2026-08-18, depois do run | `25ddecc` adicionou logging truncado para `invalidOutput`/`invalidEnvelope` |
| Estado verificado ao fim do diagnóstico | Checkout e runtime em `e53791a` |

O `outcome=success` significa que a operação de delivery terminou e que o
Telegram confirmou os chunks. Não significa que todas as vagas foram pontuadas:
por desenho, uma falha recuperável de scoring entra no digest como revisão, mas
não incrementa `scoredCount` e não marca a vaga como notificada.

O run investigado já usava o prefilter de `58a78e7`, que reduziu o conjunto para
três vagas relevantes. Os commits posteriores presentes no runtime atual
adicionaram diagnóstico e mais uma expressão de track; eles não mudaram a
integração de scoring que falhou.

---

## Evidência do run

### Resultado de produto

| Campo persistido | Valor |
| --- | ---: |
| `filtered_count` | 3 |
| `scored_count` | 1 |
| Falhas finais de scoring | 2 |
| Taxa mostrada no alerta | 66,7% |
| `delivered_count` | 3 |
| Duração | 6 min 49,289 s |
| `outcome` | `success` |

As três entradas foram entregues porque as duas falhas também são mostradas no
digest. Isso preserva visibilidade para o usuário, mas `delivered_count=3` não
deve ser lido como três avaliações concluídas.

### Resultado das chamadas ao OpenRouter

| Resultado registrado pelo cliente | Tentativas | Percentual |
| --- | ---: | ---: |
| `success` | 9 | 39,1% |
| `invalidOutput` | 10 | 43,5% |
| `timeout` | 4 | 17,4% |
| Demais categorias | 0 | 0% |
| **Total** | **23** | **100%** |

No vocabulário de `OpenRouterClient`, `success` significa que a resposta passou
pelo schema de transporte e continha `choices[0].message.content`. Ainda não
significa que o conteúdo era JSON válido nem que passou pelo schema do Stage A
ou Stage B; essas validações acontecem uma camada acima.

Consequentemente:

- a taxa de falha por tentativa de rede foi **60,9%**, diferente dos 66,7% do
  alerta, que é uma taxa por vaga;
- `llm_attempts_without_usage=4`, exatamente o número de timeouts. Portanto,
  todas as dez respostas classificadas como `invalidOutput` carregaram `usage`;
- houve 28.872 prompt tokens, 29.099 completion tokens e 14.232 cached prompt
  tokens;
- o custo provider-reported foi **US$ 0,009689415**;
- não houve `rateLimited`, erro de autenticação/configuração, HTTP 4xx/5xx
  classificado ou bloqueio de circuit breaker neste run.

O último ponto não exclui erro do provider: um erro carregado dentro de um HTTP
200 pode cair hoje em `invalidOutput`, antes que sua causa seja interpretada.

### Resultado por vaga

| Vaga | Description | Resultado | Tentativas/estado |
| --- | ---: | --- | --- |
| Estagiário de Tecnologia da Informação | 2.423 chars | `extraction_failed` | 4 tentativas; segunda falha consecutiva |
| Estagiário de Pesquisa & Desenvolvimento | 3.467 chars | `extraction_failed` | 4 tentativas; segunda falha consecutiva |
| Estágio em TI \| Originação de Crédito | 2.404 chars | `review` com score real | Stage A e B cache miss; 6 requirements extraídos |

Os três inputs estão muito abaixo do limite de 12.000 caracteres do Stage A.
Não há sinal de truncamento ou descrição excepcionalmente grande.

A terceira vaga exigia sete resultados lógicos válidos — uma extração e seis
matches — mas o run consumiu quinze tentativas depois de descontadas as oito
tentativas registradas nas duas falhas. Mesmo a vaga que terminou com score
precisou de oito tentativas adicionais em relação ao caminho limpo. A degradação
não ficou confinada às duas vagas que falharam no final.

As duas vagas com falha permanecem `notified_at=null` e estão com
`score_failure_count=2`. Elas ainda têm três tentativas automáticas em runs
futuros antes de chegarem ao teto de cinco falhas consecutivas. No run seguinte
ao atingimento do teto, deixam de chamar o modelo e entram como
`max_retries_exceeded`, exigindo decisão manual.

Uma das vagas possui uma extração antiga de `a-v3`, anterior à identidade de
cache atual. Ela não é reutilizável por `a-v4`; as duas tentativas recentes de
produzir a extração atual falharam. A outra vaga ainda não possui extração.

---

## Comparação com os runs anteriores

### Run documentado em B6

O run `01M09542FFR83M5V8HPSAQ68F3`, registrado em
[`docs/11-known-issues.md`](../11-known-issues.md), apresentou:

| Métrica | Valor |
| --- | ---: |
| Vagas após prefilter | 28 |
| Vagas pontuadas | 5 |
| Tentativas | 125 |
| `success` de transporte | 37 — 29,6% |
| `timeout` | 31 — 24,8% |
| `invalidOutput` | 57 — 45,6% |
| Falha por tentativa | 70,4% |

No run atual, a taxa de falha por tentativa caiu de 70,4% para 60,9%, mas
`invalidOutput` permaneceu praticamente igual: 45,6% antes e 43,5% agora. A
amostra atual é menor, então essa melhora não deve ser tratada como estabilização.

### Run anterior das mesmas vagas

As duas vagas que falharam no run atual também haviam falhado com
`extraction_failed`, quatro tentativas cada, no run de produção
`01M09011C3F3AGZ98EGVWRQ9XB`. Em ambos os casos:

- modelo: `deepseek/deepseek-v4-flash-0731`;
- Stage A: `a-v4`;
- Stage B: `b-v4`;
- `profileHash`: igual;
- falha: Stage A, antes de qualquer matching.

Somente o `criteriaHash` mudou, devido ao prefilter. O criteria decide quais
vagas chegam ao scorer, mas não altera o prompt que o Stage A monta para uma
vaga já admitida.

Esse run anterior também expõe uma deficiência do alerta atual: foram 77 vagas
filtradas e somente 40 pontuadas, uma taxa de falha final de 48,1%, pouco abaixo
do threshold de 50%. Por isso não houve alerta de taxa, apesar de terem ocorrido
146 falhas em 296 tentativas de rede, além de 48 recusas pelo circuit breaker.

---

## Achados

### F1 — Regressão de prompt não é sustentada pela evidência

**Confiança:** confirmada.

Os prompts permaneceram em `a-v4` e `b-v4` entre as falhas comparadas. O modelo
configurado e o profile hash também permaneceram iguais. Não houve mudança de
prompt a correlacionar temporalmente com o incidente.

Isso não prova que o prompt seja perfeito nem exclui um caso de conteúdo que
faça o modelo responder mal. Prova apenas que **regressão** é uma conclusão
incorreta: não existiu alteração de prompt entre os dois pontos observados.

### F2 — O timeout de 30 s é incompatível com o próprio histórico do Stage A

**Confiança:** confirmada para os quatro timeouts; contribuição exata para as
dez respostas inválidas ainda desconhecida.

`OpenRouterClient` aplica um timeout fixo de 30.000 ms ao mesmo cliente usado
por Stage A e Stage B. O projeto já havia medido ou estimado Stage A em cerca de
40–67 s para extrações frias. Stage A gera uma lista inteira de requirements;
Stage B gera um objeto curto para um único requirement. Os dois trabalhos têm
perfis de latência diferentes, mas compartilham o mesmo teto.

Quatro tentativas deste run terminaram exatamente na categoria `timeout`. Mesmo
que o provider estivesse apenas lento, e não indisponível, o cliente converteu
essa lentidão em falha e repetiu a chamada.

### F3 — HTTP 200 com erro provider-side é classificado como `invalidOutput`

**Confiança:** provável; falta o corpo bruto do run para confirmação individual.

O schema atual exige:

```text
choices[0].message.content: string
```

Depois de capturar `usage`, qualquer HTTP 200 sem esse primeiro choice válido é
classificado como `invalidOutput` e repetido como falha transitória.

O contrato oficial do OpenRouter documenta que um erro ocorrido depois que o
modelo começou a processar pode ser devolvido em HTTP 200, com um objeto `error`
no corpo ou associado ao choice. Também documenta respostas sem conteúdo durante
warm-up ou scaling. A causa estável nesses casos é
`error.metadata.error_type`.

O cliente atual não modela nem interpreta esse campo no caminho de HTTP 200.
Assim, `provider_unavailable`, `provider_overloaded`, timeout upstream, filtro de
conteúdo e uma resposta genuinamente sem choices podem virar a mesma categoria
local: `invalidOutput`.

O fato de as dez respostas terem `usage` confirma que elas eram corpos JSON
reconhecíveis o suficiente para accounting; não confirma qual dos shapes acima
cada uma possuía.

### F4 — O modelo está fixo; o provider efetivo, não

**Confiança:** confirmada no código; impacto específico neste run ainda não
medido.

A requisição envia `model`, `messages` e `max_tokens`, mas não envia restrição de
provider, ordem de preferência ou metadados de routing. Segundo a documentação do
OpenRouter, o comportamento padrão distribui chamadas entre os melhores
providers disponíveis para o modelo, com fallback.

Portanto, fixar `deepseek/deepseek-v4-flash-0731` mantém a família/revisão do
modelo, mas não garante que todas as tentativas usem a mesma infraestrutura de
inferência. Latência, suporte a parâmetros e estabilidade podem variar entre
providers.

O runtime também descarta `provider`, `model` efetivo, `finish_reason`, id da
generation e detalhes de routing. Hoje não é possível agrupar as falhas por
provider depois do run.

### F5 — A taxonomia persistida perde a causa antes de chegar ao operador

**Confiança:** confirmada.

Há três níveis diferentes de resultado:

1. transporte OpenRouter: `timeout`, `invalidOutput`, `providerError`, etc.;
2. parsing Stage A/B: `invalid_output`, `transport_failed`,
   `permanent_error`;
3. evento por vaga: `extraction_failed` ou `matching_failed`.

`posting_events` persiste somente o terceiro nível e o número total de
tentativas. `runs.llm_outcome_counts` persiste somente o agregado do primeiro.
Não existe uma relação persistida entre uma tentativa, sua vaga, seu estágio e
sua causa interna.

Os logs carregam `operationLabel`, mas são stdout humano, não estruturado e não
durável. A recriação do container após este run removeu exatamente a evidência
necessária para fazer a correlação.

### F6 — O alerta mede impacto, não regressão

**Confiança:** confirmada.

O alerta calcula:

```text
(filteredCount - scoredCount) / filteredCount
```

Essa conta é útil para responder “quantas vagas ficaram sem score?”, mas não
responde “o modelo ou o prompt regrediu?”. Para a segunda pergunta faltam:

- comparação com baseline;
- identidade de prompt/model/provider;
- volume mínimo de amostra;
- runs consecutivos;
- distribuição das categorias de erro;
- separação por Stage A e Stage B.

Com somente três vagas, os únicos valores possíveis próximos ao incidente são
0%, 33%, 67% e 100%. A taxa é matematicamente correta, mas estatisticamente
instável.

Além disso, `filteredCount - scoredCount` pode incluir:

- `max_retries_exceeded`, quando nenhuma chamada ao modelo acontece;
- vagas não alcançadas depois de uma falha permanente que interrompe o batch;
- falhas de template ou infraestrutura local;
- extração e matching, sem distinção.

Nesses casos, o texto “possible model or prompt regression” pode atribuir a
causa errada mesmo quando o numerador está correto.

### F7 — O fallback preserva as vagas, mas repete custo e ruído

**Confiança:** confirmada.

A política de falha recuperável funciona como projetada:

- a falha aparece no digest, em vez de desaparecer silenciosamente;
- a vaga não é marcada como notificada;
- o claim é liberado;
- a vaga volta no run seguinte;
- depois de cinco falhas consecutivas, o retry automático cessa.

Isso protege contra perda definitiva, mas duas falhas repetidas de Stage A já
consumiram custo em duas noites e produziram duas entradas sem score para as
mesmas vagas. Sem corrigir a causa, o sistema continuará fazendo isso por mais
três runs antes de pedir intervenção manual.

---

## Avaliação de causa

| Hipótese | Avaliação | Evidência |
| --- | --- | --- |
| Regressão de prompt | Não sustentada | `a-v4`/`b-v4` iguais nos runs comparados |
| Mudança de modelo configurado | Não sustentada | Mesmo slug nos dois runs |
| Timeout local curto | Confirmada como parte do incidente | 4 timeouts; teto fixo de 30 s |
| Erro provider-side dentro de HTTP 200 | Provável | 10 `invalidOutput` com usage; contrato OpenRouter permite erro in-band |
| Instabilidade de um provider específico | Possível | Provider efetivo não é persistido |
| Variação causada pelo routing | Possível e não observada | Provider não é fixado nem registrado |
| Input grande/truncado | Não sustentada | 2.404–3.467 chars, abaixo de 12.000 |
| Conteúdo específico das duas vagas | Possível | As mesmas vagas falharam duas vezes; falta resposta bruta |
| JSON/schema ruim produzido pelo modelo | Possível | `success` de transporte não implica sucesso do parser; causa não persistida por operação |

O diagnóstico mais responsável é **falha recorrente do pareamento
modelo/cliente/provider**, com dois defeitos locais já demonstrados — timeout e
classificação insuficiente — e sem evidência suficiente para atribuir a falha ao
prompt ou ao modelo isoladamente.

---

## Impacto

### Para o usuário

- duas oportunidades relevantes não foram ranqueadas;
- o digest chegou, mas 2/3 das entradas exigem leitura manual sem score;
- as mesmas duas entradas podem reaparecer nos próximos runs;
- o alerta parece mais conclusivo do que a observabilidade disponível.

### Para custo e capacidade

- 23 tentativas foram feitas para concluir uma única vaga;
- as dez respostas `invalidOutput` tiveram usage;
- repetir o run sem mudança de diagnóstico pode pagar novamente pelas mesmas
  falhas;
- reduzir o prefilter de 28 para 3 vagas reduziu o gasto absoluto, mas não
  melhorou a saúde do scorer.

### Para a confiabilidade do ranking

O score determinístico em Stage C não é o problema deste incidente. Ele nunca
foi alcançado por duas vagas. A lista entregue é incompleta antes da ordenação,
portanto qualquer avaliação da qualidade do ranking feita sobre esse digest
estaria contaminada por falha de extração.

---

## Recomendações priorizadas

### P0 — Interpretar o contrato de erro HTTP 200 do OpenRouter

Antes de exigir `choices[0].message.content`, o cliente deve reconhecer:

- `error` no topo da resposta;
- erro associado ao choice;
- `error.metadata.error_type`;
- `finish_reason=error`;
- resposta sem conteúdo;
- resposta genuinamente desconhecida.

Esses casos devem alimentar categorias próprias. `invalidOutput` deve ficar
reservado para um shape realmente desconhecido, não para todos os erros in-band.

Persistir, de forma sanitizada:

- run id;
- fingerprint;
- estágio;
- número da tentativa;
- latência;
- status HTTP;
- `error_type`;
- provider;
- modelo efetivo;
- `finish_reason`;
- presença/ausência de usage e custo.

Não persistir prompt, descrição, evidence quote, conteúdo integral da resposta
ou detalhes pessoais do perfil.

### P0 — Separar timeout de Stage A e Stage B

O timeout deve ser uma propriedade da operação, não apenas do cliente
compartilhado. Um ponto inicial para medição, não um valor final já calibrado:

- Stage A: 90–120 s;
- Stage B: manter um teto menor, medido separadamente.

O valor definitivo deve vir do P95 observado por estágio e provider, com
headroom explícito. A alteração precisa ser testada contra limite de duração e
custo do batch para não transformar um timeout curto em espera ilimitada.

Também vale separar `max_tokens`: Stage A precisa de uma lista; Stage B precisa
de um objeto curto. O mesmo teto de 2.048 tokens para ambos enfraquece o controle
de latência sem trazer benefício ao Stage B.

### P1 — Observar routing antes de fixar provider

Habilitar routing metadata e persistir o provider escolhido por tentativa.
Depois de volume suficiente:

1. comparar taxa de sucesso, timeout, latência e custo por provider;
2. escolher uma ordem de preferência;
3. manter fallback para indisponibilidade, se os dados mostrarem benefício;
4. ou fixar um provider, se reprodutibilidade superar a perda de resiliência.

Fixar um provider imediatamente, sem saber qual produziu as falhas, apenas troca
uma variável não observada por uma decisão não medida.

### P1 — Separar alerta de impacto e alerta de regressão

Manter dois sinais:

#### Impacto no digest

Disparar quando houver qualquer vaga sem score e dizer exatamente:

```text
2/3 vagas ficaram sem score: 2 extraction_failed, 0 matching_failed.
```

Esse alerta pode operar mesmo com amostra pequena, porque duas vagas sem score
são impacto real para o usuário.

#### Saúde/regressão do scorer

Disparar somente com contexto suficiente, por exemplo:

- mínimo de tentativas ou janela móvel;
- comparação com baseline;
- dois ou mais runs degradados consecutivos;
- breakdown de timeout, provider error, schema/JSON e circuit breaker;
- prompt, modelo e providers envolvidos.

O texto deve usar “regressão” somente quando existir uma comparação de versão ou
baseline que sustente a palavra.

### P1 — Persistir a causa por operação

`ExtractionResult` e `MatchingResult` hoje reduzem causas internas para
`extraction_failed`/`matching_failed`. Preservar uma causa operacional separada,
sem expor conteúdo:

```text
stage-a / transport_failed / timeout
stage-a / provider_error / provider_unavailable
stage-a / output_invalid_json
stage-a / output_schema_rejected
stage-b / evidence_rejected
```

Isso permite correlacionar `runs` e `posting_events` sem depender de logs
efêmeros.

### P2 — Avaliar structured output depois de estabilizar o transporte

O request atual instrui JSON apenas no prompt. Depois dos itens P0, medir suporte
a `response_format`/structured output para o modelo e providers candidatos. Se
for adotado, usar a opção de routing que exige suporte ao parâmetro, evitando que
um provider ignore silenciosamente a restrição.

Essa mudança trata JSON/schema inválido. Ela não resolve timeout nem erro
provider-side dentro de HTTP 200 e, por isso, não deve ser a primeira correção.

### P2 — Remover o corpo bruto como solução permanente de observabilidade

O patch atual de debug é útil para a próxima reprodução, mas o corpo pode conter
saída parcial, reasoning ou texto derivado do perfil. Isso conflita
potencialmente com a regra de não colocar dados pessoais em logs.

Depois que os shapes reais forem identificados e cobertos por testes, substituir
o logging do corpo por campos sanitizados. Se for necessário manter uma amostra
temporária, limitar retenção, acesso e tamanho explicitamente.

---

## Critérios de confirmação da correção

Uma correção futura não deve ser considerada validada apenas porque um run com
uma ou duas vagas passou. O mínimo para fechar este incidente é:

1. nenhum erro OpenRouter conhecido dentro de HTTP 200 cair em
   `invalidOutput` genérico;
2. toda falha de Stage A/B ser atribuível a uma categoria persistida, estágio e
   provider, sem conteúdo pessoal;
3. timeout medido separadamente por estágio;
4. pelo menos um run de cache frio suficiente para medir Stage A;
5. comparação antes/depois com tentativas, sucesso lógico, timeout,
   JSON/schema inválido, latência e custo;
6. alerta de impacto testado com amostra pequena;
7. alerta de regressão testado contra baseline e runs consecutivos;
8. as duas vagas deste incidente conseguirem extrair ou produzirem uma causa
   específica e acionável diferente de `extraction_failed`.

Não é necessário exigir taxa perfeita. É necessário que cada falha seja
explicável e que o timeout não rejeite sistematicamente uma operação dentro da
latência normal do modelo.

---

## Runbook para a próxima ocorrência

A versão atual já contém logging truncado do corpo para `invalidOutput` e
`invalidEnvelope`. Até a observabilidade estruturada ser implementada:

1. não recriar o container antes de capturar os logs do intervalo do run;
2. localizar as linhas de `OpenRouterClient` e `LlmOutput` pelos fingerprints;
3. registrar somente shape, provider, `error_type`, `finish_reason`, latência e
   presença de usage — não copiar prompt, response content ou profile evidence
   para o repositório;
4. comparar `llm_outcome_counts` com os números deste documento;
5. confirmar se os `invalidOutput` são erro in-band, choices vazios, content
   nulo ou outro shape;
6. só então escolher timeout, provider routing ou mudança de modelo.

Executar `deliver` manualmente apenas para diagnóstico reenviaria entradas ao
Telegram, gastaria novamente e alteraria `score_failure_count`. O próximo run
agendado é uma reprodução mais segura enquanto ainda restam retries automáticos.

---

## O que não mudar ainda

- Não alterar `a-v4` e `b-v4` com base neste incidente.
- Não trocar o modelo e o prompt simultaneamente.
- Não reduzir o número de retries antes de classificar as respostas 200.
- Não elevar o timeout global sem separar Stage A de Stage B e medir o impacto
  no batch.
- Não considerar o problema resolvido apenas porque o novo prefilter reduziu o
  número absoluto de chamadas.
- Não usar `delivered_count` como proxy de vagas efetivamente pontuadas.

---

## Referências

### Repositório

- [`src/scoring/infrastructure/openrouter-client.ts`](../../src/scoring/infrastructure/openrouter-client.ts)
- [`src/scoring/infrastructure/llm-output.ts`](../../src/scoring/infrastructure/llm-output.ts)
- [`src/scoring/infrastructure/stage-a-extractor.ts`](../../src/scoring/infrastructure/stage-a-extractor.ts)
- [`src/scoring/infrastructure/stage-b-matcher.ts`](../../src/scoring/infrastructure/stage-b-matcher.ts)
- [`src/scoring/infrastructure/prompts.ts`](../../src/scoring/infrastructure/prompts.ts)
- [`src/scheduling/domain/alerts.ts`](../../src/scheduling/domain/alerts.ts)
- [`src/cli/main.ts`](../../src/cli/main.ts)
- [`docs/08-observability.md`](../08-observability.md)
- [`docs/11-known-issues.md`](../11-known-issues.md)
- [`ADR-035`](../adr/035-llm-retry-taxonomy-backoff-and-circuit-breaker.md)
- [`ADR-038`](../adr/038-recoverable-scoring-failures-bounded-retry.md)
- [`ADR-039`](../adr/039-batch-fatal-permanent-errors-and-breaker-scope.md)
- [`ADR-049`](../adr/049-bound-trace-and-resume-model-work.md)

### OpenRouter

- [Errors and Debugging](https://openrouter.ai/docs/api/reference/errors-and-debugging)
- [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Router Metadata](https://openrouter.ai/docs/guides/features/router-metadata)
- [DeepSeek V4 Flash 0731](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)

---

## Status

**Resolvido, confirmado em produção (2026-08-18, mesma sessão).**

A implementação inicial (ADR-052) interpretou erros in-band do OpenRouter,
separou os limites de Stage A/B, habilitou routing metadata e persistiu causa
operacional sanitizada — mas a validação pós-deploy (run
`01M0AJ0CY37MD7XAWX5XZEQNR0`) mostrou que a causa real ainda não tinha sido
encontrada: o timeout de 30s de fato era curto (corrigido, 0 timeouts no
Stage A após subir para 120s), mas o impacto no digest não mudou — a falha só
trocou de forma, virando `finishReason: "length"` uniforme em 8 providers.

A causa raiz real: chamadas isoladas, sem retry, contra as duas vagas que
falhavam em todo run mostraram um campo `reasoning` de 70.000+ caracteres em
100% das tentativas, consumindo o teto de tokens inteiro antes do modelo
escrever a resposta — reproduzido com e sem emoji, então não era o Unicode.
`deepseek/deepseek-v4-flash-0731` é um modelo de raciocínio, e nada limitava
seu budget de "pensamento" separadamente do budget de resposta. Subir o teto
geral (Amendment 1) só deu mais espaço pro mesmo comportamento.

**Correção (Amendment 2):** `reasoning.max_tokens` (controle documentado da
OpenRouter) limita Stage A a 3.000 e Stage B a 300, reservando a maior parte
de cada budget pra resposta. Confirmado duas vezes: uma chamada isolada pras
duas vagas problemáticas retornou `finish_reason: "stop"` com JSON válido, e
o run de produção final (`01M0AZQ7Q83008FXK00AQKK36X`) pontuou **4 de 4**
vagas filtradas — `scoreFailureCounts: {}` — incluindo as duas que travavam
desde o início do incidente.

Detalhe completo em [ADR-052](../adr/052-classify-openrouter-in-band-errors-and-separate-scoring-signals.md)
e sua Amendment 2.
