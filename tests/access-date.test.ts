import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessEndFromDate } from '../src/lib/access-date';

test('access date is the end of the selected CET day, regardless of device timezone', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  assert.equal(accessEndFromDate('2027-02-11', now), '2027-02-11T22:59:59.000Z');
  assert.equal(accessEndFromDate('2026-11-06', now), '2026-11-06T22:59:59.000Z');
  assert.equal(accessEndFromDate('2028-02-29', now), '2028-02-29T22:59:59.000Z');
});

test('incomplete, impossible and oversized dates produce actionable errors instead of Invalid time value', () => {
  for (const value of ['', '11/02/2027', '2027-02-30', '2027-02-29', '2027-13-11', '202702-11-02', '2027-02', '2027-02-11T00:00']) {
    assert.throws(() => accessEndFromDate(value, new Date('2026-11-06')), /Choose a valid access end date/);
  }
  assert.throws(() => accessEndFromDate('2026-11-05', new Date('2026-11-06')), /Choose a future access end date/);
});
