# What changes

<!-- The change itself, in a few lines. Describe the result, not the process. -->

# Why

<!--
Which milestone this belongs to, and what it unlocks. Link the ADR if this
pull request records a decision. If it contradicts a previously recorded
decision, say so here and supersede the ADR.
-->

# How to test

<!--
Commands a reviewer can paste. `npm run lint && npm run format:check &&
npm run typecheck && npm test` is assumed; list anything beyond it.
-->

# What is left out

<!--
Scope deliberately deferred, and to which milestone. Also list anything that
is an unverified assumption in this branch — an undocumented API schema, a
provisional weight, a threshold awaiting calibration.
-->

# Checklist

- [ ] CI is green
- [ ] Non-obvious decisions are recorded as ADRs in `docs/adr/`
- [ ] No personal data, token or API key is committed
- [ ] `git ls-files` shows no profile, database, `.env` or raw fixture
