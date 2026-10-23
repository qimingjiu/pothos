/** Bounded text/plain MIME reader. Unsupported/HTML-only mail stays unacknowledged. */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) { out[last] += ` ${line.trim()}`; continue; }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) { last = m[1]!.toLowerCase(); out[last] = m[2]!; }
  }
  return out;
}

function parameter(header: string, key: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(header)?.slice(1).find(v => v !== undefined);
}

function decodeBody(body: string, encoding: string, charset: string): string {
  let bytes: Buffer;
  switch (encoding.toLowerCase().trim()) {
    case "base64": {
      const value = body.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error("invalid MIME base64");
      bytes = Buffer.from(value, "base64");
      break;
    }
    case "quoted-printable": {
      const input = body.replace(/=\r?\n/g, "");
      const chunks: Buffer[] = [];
      for (let i = 0; i < input.length;) {
        if (input[i] === "=") {
          const hex = input.slice(i + 1, i + 3);
          if (!/^[a-f\d]{2}$/i.test(hex)) throw new Error("invalid MIME quoted-printable");
          chunks.push(Buffer.from([parseInt(hex, 16)])); i += 3;
        } else {
          const next = input.indexOf("=", i);
          const end = next < 0 ? input.length : next;
          chunks.push(Buffer.from(input.slice(i, end), "latin1")); i = end;
        }
      }
      bytes = Buffer.concat(chunks);
      break;
    }
    case "": case "7bit": case "8bit": case "binary":
      bytes = Buffer.from(body, "latin1"); break;
    default: throw new Error("unsupported MIME transfer encoding");
  }
  return new TextDecoder(charset, { fatal: true }).decode(bytes);
}

/** Body is a byte-preserving latin1 string, never pre-decoded UTF-8. */
export function mimeText(headers: Record<string, string>, body: string, depth = 0): string {
  if (depth > 8 || body.length > 2 * 1024 * 1024) throw new Error("MIME size/depth limit");
  const type = headers["content-type"] ?? "text/plain; charset=utf-8";
  if (/^attachment\b/i.test(headers["content-disposition"] ?? "")) throw new Error("MIME attachment is not reply text");
  if (/^multipart\//i.test(type)) {
    const boundary = parameter(type, "boundary");
    if (!boundary || boundary.length > 200) throw new Error("missing/invalid MIME boundary");
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = body.split(new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`));
    const texts: string[] = [];
    // split includes the optional closing marker as every second item.
    for (let i = 2; i < parts.length; i += 2) {
      if (parts[i - 1] === "--") break;
      const part = parts[i]!;
      const sep = /\r?\n\r?\n/.exec(part);
      if (!sep || sep.index == null) continue;
      const sub = parseHeaders(part.slice(0, sep.index));
      if (/^attachment\b/i.test(sub["content-disposition"] ?? "")) continue;
      if (!/^(text\/plain|multipart\/)/i.test(sub["content-type"] ?? "text/plain")) continue;
      texts.push(mimeText(sub, part.slice(sep.index + sep[0].length), depth + 1));
      if (/^multipart\/alternative/i.test(type)) break;
    }
    if (!texts.length) throw new Error("MIME has no supported plain-text part");
    return texts.join("\n").trim();
  }
  if (!/^text\/plain(?:\s*;|\s*$)/i.test(type)) throw new Error("unsupported MIME content type");
  return decodeBody(body, headers["content-transfer-encoding"] ?? "", parameter(type, "charset") ?? "utf-8").trim();
}
