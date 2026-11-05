# Authored correction-selection controls

`node-preload-flags.json` contains 31 minimal script cases plus five investigation examples authored
for DepVitals. No upstream source is copied. The scripts/source strings are static scanner input;
never execute them as project commands. Every baseline array was specified from the current evidence
contract and verified through the ordinary built CLI; source syntax was cross-checked with the
existing development TypeScript compiler without evaluating code.

`afterF1` and its exit code are selected acceptance for one future correction family, **not current
behavior or a passing implemented regression**. The correction is not implemented by these fixtures.
The selection and controls were independently reviewed. After the integrated freeze accepts them, the
owning correction step must add failed-before/passed-after production regressions, including script
provenance and default/JSON/explain integration.

The controls cover selected Node preload flags, exact root/subpath normalization, multiple candidates,
existing outer Node credit, no executable alias mapping for module values, quoting/assignments,
operand/terminator/unknown-option boundaries, opaque shell syntax, undeclared and peer-only names,
neighboring segments, script-wide ordinals after declared/undeclared command events, and dependency
exclusions. They do not authorize general Node argument parsing,
recursive wrappers, target execution or resolution.
