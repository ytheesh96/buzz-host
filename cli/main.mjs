// buzz-host command line (bin/buzz-host runs this with the bundle's Node).
// Each subcommand is one entry in COMMANDS: { summary, run(argv) -> exit code }.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatHuman, parseUpArgs, up, UP_USAGE } from "./up.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundleVersion() {
  return (await fs.readFile(path.join(root, "VERSION"), "utf8").catch(() => "dev")).trim() || "dev";
}

export const COMMANDS = {
  up: {
    summary: "Install/upgrade this bundle, start buzz-host, print URL + token (--json for scripts)",
    async run(argv) {
      const opts = parseUpArgs(argv);
      if (opts.help) {
        process.stdout.write(`${UP_USAGE}\n`);
        return 0;
      }
      const outcome = await up(opts);
      process.stdout.write(opts.json ? `${JSON.stringify(outcome.result)}\n` : formatHuman(outcome));
      return 0;
    },
  },
  version: {
    summary: "Print this bundle's version",
    async run() {
      process.stdout.write(`${await bundleVersion()}\n`);
      return 0;
    },
  },
};

export function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    "Usage: buzz-host <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.summary}`),
    "",
    "Run `buzz-host <command> --help` for a command's options.",
    "",
  ].join("\n");
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === "-h" || name === "--help" || name === "help") {
    process.stdout.write(usage());
    return name ? 0 : 2;
  }
  if (name === "--version" || name === "-V") return COMMANDS.version.run([]);
  const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!cmd) {
    process.stderr.write(`buzz-host: unknown command "${name}"\n\n${usage()}`);
    return 2;
  }
  return cmd.run(rest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`buzz-host: ${error.message}\n`);
      process.exit(1);
    },
  );
}
