// Generate a fresh designer key. The Pixso plugin iframe is often NOT a secure
// context, so `crypto.randomUUID` may be missing/throw — build a v4 UUID from
// getRandomValues with a Math.random fallback so the button always works.
const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
};

const uuidV4 = (): string => {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
};

export const generateDesignerId = (): string => `dz_${uuidV4()}`;
