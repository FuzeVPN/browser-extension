// SPDX-License-Identifier: MPL-2.0

import {
  buildDeviceProofPayload,
  exportPublicKeySpkiBase64,
  generateDeviceKeyPair,
  signDeviceProof,
} from "../../src/core/device/device-identity";
import { NOW } from "./helpers";

describe("browser device identity", () => {
  it("generates a non-exportable P-256 private key and an exportable SPKI public key", async () => {
    const pair = await generateDeviceKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.privateKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
    await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
    const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
    expect(spki.byteLength).toBeGreaterThan(80);
    const encoded = await exportPublicKeySpkiBase64(pair.publicKey);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))).toHaveLength(
      spki.byteLength,
    );
  });

  it("signs the exact proof payload as a 64-byte raw ECDSA signature", async () => {
    const pair = await generateDeviceKeyPair();
    const proof = await signDeviceProof(pair.privateKey, "device-1", "frankfurt-01", NOW);
    expect(proof.deviceTimestamp).toBe(Math.floor(NOW / 1_000));
    expect(proof.deviceNonce).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeBase64Url(proof.deviceNonce)).toHaveLength(24);
    const signature = decodeBase64Url(proof.deviceSignature);
    expect(signature).toHaveLength(64);
    const payload = new TextEncoder().encode(
      buildDeviceProofPayload(
        proof.deviceId,
        "frankfurt-01",
        proof.deviceTimestamp,
        proof.deviceNonce,
      ),
    );
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        new Uint8Array(signature).buffer,
        new Uint8Array(payload).buffer,
      ),
    ).resolves.toBe(true);
  });
});

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
