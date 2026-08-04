import { useMemo } from 'react';
import { useHangoutsContext } from '../context/HangoutsContext.js';
import { VscSubsClient } from '../lib/vscContract.js';

/**
 * The VSC subscription-contract client, bound to the provider's Pro config and
 * Aioha instance. Stable for as long as those are.
 */
export function useVscSubs(): VscSubsClient {
  const { pro, aioha } = useHangoutsContext();
  return useMemo(() => new VscSubsClient(pro, aioha), [pro, aioha]);
}
