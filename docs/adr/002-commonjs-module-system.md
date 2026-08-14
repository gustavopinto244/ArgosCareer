# ADR-002 — Build on CommonJS with a strict TypeScript configuration

## Status

Accepted

## Date

2026-08-14

## Context

`atlas-manager`, the sibling repository whose conventions this project otherwise
mirrors, is ESM (`"type": "module"`). Matching it would be the consistent choice.

But ADR-001 adopted NestJS, whose supported path is CommonJS: the Nest CLI, its
documentation and a meaningful part of its ecosystem assume it, and its DI relies
on `emitDecoratorMetadata`. Running Nest under ESM is possible but puts the
project on a path where framework problems become module-system problems.

Separately, TypeScript 7.0.2 is the current release — the native-port compiler
rewrite. TypeScript 6.0.3 is what `atlas-manager` runs.

## Considered options

### ESM, matching atlas-manager

Rejected. Consistency between the two repositories is worth something, but not
the friction of running Nest off its supported path. The friction would be paid
continuously, in exchange for tidiness.

### CommonJS with `module: commonjs` and `moduleResolution: node`

Rejected on evidence. Running `tsc` with this configuration produces:

```
error TS5107: Option 'moduleResolution=node10' is deprecated and will stop
functioning in TypeScript 7.0.
```

The classic pair is on its way out. Adopting it would mean adopting a known
migration.

### CommonJS with `module: node16` and `moduleResolution: node16`

Accepted. Because `package.json` declares no `"type"` field, node16 resolves and
emits CommonJS anyway — so Nest gets the module format it expects — while using
the resolution algorithm that survives TypeScript 7.

### TypeScript 7 now

Deferred. Nest resolves DI from `emitDecoratorMetadata` reflection, and that
combination is unverified under the native-port compiler. Guessing here would
contradict the project's own rule about not inventing facts that can be checked.

## Decision

CommonJS, via `module: node16` and `moduleResolution: node16`.

TypeScript is pinned to the 6 line. Revisit TypeScript 7 in M1, when Nest is
actually installed and the assumption becomes testable rather than theoretical.

Strict compiler flags carried over from `atlas-manager`: `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`.

## Consequences

- Nest runs on its supported path; framework issues stay framework issues.
- Two configuration files must be ESM regardless: `eslint.config.mjs`, because
  flat config uses `import`, and `vitest.config.mts`, because `vitest/config` is
  ESM-only and cannot be `require`d from CommonJS. Both extensions are load-
  bearing, not stylistic.
- The two repositories now differ in module system. Anyone reading both will
  notice; this ADR is the answer.
- ESM-only dependencies become awkward to adopt and may need dynamic `import()`.
  This is the real ongoing cost, and the ecosystem is moving toward ESM, so it
  grows over time.
- `exactOptionalPropertyTypes` occasionally conflicts with framework typings. If
  it fights Nest in M1, relaxing that single flag is preferable to relaxing
  `strict` — and requires amending this ADR rather than editing it silently.
