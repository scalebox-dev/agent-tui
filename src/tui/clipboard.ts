import { spawn } from "node:child_process";
import { platform } from "node:os";

export async function writeClipboard(text: string, stdout: NodeJS.WriteStream = process.stdout) {
  const osc52Written = writeOsc52(text, stdout);
  const nativeWritten = await writeNativeClipboard(text);
  return osc52Written || nativeWritten;
}

function writeOsc52(text: string, stdout: NodeJS.WriteStream) {
  if (!stdout.isTTY) return false;
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
  stdout.write(process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence);
  return true;
}

async function writeNativeClipboard(text: string) {
  const commands = nativeClipboardCommands();
  for (const [command, args] of commands) {
    if (await writeCommand(command, args, text)) return true;
  }
  return false;
}

function nativeClipboardCommands(): Array<[string, string[]]> {
  if (platform() === "darwin") return [["pbcopy", []]];
  if (platform() === "win32") {
    return [["powershell.exe", [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]]];
  }
  const commands: Array<[string, string[]]> = [];
  if (process.env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
  commands.push(["xclip", ["-selection", "clipboard"]]);
  commands.push(["xsel", ["--clipboard", "--input"]]);
  return commands;
}

function writeCommand(command: string, args: string[], input: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}
