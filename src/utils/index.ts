import * as emoji from "node-emoji";
import chalk from "chalk";
import { taskEither } from "fp-ts/lib/TaskEither";

export const log = <L = unknown>(s: string) =>
  taskEither.fromIO<L, void>(() => console.log(s)); // eslint-disable-line no-console

export const logError = <L = unknown>(s: string) =>
  log<L>(emoji.emojify(chalk.bold.red(s)));

export const logInfo = <L = unknown>(s: string) =>
  log<L>(emoji.emojify(chalk.bold(s)));

export const logDetail = <L = unknown>(s: string) =>
  log<L>(emoji.emojify(chalk.dim(s)));
