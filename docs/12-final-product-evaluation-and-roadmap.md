# 12 — Avaliação final do produto e roadmap

## Veredito

O ArgosCareer está em um estágio de **beta operacional avançado para uso
pessoal**.

Ele já é útil e bem construído como:

- radar automatizado de vagas;
- redutor de ruído;
- memória contra vagas repetidas;
- shortlist diária explicável;
- plataforma de experimentação sobre compatibilidade profissional.

Ainda não está validado como:

- recomendador autônomo;
- fonte abrangente do mercado;
- classificador confiável o suficiente para descartar oportunidades sem
  supervisão;
- sistema maduro de inteligência de carreira.

Em termos práticos: o aplicativo já pode ser utilizado diariamente para
encontrar e priorizar vagas, mas ainda não deve decidir sozinho quais vagas
ignorar ou em quais se candidatar.

Esta avaliação foi concluída em 2026-08-17, sobre o commit `58a78e7`, após as
remediações documentadas nos ADRs 036–051.

## Estado atual

| Dimensão                   | Avaliação                 | Motivo principal                                                                                                 |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Arquitetura e código       | Forte                     | Separação clara, decisões documentadas, scoring determinístico e ampla cobertura automatizada                    |
| Coleta                     | Moderada                  | Diversas fontes, mas cobertura real desigual e problemas de recência                                             |
| Redução de ruído           | Forte                     | O corpus medido caiu de 4.219 itens brutos para apenas 3 candidatos aparentemente pertinentes após o novo filtro |
| Qualidade do ranking       | Preliminar                | Apenas 16 vagas rotuladas; recall de `apply` ainda foi 0% na avaliação completa                                  |
| Confiabilidade operacional | Boa, ainda em validação   | Recovery, cache, checkpoints e rate limits são sólidos; faltam medições pós-remediação                           |
| Experiência do usuário     | Limitada                  | Telegram é eficiente, mas a operação e correção de decisões dependem muito de CLI/API                            |
| Inteligência de mercado    | Experimental              | Poucas vagas possuem extração completa e o corpus é temporalmente enviesado                                      |
| Segurança                  | Boa para o escopo pessoal | Credenciais por capacidade, limites e fronteira privada; não é uma plataforma multiusuário                       |
| Valor como portfólio       | Muito forte               | Demonstra arquitetura, domínio, LLM controlado, observabilidade, segurança e disciplina de engenharia            |

## O que já entrega valor real

O maior valor do aplicativo está antes do score: coleta, normalização,
histórico, deduplicação e prefilter.

A execução documentada que recebeu 4.219 itens brutos, persistiu 2.126 novos e
terminou com apenas 3 candidatos genuinamente relacionados a desenvolvimento
demonstra que o sistema consegue eliminar uma quantidade enorme de trabalho
manual. Isso ataca diretamente o problema descrito no README: o gargalo é
encontrar e triar vagas, não preencher candidaturas.

Também devem ser preservadas estas decisões:

- O LLM extrai e compara evidências, mas não produz diretamente o score.
- Evidências precisam existir no perfil e são verificadas novamente após
  cache.
- Duplicação por similaridade permanece em shadow mode, evitando exclusão
  destrutiva.
- Stage B possui concorrência limitada e checkpoints por requisito.
- Resultados parciais podem ser retomados sem repetir todas as chamadas pagas.
- Entrega pelo Telegram possui checkpoints e reconciliação explícita para
  resultados ambíguos.
- Credenciais possuem capacidades diferentes para administrador, automação e
  collectors externos.
- Custos, tentativas sem usage, falhas, cache hits e degradações são
  persistidos.
- O projeto mantém limites honestos e não se apresenta como simulador de ATS.

### Validação automatizada observada

Na avaliação final do commit citado:

- 1.092 testes principais passaram;
- 58 testes do collector Catho passaram;
- build, typecheck, lint e verificação de formatação passaram;
- o working tree permaneceu limpo após os diagnósticos.

