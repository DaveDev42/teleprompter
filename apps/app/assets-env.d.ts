/**
 * Metro asset module for text files (registered in metro.config.js
 * assetExts). The default export is the Metro asset module ID, consumed
 * via expo-asset's `Asset.fromModule()`.
 */
declare module "*.txt" {
  const assetModuleId: number;
  export default assetModuleId;
}
