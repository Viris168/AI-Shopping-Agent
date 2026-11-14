import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchConfig, photosOn, shouldMount } from '../src/rollout';
import { MemoryStorage, jsonResponse, mockFetch } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const on = (rolloutPercent: number) => ({ enabled: true, rolloutPercent });

describe('rollout', () => {
  it('reads whether photos are on, off unless it says exactly true', async () => {
    mockFetch(jsonResponse(200, { enabled: true, rolloutPercent: 5, imagesEnabled: true }),
      jsonResponse(200, { enabled: true, rolloutPercent: 5, imagesEnabled: 'yes' }));
    expect((await fetchConfig('https://chat.test'))?.imagesEnabled).toBe(true);
    expect((await fetchConfig('https://chat.test'))?.imagesEnabled).toBe(false);
  });

  it('shows photos to the same buckets as they grow, and to opted-in staff', () => {
    const photos = (pct: number, enabled = true) => ({ ...on(100), imagesEnabled: enabled, imagesRolloutPercent: pct });
    const storage = new MemoryStorage();
    storage.setItem('shopchat:bucket', '30');
    expect(photosOn(photos(25), storage)).toBe(false);
    expect(photosOn(photos(31), storage)).toBe(true);
    expect(photosOn(photos(100, false), storage)).toBe(false); // off wins
    storage.setItem('shopchat:optin', '1');
    expect(photosOn(photos(0), storage)).toBe(true);
    expect(photosOn(null, storage)).toBe(false);
  });

  it('reads the config, and treats a failed or odd response as switched off', async () => {
    mockFetch(jsonResponse(200, { enabled: true, rolloutPercent: 25 }), jsonResponse(503), new Error('offline'),
      jsonResponse(200, { enabled: 'yes', rolloutPercent: 'lots' }));
    expect(await fetchConfig('https://chat.test')).toEqual({ ...on(25), imagesEnabled: false, imagesRolloutPercent: 0 });
    expect(await fetchConfig('https://chat.test')).toBeNull();
    expect(await fetchConfig('https://chat.test')).toBeNull();
    expect(await fetchConfig('https://chat.test')).toEqual({ enabled: false, rolloutPercent: 0, imagesEnabled: false, imagesRolloutPercent: 0 });
  });

  it("passes on the store's time zone only if the browser knows it", async () => {
    mockFetch(
      jsonResponse(200, { enabled: true, rolloutPercent: 25, timeZone: 'Asia/Bangkok' }),
      jsonResponse(200, { enabled: true, rolloutPercent: 25, timeZone: 'Mars/Olympus' }),
    );
    expect((await fetchConfig('https://chat.test'))?.timeZone).toBe('Asia/Bangkok');
    expect((await fetchConfig('https://chat.test'))?.timeZone).toBeUndefined();
  });

  it('fails closed and lets the kill switch beat everything', () => {
    const storage = new MemoryStorage();
    expect(shouldMount(null, '', storage)).toBe(false);
    expect(shouldMount({ enabled: false, rolloutPercent: 100 }, '?shopchat=on', storage)).toBe(false);
  });

  it('keeps each browser in a fixed bucket, so raising the percentage only adds shoppers', () => {
    const storage = new MemoryStorage();
    const random = vi.fn(() => 0.2); // bucket 20
    expect(shouldMount(on(5), '', storage, random)).toBe(false);
    expect(shouldMount(on(20), '', storage, random)).toBe(false);
    expect(shouldMount(on(21), '', storage, random)).toBe(true);
    expect(shouldMount(on(100), '', storage, random)).toBe(true);
    expect(random).toHaveBeenCalledTimes(1);
    expect(storage.getItem('shopchat:bucket')).toBe('20');
  });

  it('lets staff opt in with ?shopchat=on until ?shopchat=off', () => {
    const storage = new MemoryStorage();
    const random = () => 0.99;
    expect(shouldMount(on(0), '?shopchat=on', storage, random)).toBe(true);
    expect(shouldMount(on(0), '', storage, random)).toBe(true);
    expect(shouldMount(on(0), '?shopchat=off', storage, random)).toBe(false);
  });

  it('still applies the percentage when storage is blocked', () => {
    expect(shouldMount(on(100), '?shopchat=on', null)).toBe(true);
    expect(shouldMount(on(0), '', null)).toBe(false);
  });
});
