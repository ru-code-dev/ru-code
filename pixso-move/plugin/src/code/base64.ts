// Pure base64 encoder. The Pixso sandbox may lack `btoa`, so we encode manually
// from a byte array. Standard alphabet, `=` padding, no `data:` prefix.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] ?? 0;
    const byte1 = bytes[index + 1];
    const byte2 = bytes[index + 2];
    const triple = (byte0 << 16) | ((byte1 ?? 0) << 8) | (byte2 ?? 0);
    output += ALPHABET[(triple >> 18) & 0x3f];
    output += ALPHABET[(triple >> 12) & 0x3f];
    output += byte1 === undefined ? "=" : ALPHABET[(triple >> 6) & 0x3f];
    output += byte2 === undefined ? "=" : ALPHABET[triple & 0x3f];
  }
  return output;
};
