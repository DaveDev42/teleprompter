// Dynamic Expo config. Expo loads `app.json` first and passes its contents in as
// `config`; this function returns the final resolved config. We keep `app.json` as the
// single source of truth for all static fields and only override here when needed.
//
// WHY runtimeVersion is overridden for local dev builds
// -----------------------------------------------------
// `eas build --local` runs the actual build inside an isolated
// `eas-cli-local-build-plugin` subprocess. With `runtimeVersion.policy = "fingerprint"`
// (the value in app.json), `@expo/build-tools` compares two independently-computed
// runtime versions in `configureExpoUpdatesIfInstalledAsync`:
//   - ctx.metadata.runtimeVersion          — fingerprint computed by the parent eas-cli
//   - resolvedRuntime.resolvedRuntimeVersion — fingerprint recomputed inside the subprocess
// For a local build these two fingerprints diverge (the subprocess resolves against the
// staged/prebuilt project, not the working tree), so the build aborts with
// "Runtime version calculated on local machine not equal to runtime version calculated
// during build." `EXPO_UPDATES_FINGERPRINT_OVERRIDE` does NOT fix this — it only affects
// the later Xcode build-phase fingerprint script, which never runs because this
// pre-check throws first.
//
// The `development` and `device` build profiles in eas.json set `APP_VARIANT=dev-local`.
// eas-cli injects that env var into BOTH config evaluations (parent metadata via
// evaluateConfigWithEnvVarsAsync → buildProfile.env, and the subprocess via
// EAS_BUILD_PROFILE + builderEnvironment.env), so both sides resolve the same static
// runtimeVersion below — the fingerprint comparison passes with no fingerprint computed.
// Local dev builds never consume OTA, so the literal value is otherwise inert.
//
// Cloud preview/production builds do NOT set APP_VARIANT, so they keep app.json's
// `policy: "fingerprint"` and retain real fingerprint-based OTA correlation.

const IS_DEV_LOCAL = process.env.APP_VARIANT === "dev-local";

module.exports = ({ config }) => {
  if (IS_DEV_LOCAL) {
    return { ...config, runtimeVersion: "dev-local" };
  }
  return config;
};
