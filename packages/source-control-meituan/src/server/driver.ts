import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import { definition } from "../shared/definition.ts";
import * as MCodeCli from "./MCodeCli.ts";
import * as MCodeSourceControlProvider from "./MCodeSourceControlProvider.ts";
import * as MCodePullRequestProvider from "./MCodePullRequestProvider.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(
    Effect.all({
      sourceControl: MCodeSourceControlProvider.make,
      discovery: Effect.succeed(MCodeCli.discovery),
      pullRequests: MCodePullRequestProvider.make,
    }),
    MCodeCli.layer,
  ),
});
