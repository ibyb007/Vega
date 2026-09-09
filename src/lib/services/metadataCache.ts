import { providerManager } from './ProviderManager';
import type { Info } from '../providers/types';

// A small in-memory warm cache for `getMetaData` results. Backed purely by
// a Map (no persistence needed) -- its only job is to let the TV home
// screen start fetching a title's details the moment a poster is focused,
// so that by the time the user actually presses select, the details
// screen can often skip its loading spinner entirely and paint instantly.
const cache = new Map<string, Info>();
const inFlight = new Map<string, Promise<Info>>();

const keyFor = (link: string, providerValue: string) => `${providerValue}::${link}`;

export const getCachedMetadata = (link: string, providerValue: string): Info | undefined => {
  if (!link || !providerValue) return undefined;
  return cache.get(keyFor(link, providerValue));
};

// Fire-and-forget warm-up. Safe to call repeatedly (e.g. on every focus
// event) -- de-dupes in-flight requests and silently swallows errors,
// since this is only a background optimization, not a user-facing action.
export const prefetchMetadata = (link: string, providerValue: string): void => {
  if (!link || !providerValue) return;
  const key = keyFor(link, providerValue);
  if (cache.has(key) || inFlight.has(key)) return;

  const request = providerManager
    .getMetaData({ link, provider: providerValue })
    .then((info) => {
      cache.set(key, info);
      inFlight.delete(key);
      return info;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });

  inFlight.set(key, request);
};

// Used by the details screen itself: returns the cached value immediately
// if present, otherwise starts (or joins) the fetch and caches the result.
export const getOrFetchMetadata = (link: string, providerValue: string): Promise<Info> => {
  const key = keyFor(link, providerValue);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = providerManager
    .getMetaData({ link, provider: providerValue })
    .then((info) => {
      cache.set(key, info);
      inFlight.delete(key);
      return info;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });

  inFlight.set(key, request);
  return request;
};
