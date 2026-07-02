import { spawn } from "node:child_process";
import { platform } from "node:os";

interface ClipboardCommand {
  args: string[];
  command: string;
  label: string;
}

export interface ClipboardCapabilities {
  nativeRead: { available: boolean; label?: string };
  nativeWrite: { available: boolean; label?: string };
  osc52Write: { available: boolean; reliable: false };
}

export interface ClipboardWriteResult {
  method: "native" | "osc52" | null;
  ok: boolean;
  reliable: boolean;
}

export async function detectClipboardCapabilities(stdout: NodeJS.WriteStream = process.stdout): Promise<ClipboardCapabilities> {
  const nativeWrite = await firstAvailableCommand(nativeClipboardWriteCommands());
  const nativeRead = await firstAvailableCommand(nativeClipboardReadCommands());
  return {
    nativeRead: nativeRead ? { available: true, label: nativeRead.label } : { available: false },
    nativeWrite: nativeWrite ? { available: true, label: nativeWrite.label } : { available: false },
    osc52Write: { available: Boolean(stdout.isTTY), reliable: false },
  };
}

export function formatClipboardCapabilities(capabilities: ClipboardCapabilities) {
  const write = capabilities.nativeWrite.available
    ? `write=${capabilities.nativeWrite.label}`
    : capabilities.osc52Write.available
      ? "write=OSC52"
      : "write=none";
  const read = capabilities.nativeRead.available ? `read=${capabilities.nativeRead.label}` : "read=none";
  const note = capabilities.nativeWrite.available
    ? ""
    : capabilities.osc52Write.available
      ? " (terminal may block OSC52)"
      : "";
  return `Clipboard: ${write}, ${read}${note}`;
}

export async function writeClipboard(
  text: string,
  stdout: NodeJS.WriteStream = process.stdout,
  capabilities?: ClipboardCapabilities | null,
) {
  const nativeWritten = capabilities?.nativeWrite.available === false
    ? false
    : await writeNativeClipboard(text, capabilities?.nativeWrite.label);
  if (nativeWritten) return { method: "native", ok: true, reliable: true } satisfies ClipboardWriteResult;
  const osc52Written = capabilities?.osc52Write.available === false ? false : writeOsc52(text, stdout);
  if (osc52Written) return { method: "osc52", ok: true, reliable: false } satisfies ClipboardWriteResult;
  return { method: null, ok: false, reliable: false } satisfies ClipboardWriteResult;
}

export async function readClipboard(capabilities?: ClipboardCapabilities | null) {
  if (capabilities?.nativeRead.available === false) return null;
  const commands = nativeClipboardReadCommands(capabilities?.nativeRead.label);
  for (const candidate of commands) {
    const text = await readCommand(candidate.command, candidate.args);
    if (text !== null) return text;
  }
  return null;
}

function writeOsc52(text: string, stdout: NodeJS.WriteStream) {
  if (!stdout.isTTY) return false;
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
  stdout.write(process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence);
  return true;
}

async function writeNativeClipboard(text: string, preferredLabel?: string) {
  const commands = nativeClipboardWriteCommands(preferredLabel);
  for (const candidate of commands) {
    if (await writeCommand(candidate.command, candidate.args, text)) return true;
  }
  return false;
}

function nativeClipboardWriteCommands(preferredLabel?: string): ClipboardCommand[] {
  const commands = nativeClipboardWriteCandidates();
  return preferredLabel ? prioritizeCommand(commands, preferredLabel) : commands;
}

function nativeClipboardWriteCandidates(): ClipboardCommand[] {
  if (platform() === "darwin") return [{ args: [], command: "pbcopy", label: "pbcopy" }];
  if (platform() === "win32") {
    return [{
      args: [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
      command: "powershell.exe",
      label: "PowerShell",
    }];
  }
  const commands: ClipboardCommand[] = [];
  if (process.env.WAYLAND_DISPLAY) commands.push({ args: [], command: "wl-copy", label: "wl-copy" });
  commands.push({ args: ["-selection", "clipboard"], command: "xclip", label: "xclip" });
  commands.push({ args: ["--clipboard", "--input"], command: "xsel", label: "xsel" });
  return commands;
}

function nativeClipboardReadCommands(preferredLabel?: string): ClipboardCommand[] {
  const commands = nativeClipboardReadCandidates();
  return preferredLabel ? prioritizeCommand(commands, preferredLabel) : commands;
}

function nativeClipboardReadCandidates(): ClipboardCommand[] {
  if (platform() === "darwin") return [{ args: [], command: "pbpaste", label: "pbpaste" }];
  if (platform() === "win32") {
    return [{
      args: [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
      ],
      command: "powershell.exe",
      label: "PowerShell",
    }];
  }
  const commands: ClipboardCommand[] = [];
  if (process.env.WAYLAND_DISPLAY) commands.push({ args: ["--no-newline"], command: "wl-paste", label: "wl-paste" });
  commands.push({ args: ["-selection", "clipboard", "-out"], command: "xclip", label: "xclip" });
  commands.push({ args: ["--clipboard", "--output"], command: "xsel", label: "xsel" });
  return commands;
}

function prioritizeCommand(commands: ClipboardCommand[], label: string) {
  return [
    ...commands.filter((command) => command.label === label),
    ...commands.filter((command) => command.label !== label),
  ];
}

async function firstAvailableCommand(commands: ClipboardCommand[]) {
  for (const command of commands) {
    if (await commandAvailable(command.command)) return command;
  }
  return null;
}

function commandAvailable(command: string) {
  const checker = platform() === "win32" ? "where" : "command";
  const args = platform() === "win32" ? [command] : ["-v", command];
  return new Promise<boolean>((resolve) => {
    const child = spawn(checker, args, { shell: platform() !== "win32", stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function writeCommand(command: string, args: string[], input: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

function readCommand(command: string, args: string[]) {
  return new Promise<string | null>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.on("error", () => resolve(null));
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null));
  });
}
