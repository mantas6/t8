/**
 * Clipboard writes over OSC 52, which works over SSH and inside tmux: the
 * terminal emulator on the user's machine sets its clipboard.
 *
 * Follows opencode's `packages/tui/src/clipboard.ts` (MIT): prefer the
 * renderer's own OSC 52 writer, which goes through its output session so it
 * cannot interleave with a frame. That writer refuses when capability
 * detection says OSC 52 is unsupported, which is often wrong over SSH, so we
 * then write the sequence to stdout ourselves.
 */

/** The part of OpenTUI's `CliRenderer` used here. */
export interface Osc52Writer {
  copyToClipboardOSC52(text: string): boolean;
}

/**
 * The OSC 52 "set clipboard" sequence for `text`, wrapped for tmux or GNU
 * screen passthrough when running inside one. tmux needs `allow-passthrough`
 * or `set-clipboard on` for it to reach the outer terminal.
 */
export function osc52Sequence(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const sequence = `\x1b]52;c;${payload}\x07`;
  if (env.TMUX) return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  if (env.STY) return `\x1bP${sequence}\x1b\\`;
  return sequence;
}

/** Copies `text` to the system clipboard. Returns false if nothing could be written. */
export function copyToClipboard(
  text: string,
  renderer?: Osc52Writer,
  write: (data: string) => boolean = (data) => process.stdout.write(data),
): boolean {
  // OpenTUI rejects NUL; the host clipboard cannot hold it either.
  const clean = text.replaceAll("\0", "");
  try {
    if (renderer?.copyToClipboardOSC52(clean)) return true;
  } catch {
    // fall back to writing the sequence ourselves
  }
  try {
    write(osc52Sequence(clean));
    return true;
  } catch {
    return false;
  }
}