Esses resultados sustentam a avaliação da engenharia do repositório, mas não
substituem medições reais de eficácia, latência e confiabilidade em produção.

## Principais limitações de utilidade

### 1. O ranking ainda não está suficientemente calibrado

A medição completa usa somente 16 vagas. Ela alcançou correlação 0,522, mas
teve recall de `apply` igual a 0%. A correlação 0,835 veio apenas de um
subconjunto de cinco vagas e não substitui uma nova avaliação completa.

Portanto, o score é atualmente um **sinal de triagem**, não uma probabilidade
confiável de sucesso.

### 2. A integração real com o OpenRouter ainda é o maior risco operacional

Na execução registrada em `docs/11-known-issues.md`, apenas 37 de 125
tentativas tiveram sucesso; 31 expiraram e 57 retornaram formato inválido.
Somente 5 de 28 vagas foram completamente pontuadas.

As remediações reduziram repetição, custo e número de vagas enviadas ao
modelo, mas ainda falta comprovar que o par modelo/cliente voltou a operar de
maneira estável.

### 3. A cobertura das fontes é desigual

- Gupy e CIEE possuem integração real.
- Indeed está em produção como processo externo.
- LinkedIn depende dos alertas de e-mail e não recebe descrição completa.
- Sólides está implementado, mas a documentação ainda não registra uma
  validação real completa.
- Catho permanece bloqueado por HTTP 403 e não deve ser ativado.
- Jooble está corretamente estacionado.

Isso torna o aplicativo um radar relevante, mas não um inventário completo
das vagas disponíveis.

### 4. O corpus não representa corretamente o tempo

CIEE chegou a representar 89% do corpus, com 100% das vagas sem
`publishedAt`. O prefilter protege o custo do LLM, mas a coleta continua
armazenando itens sem uma recência confiável.

Consequentemente, tendências de mercado, demanda por habilidades e planos de
estudo podem refletir a composição histórica da base, e não necessariamente o
mercado atual.

### 5. O bloqueio de track possui um trade-off real

A mudança registrada no ADR-051 remove muito lixo antes do LLM, mas transforma
uma classificação baseada no título em hard reject.

Ela é economicamente correta, porém uma vaga relevante com título genérico
pode desaparecer. Por isso, rejeições `track_unknown` precisam alimentar
revisão amostral e melhoria controlada da taxonomia.

## Funcionalidades futuras recomendadas

### P0 — Comprovar a operação atual

Antes de ampliar o produto:

1. Painel de saúde do scoring por execução, mostrando sucesso, timeout,
   output inválido, cache, tentativas, custo e modelo efetivo.
2. Alerta automático quando a taxa de sucesso do LLM cair abaixo de um
   limite.
3. Benchmark real de Stage A com cache frio.
4. Política explícita de recência para fontes sem `publishedAt`.
5. Cancelamento gracioso e lease persistente para execuções, evitando runs
   órfãs em restart.
6. Orçamento máximo por execução em chamadas, tokens e dólares, com
   interrupção segura.

### P1 — Fechar o ciclo de feedback

Esta é a evolução de maior valor.

Adicionar ações no Telegram ou em uma interface mínima:

- salvar;
- descartar com motivo;
- marcar track incorreto;
- indicar score incorreto;
- marcar candidatura enviada;
- registrar resposta, entrevista e oferta;
- pedir reavaliação;
- corrigir falso duplicado.

Esses dados permitiriam calibrar contra resultados reais, em vez de apenas
rótulos manuais. Também transformariam o aplicativo de digest em um verdadeiro
assistente de busca.

### P2 — Application tracker

Criar um ciclo simples:

`descoberta → salva → candidatura preparada → enviada → resposta → entrevista → oferta/rejeição`

Funcionalidades associadas:

- prazo da vaga;
- lembrete para candidatura;
- follow-up;
- histórico por empresa;
- documentos utilizados;
- observações;
- tempo entre candidatura e resposta.

