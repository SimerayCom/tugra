#!/usr/bin/env node
import { Command } from "commander";
import { CLI_VERSION } from "./version";
import { printError } from "./output";
import * as auth from "./commands/auth";
import * as resources from "./commands/resources";
import * as api from "./commands/api";
import * as version from "./commands/version";

const program = new Command();
program
  .name("tugra")
  .description("Command-line client for the Tugra self-hosted PaaS. Authenticate with `tugra login`.")
  .version(CLI_VERSION, "-V, --version", "output the CLI version");

auth.register(program);
resources.register(program);
api.register(program);
version.register(program);

program.parseAsync(process.argv).catch((err) => {
  printError(err);
  process.exitCode = 1;
});
