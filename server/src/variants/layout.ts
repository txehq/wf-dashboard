import path from 'node:path';

// All variant paths under data/
export function dataLayout(dataDir: string) {
  return {
    cargoTarget: path.join(dataDir, 'cargo-target'),
    // Verbatim export of the base commit, the reference for "compare with base"; never rewritten
    base: (commit: string) => path.join(dataDir, 'bases', commit, 'src'),
    runtimeDir: (commit: string) => path.join(dataDir, 'runtimes', commit),
    runtimeBin: (commit: string) => path.join(dataDir, 'runtimes', commit, 'wf'),
    variant: (id: string) => variantLayout(path.join(dataDir, 'variants', id)),
    // src/ saved before an overwrite or restore (Contracts 17.4): variant-history/<variantId>/<snapshot>/src
    historySrc: (variantId: string, snapshot: string) =>
      path.join(dataDir, 'variant-history', variantId, snapshot, 'src'),
  };
}

export function variantLayout(dir: string) {
  const home = path.join(dir, 'home');
  return {
    dir,
    src: path.join(dir, 'src'),
    skills: path.join(dir, 'src', 'skills'),
    dist: path.join(dir, 'dist'),
    home,
    wfHome: path.join(home, 'wf'),
    wfBin: path.join(home, 'wf', 'bin', 'wf'),
    claudeDir: path.join(home, 'claude'),
    codexHome: path.join(home, 'codex'),
    tmp: path.join(dir, 'tmp'),
    buildLog: path.join(dir, 'build.log'),
    manifest: path.join(dir, 'variant.json'),
    mcpConfig: path.join(dir, 'mcp-config.json'),
  };
}

export type VariantLayout = ReturnType<typeof variantLayout>;