Para o usuário, isso provavelmente oferece mais valor do que adicionar novos
collectors.

### P3 — Caixa de revisão explicável

Uma interface — inicialmente no próprio Telegram — para mostrar:

- por que a vaga passou ou foi rejeitada;
- requisitos atendidos e evidências;
- requisitos ausentes;
- confiança do resultado;
- descrição truncada;
- recência conhecida ou estimada;
- possíveis duplicatas;
- falhas do LLM;
- ação para restaurar ou reprocessar.

Isso reduz o risco dos hard rejects sem abandonar o ganho financeiro do
prefilter.

### P4 — Ingestão universal controlada

Adicionar uma forma de enviar manualmente qualquer URL ou texto de vaga:

- comando no Telegram;
- bookmarklet ou extensão do navegador;
- encaminhamento de e-mail;
- endpoint de ingestão manual.

É uma maneira barata de aumentar cobertura sem desenvolver scrapers frágeis ou
contornar proteções anti-bot.

### P5 — Ranking orientado à decisão

Manter o score de compatibilidade determinístico, mas criar uma prioridade
operacional separada:

`prioridade = compatibilidade + recência + prazo + preferência explícita + confiança da fonte`

Isso impediria uma vaga antiga com bom score de aparecer antes de uma vaga
nova prestes a encerrar.

### P6 — Calibração contínua

Quando houver dados suficientes:

- golden set com pelo menos 50–100 vagas;
- métricas por fonte e por track;
- precision/recall por verdict;
- análise de falsos negativos do prefilter;
- comparação controlada entre versões de prompt e modelo;
- monitoramento de drift;
- retuning de pesos somente com validação fora da amostra.

### P7 — Pacote de candidatura assistida

O sistema já possui variantes de currículo, evidências e termos ausentes. Pode
evoluir para produzir:

- variante recomendada;
- bullets existentes mais relevantes;
- checklist de palavras-chave;
- perguntas que precisam ser respondidas;
- lacunas que não devem ser inventadas;
- rascunho de carta ou mensagem, sempre sujeito a aprovação humana.

A geração de texto deve permanecer posterior à estabilização da recomendação e
nunca inventar experiência.

### P8 — Inteligência de mercado confiável

Evoluir o estudo atual com:

- janela temporal confiável;
- ponderação por fonte;
- remoção de republicações;
- tamanho mínimo de amostra;
- intervalos de confiança;
- demanda por track e região;
- habilidades associadas a respostas e entrevistas, não apenas a anúncios;
- comparação entre demanda e evidências atuais do perfil.

## O que não deve ser priorizado agora

- candidatura automática;
- evasão dos bloqueios de Catho ou Jooble;
- grande dashboard antes de validar o fluxo interativo no Telegram;
- arquitetura SaaS ou multiusuário;
- geração automática massiva de currículos e cartas;
- mais fontes sem antes medir saúde, recência e contribuição exclusiva;
- modelos de machine learning treinados com a amostra atual.

## Roadmap sugerido

1. Estabilizar e medir uma execução real pós-remediação.
2. Resolver a recência do CIEE e a falha de 70% do OpenRouter.
3. Introduzir feedback e tracking de candidaturas.
4. Expandir a calibração com resultados reais.
5. Criar revisão interativa e ranking por urgência.
6. Adicionar ingestão manual universal.
7. Amadurecer inteligência de mercado.
8. Só então avançar para geração assistida e uma interface web maior.

## Conclusão

O ArgosCareer já cumpre bem a função de encontrar e reduzir vagas para revisão
humana. Sua próxima fase não deveria ser “mais IA” nem “mais collectors”, mas
sim transformar decisões do usuário em feedback persistente.

Esse é o passo que converte uma excelente infraestrutura de triagem em um
assistente de carreira realmente personalizado e progressivamente mais
confiável.
