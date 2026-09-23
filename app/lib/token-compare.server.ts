import { timingSafeEqual } from "node:crypto";

// Constant-time comparison of the received `x-health-token` header against the
// expected token. A plain `!==` leaks timing information proportional to the
// length of the matching prefix, letting an attacker recover the token
// byte-by-byte; `timingSafeEqual` requires equal-length buffers (it throws
// otherwise), so the length check must happen first and short-circuits to
// false rather than throwing.
export function timingSafeTokenMatch(received: string | null, expected: string): boolean {
  if (received === null) return false;
  const receivedBuf = Buffer.from(received);
  const expectedBuf = Buffer.from(expected);
  if (receivedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(receivedBuf, expectedBuf);
}
