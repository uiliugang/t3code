const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

export function officialNpmRegistryArgs(packageName: string) {
  const scope = /^(@[^/]+)\//.exec(packageName)?.[1];
  return [
    `--registry=${OFFICIAL_NPM_REGISTRY}`,
    ...(scope ? [`--${scope}:registry=${OFFICIAL_NPM_REGISTRY}`] : []),
  ];
}
