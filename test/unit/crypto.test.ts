import { describe, expect, it } from "vitest";
import { TokenCipher } from "../../src/crypto";

describe("TokenCipher", () => {
  const cipher = new TokenCipher("test-secret");

  it("round-trips a token", () => {
    const enc = cipher.encrypt("BQD-spotify-access-token");
    expect(enc).not.toContain("spotify-access-token");
    expect(cipher.decrypt(enc)).toBe("BQD-spotify-access-token");
  });

  it("uses a fresh IV each time", () => {
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = cipher.encrypt("secret").split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
  });

  it("rejects a token encrypted with a different key", () => {
    expect(() => new TokenCipher("other-secret").decrypt(cipher.encrypt("secret"))).toThrow();
  });

  it("rejects malformed input", () => {
    expect(() => cipher.decrypt("not-a-token")).toThrow("Malformed");
  });
});
