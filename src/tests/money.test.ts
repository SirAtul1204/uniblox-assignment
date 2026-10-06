import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateTotals,
  formatMoney,
  parseMoney,
  safeInteger,
} from "../utils/money";

test("INR decimal strings convert and format exactly", () => {
  for (const [input, minor, formatted] of [
    ["200.34", 20034, "200.34"],
    ["0.1", 10, "0.10"],
    ["0", 0, "0.00"],
    ["99", 9900, "99.00"],
  ] as const) {
    assert.equal(parseMoney(input), minor);
    assert.equal(formatMoney(minor), formatted);
  }
  assert.equal(parseMoney("90071992547409.91"), Number.MAX_SAFE_INTEGER);
  assert.equal(formatMoney(18014398509481982n), "180143985094819.82");
});
test("money rejects ambiguous, negative, overprecise and overflowing input", () => {
  for (const invalid of [
    "-1.00",
    "1e2",
    "1.001",
    "NaN",
    "Infinity",
    ".1",
    "1.",
    "01.00",
    " 1.00",
    "90071992547409.92",
  ]) {
    assert.throws(() => parseMoney(invalid));
  }
  assert.throws(() => safeInteger(-1n));
  assert.throws(() => safeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n));
});
test("discount rounds down once on the subtotal and 100 percent yields zero", () => {
  assert.deepEqual(calculateTotals(20034, 10), {
    subtotalMinor: 20034,
    discountMinor: 2003,
    totalMinor: 18031,
  });
  assert.deepEqual(calculateTotals(19, 10), {
    subtotalMinor: 19,
    discountMinor: 1,
    totalMinor: 18,
  });
  assert.equal(calculateTotals(99995, 100).totalMinor, 0);
  assert.equal(calculateTotals(Number.MAX_SAFE_INTEGER, 100).totalMinor, 0);
  assert.throws(() => calculateTotals(100, 101));
});
