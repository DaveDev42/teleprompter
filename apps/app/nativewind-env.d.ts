/// <reference types="nativewind/types" />

// TS 6 (Expo SDK 56) tightened side-effect import checks (TS2882): a bare
// `import "../global.css"` now needs an ambient module declaration. nativewind
// pulls in `react-native-css-interop/types`, which augments react-native but
// does not declare `*.css` as a side-effect-importable module. Declare it here
// so the global stylesheet import in app/_layout.tsx type-checks.
declare module "*.css" {}
