import type * as Path from "effect/Path";

function literalCommands(command: string) {
  const commands: Array<{ words: string[]; conditional: boolean }> = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  let conditional = true;
  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const finishCommand = () => {
    finishWord();
    if (words.length === 0) return false;
    commands.push({ words, conditional });
    words = [];
    return true;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
      continue;
    }
    if (char === "\\") {
      const next = command[++index];
      if (next === undefined) return null;
      if (next !== "\n") {
        word += quote === '"' && !'"\\$`'.includes(next) ? `\\${next}` : next;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "$" || char === "`") return null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "#" && !started) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index++;
    } else if (char === ";" || char === "\n") {
      if (finishCommand()) conditional = false;
    } else if (char === "&" && command[index + 1] === "&") {
      if (!finishCommand()) return null;
      conditional = true;
      index++;
    } else if (/\s/.test(char)) {
      finishWord();
    } else if ("$`|&<>(){}*?[]!".includes(char) || (char === "~" && !started)) {
      return null;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  finishCommand();
  return commands;
}

function checkoutPath(args: string[], cwd: string, path: Pick<Path.Path, "resolve">) {
  const operation = args.shift();
  const worktree = operation === "worktree";
  if (worktree && args.shift() !== "add") return;
  if (!worktree && operation !== "switch" && operation !== "checkout") return;

  let createdBranch = false;
  let options = true;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (options && arg === "--") {
      if (!worktree) return;
      options = false;
    } else if (
      options &&
      ["-b", "-B", "-c", "-C", "--create", "--force-create", "--orphan"].includes(arg)
    ) {
      if (!args[++index]) return;
      createdBranch = true;
    } else if (options && worktree && arg === "--reason") {
      if (args[++index] === undefined) return;
    } else if (
      options &&
      [
        "-d",
        "--detach",
        "-f",
        "--force",
        "-q",
        "--quiet",
        "--checkout",
        "--no-checkout",
        "--lock",
      ].includes(arg)
    ) {
      continue;
    } else if (options && arg.startsWith("-") && arg !== "-") {
      return;
    } else {
      positional.push(arg);
    }
  }
  if (worktree) {
    if (!positional[0] || positional.length > 2 || positional[0] === "-") return;
    return path.resolve(cwd, positional[0]);
  }
  if (positional.length > 1 || (!createdBranch && positional.length !== 1)) return;
  return cwd;
}

function parseChanges(
  command: string,
  cwd: string,
  path: Pick<Path.Path, "resolve">,
  depth: number,
) {
  const commands = literalCommands(command);
  if (!commands || depth > 4) return [];
  const changes: Array<{ cwd: string; checkoutPath: string }> = [];
  let changedDirectory = false;
  for (const { words, conditional } of commands) {
    if (!conditional) {
      // Only the final && chain is proven successful by the shell's exit code.
      changes.length = 0;
      if (changedDirectory) return [];
    }
    const [executable, ...args] = words;
    const name = executable!.split("/").at(-1);
    if (
      [
        "source",
        ".",
        "eval",
        "exec",
        "exit",
        "return",
        "set",
        "trap",
        "alias",
        "unalias",
        "command",
        "builtin",
        "pushd",
        "popd",
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "for",
        "while",
        "until",
        "do",
        "done",
        "case",
        "esac",
        "function",
      ].includes(name!)
    )
      return [];
    if (executable === "cd") {
      if (args.length !== 1 || !args[0] || args[0].startsWith("-")) return [];
      cwd = path.resolve(cwd, args[0]);
      changedDirectory = true;
      continue;
    }
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(name!)) {
      const scriptIndex = args.findIndex((arg) => /^-[el]*c[el]*$/.test(arg));
      if (scriptIndex >= 0 && args.slice(0, scriptIndex).every((arg) => /^-[el]+$/.test(arg))) {
        const script = args[scriptIndex + 1];
        if (script !== undefined) changes.push(...parseChanges(script, cwd, path, depth + 1));
      }
      continue;
    }
    if (name !== "git") continue;
    let gitCwd = cwd;
    while (args[0] === "-C") {
      args.shift();
      const directory = args.shift();
      if (directory === undefined) return [];
      gitCwd = path.resolve(gitCwd, directory);
    }
    const checkout = checkoutPath(args, gitCwd, path);
    if (checkout !== undefined) changes.push({ cwd: gitCwd, checkoutPath: checkout });
  }
  return changes;
}

export function gitCheckoutChanges(
  command: string,
  cwd: string,
  path: Pick<Path.Path, "resolve">,
): Array<{ cwd: string; checkoutPath: string }> {
  return parseChanges(command, cwd, path, 0);
}
