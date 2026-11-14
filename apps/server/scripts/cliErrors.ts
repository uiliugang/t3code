import * as Schema from "effect/Schema";

export class ServerCliCommandExitError extends Schema.TaggedError<
  ServerCliCommandExitError,
  { readonly brand: unique symbol }
>()("ServerCliCommandExitError", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  exitCode: Schema.Int,
}) {
  override get message(): string {
    return `Command exited with non-zero exit code (${this.exitCode})`;
  }
}

export class ServerCliDevelopmentIconSourceMissingError extends Schema.TaggedError<
  ServerCliDevelopmentIconSourceMissingError,
  { readonly brand: unique symbol }
>()("ServerCliDevelopmentIconSourceMissingError", {
  sourcePath: Schema.String,
}) {
  override get message(): string {
    return `Missing development icon source: ${this.sourcePath}`;
  }
}

export class ServerCliDevelopmentIconTargetMissingError extends Schema.TaggedError<
  ServerCliDevelopmentIconTargetMissingError,
  { readonly brand: unique symbol }
>()("ServerCliDevelopmentIconTargetMissingError", {
  targetPath: Schema.String,
}) {
  override get message(): string {
    return `Missing development icon target: ${this.targetPath}. Build web first.`;
  }
}

export class ServerCliBuildAssetMissingError extends Schema.TaggedError<
  ServerCliBuildAssetMissingError,
  { readonly brand: unique symbol }
>()("ServerCliBuildAssetMissingError", {
  assetPath: Schema.String,
}) {
  override get message(): string {
    return `Missing build asset: ${this.assetPath}. Run the build subcommand first.`;
  }
}

export class ServerCliExecutableImportError extends Schema.TaggedError<
  ServerCliExecutableImportError,
  { readonly brand: unique symbol }
>()("ServerCliExecutableImportError", {
  bundlePath: Schema.String,
  specifiers: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `${this.bundlePath} imports file-backed packages that a single-executable cannot resolve: ${this.specifiers.join(", ")}. Load them through createRequire instead.`;
  }
}

export class ServerCliBootstrapTooLargeError extends Schema.TaggedError<
  ServerCliBootstrapTooLargeError,
  { readonly brand: unique symbol }
>()("ServerCliBootstrapTooLargeError", {
  bootstrapPath: Schema.String,
  bytes: Schema.Number,
}) {
  override get message(): string {
    return `${this.bootstrapPath} is ${this.bytes} bytes. The CLI was bundled into the executable bootstrap; keep ./binMain.ts external.`;
  }
}
