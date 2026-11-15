const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

export function officialNpmRegistryArgs(packageName: string) {
  const scope = /^(@[^/]+)\//.exec(packageName)?.[1];
  return [
    `--registry=${OFFICIAL_NPM_REGISTRY}`,
    ...(scope ? [`--${scope}:registry=${OFFICIAL_NPM_REGISTRY}`] : []),
  ];
}

export function withOfficialNpmRegistry(env: NodeJS.ProcessEnv, packageName: string) {
  const scope = /^(@[^/]+)\//.exec(packageName)?.[1];
  const overrides: NodeJS.ProcessEnv = {
    npm_config_registry: OFFICIAL_NPM_REGISTRY,
    ...(scope ? { [`npm_config_${scope}:registry`]: OFFICIAL_NPM_REGISTRY } : {}),
  };
  return {
    ...Object.fromEntries(
      Object.entries(env).map(([name, value]) => [
        name,
        Object.hasOwn(overrides, name.toLowerCase()) ? OFFICIAL_NPM_REGISTRY : value,
      ]),
    ),
    ...overrides,
  };
}
