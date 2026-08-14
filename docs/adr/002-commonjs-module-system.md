# ADR-002 — Build on CommonJS with a strict TypeScript configuration

## Status

Accepted — amended 2026-08-14, see
[Amendment 1](#amendment-1--2026-08-14-node16--nodenext) and
[Amendment 2](#amendment-2--2026-08-14-typescript-7-reassessed-and-rejected)

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

## Amendment 1 — 2026-08-14: `node16` → `nodenext`

The text above is kept as originally accepted. This section records a change to
the resolution mode. The core decision — CommonJS with a strict configuration —
is unchanged, which is why this is an amendment rather than a superseding ADR.

### What prompted it

A question about why `moduleResolution: "node"` was deprecated exposed a
conflation worth writing down: `node10`, `node16` and `nodenext` name
_resolution algorithms_, not target runtime versions. `node16` means "the
algorithm Node 16 introduced", which Node 18, 20, 22 and 24 all still use.

That reframing raised a question the original decision never asked: whether
`nodenext`, which tracks current Node semantics, models something `node16` does
not.

### What was measured

It does. Node has supported `require()` of an ES module unflagged since
**22.12.0** — flagged before that on the 22.x line, and unflagged on 23.x. Only
`nodenext` models this.

Verified locally on Node 24.19.0: with `nodenext`, `tsc --noEmit` accepts
`import { defineConfig } from "vitest/config"` inside a CommonJS `.ts` file, and
`require("vitest/config")` resolves at runtime. Under `node16` the same file
fails to compile with TS1479.

### Decision

`module` and `moduleResolution` become `nodenext`. `vitest.config.mts` reverts
to `vitest.config.ts`. `engines.node` tightens from `>=22` to `>=22.12.0`.

The engines change is the load-bearing part: between 22.0 and 22.11 `require(esm)`
sits behind a flag, so leaving `>=22` while depending on `nodenext` semantics
would make the declared support range a false claim.

### Consequences

- The consequence above stating that `vitest.config.mts` must be `.mts` **no
  longer holds**. `eslint.config.mjs` still must be `.mjs`, because ESLint loads
  flat config itself rather than through TypeScript.
- ESM-only dependencies stop being awkward, which was the largest ongoing cost
  the original decision accepted.
- Module resolution now matches `atlas-manager`'s `NodeNext`, removing one of
  the three divergences between the repositories.
- **New cost:** `nodenext` is a moving target. Its semantics may shift between
  TypeScript releases, where `node16` was pinned. This is the trade accepted in
  exchange for the above, and it is the thing to check first if a TypeScript
  upgrade breaks the build.
- The supported Node range narrows. Node 22.0–22.11 is no longer supported; CI
  covers current 22.x and 24.x, both well past the threshold.

## Amendment 2 — 2026-08-14: TypeScript 7 reassessed and rejected

The original decision deferred TypeScript 7 because Nest's DI resolves
constructor parameter types from `emitDecoratorMetadata` reflection, and that
combination was untested under the native-port compiler. M1 adds the first
real Nest code — an `AppModule`, `main.ts`, and an `@Injectable()` class with
a constructor-injected dependency — which made the question answerable
instead of theoretical.

### What was measured

Two regression tests were added
(`test/typescript-metadata.test.ts`): one asserting `Reflect.getMetadata`
returns the correct constructor parameter types for a decorated class, one
resolving a constructor-injected dependency through Nest's actual DI
container. Both pass under TypeScript 6.0.3.

TypeScript was then bumped to 7.0.2 and the full matrix re-run:

| Check                                               | Result under TS 7.0.2                       |
| --------------------------------------------------- | ------------------------------------------- |
| `tsc --noEmit`                                      | Pass                                        |
| `tsc -p tsconfig.build.json`                        | Pass                                        |
| `node dist/main.js` (compiled boot)                 | Pass — `AppModule dependencies initialized` |
| Full test suite, including both DI regression tests | 50/50 pass                                  |
| `eslint .`                                          | **Fatal error**                             |

The `emitDecoratorMetadata` concern that motivated deferring TS 7 turned out
to be unfounded — decorator metadata, Nest DI, build and boot all work
correctly under TS 7.0.2. The actual blocker is different and unrelated:

```
typescript-eslint does not support TS 7.0.
Please see https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0
```

This is not a warning. `eslint .` exits non-zero and CI's lint step fails
outright.

### Decision

Stay on TypeScript 6.0.3. Not because of the concern this ADR originally
raised — that one is resolved and no longer a reason to wait — but because
`typescript-eslint` refuses to run under TS 7.0 at all, and CI requires lint
to pass.

### Consequences

- The original justification for pinning TS 6 (unverified decorator metadata)
  is retired; the two regression tests are the permanent replacement for the
  uncertainty, not a one-time check. If TypeScript is revisited again, these
  tests are what would catch a real regression.
- The new, real blocker is external and outside this project's control:
  `typescript-eslint` shipping TS 7 support. Revisit by bumping `typescript`
  and `typescript-eslint` together and rerunning the linter — the moment it
  does not crash, TS 7 is viable on the evidence already gathered here.
- No code changes were required by this reassessment in either direction;
  `package.json` stays at `^6.0.3`. The two DI regression tests are the only
  lasting artifact, committed regardless of the outcome.
