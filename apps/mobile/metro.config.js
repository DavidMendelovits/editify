const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, '..', '..');

config.watchFolders = [workspaceRoot];

// packages/shared uses Node ESM-style `./foo.js` specifiers that actually point at
// `./foo.ts`. tsc resolves them; Metro doesn't, so retry with TS extensions.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? require('metro-resolver').resolve;
  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
      const base = moduleName.slice(0, -3);
      for (const ext of ['.ts', '.tsx']) {
        try {
          return resolve(context, base + ext, platform);
        } catch {}
      }
    }
    throw error;
  }
};

module.exports = config;
