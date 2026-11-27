import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { hiveClient } from './hive.js';
import type { PointsLogWriter } from './pointsLedger.js';

/**
 * The Hive writer for the points log: custom_json `3speak_points` (or
 * `3sp_points` once the 3SP token is live, lib/pointsLog.ts) from
 * POINTS_LOG_ACCOUNT (@threespeak-pro). Its posting key signs it; without
 * one, the boost wallet's active key when that is the same account (a
 * custom_json under required_auths then). Null when neither is set: the
 * ledger rows wait in Mongo until a key is configured.
 */
export function hivePointsLogWriter(): PointsLogWriter | null {
  const account = config.POINTS_LOG_ACCOUNT.trim().toLowerCase();
  if (!account) return null;
  const posting = config.POINTS_LOG_POSTING_KEY.trim();
  const active = config.BOOST_PLATFORM_ACCOUNT.trim().toLowerCase() === account
    ? config.BOOST_PLATFORM_ACTIVE_KEY.trim()
    : '';
  if (!posting && !active) return null;
  const key = PrivateKey.fromString(posting || active);
  return async (json, id) => {
    const res = await hiveClient.broadcast.json({
      id,
      json,
      required_auths: posting ? [] : [account],
      required_posting_auths: posting ? [account] : [],
    }, key);
    return res.id;
  };
}
