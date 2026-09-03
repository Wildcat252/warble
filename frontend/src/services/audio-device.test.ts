import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadBackendDeviceId, persistBackendDeviceId, resolveBackendDeviceId,
  type BackendAudioDeviceList,
} from './audio-device';

const KEY = 'warble.backend-device-id.v1';

function list(...names: [number, string][]): BackendAudioDeviceList {
  return {
    default_device_id: names[0]?.[0] ?? null,
    devices: names.map(([id, name]) => ({
      id, name, channels: 1, host_api: 'Core Audio', default_sample_rate: 48000,
    })),
  };
}

/** The real machine, iPhone attached: it takes index 0 and pushes everything down. */
const WITH_IPHONE = list([0, 'iPhone 11 Microphone'], [1, 'MacBook Air Microphone'], [3, 'Microsoft Teams Audio']);
/** The same machine with the iPhone gone — index 1 is now an OUTPUT and absent from the input list. */
const WITHOUT_IPHONE = list([0, 'MacBook Air Microphone'], [2, 'Microsoft Teams Audio']);

beforeEach(() => {
  window.localStorage.clear();
});

describe('resolveBackendDeviceId', () => {
  it('uses the backend default when nothing has been chosen', () => {
    expect(resolveBackendDeviceId(WITHOUT_IPHONE)).toMatchObject({ id: null, repaired: false, fellBack: false });
  });

  it('passes a still-correct choice straight through', () => {
    persistBackendDeviceId(0, 'MacBook Air Microphone');
    expect(resolveBackendDeviceId(WITHOUT_IPHONE)).toMatchObject({ id: 0, repaired: false, fellBack: false });
  });

  it('follows the chosen microphone when an index shift moves it', () => {
    // This is the actual failure: "MacBook Air Microphone" was index 1 with an
    // iPhone attached. Unplug it and index 1 becomes the speakers — an output —
    // and capture fails with PortAudio -9998, surfacing as HTTP 500.
    persistBackendDeviceId(1, 'MacBook Air Microphone');
    const resolved = resolveBackendDeviceId(WITHOUT_IPHONE);
    expect(resolved).toMatchObject({ id: 0, repaired: true, fellBack: false, name: 'MacBook Air Microphone' });
  });

  it('follows it back again when the device returns', () => {
    persistBackendDeviceId(0, 'MacBook Air Microphone');
    expect(resolveBackendDeviceId(WITH_IPHONE)).toMatchObject({ id: 1, repaired: true });
  });

  it('never trusts the index over the name', () => {
    // Index 0 exists in both lists but holds a different device in each.
    persistBackendDeviceId(0, 'MacBook Air Microphone');
    expect(resolveBackendDeviceId(WITH_IPHONE).name).toBe('MacBook Air Microphone');
    expect(resolveBackendDeviceId(WITH_IPHONE).id).not.toBe(0);
  });

  it('falls back to the default when the chosen device is unplugged', () => {
    persistBackendDeviceId(0, 'iPhone 11 Microphone');
    expect(resolveBackendDeviceId(WITHOUT_IPHONE)).toMatchObject({
      id: null, repaired: false, fellBack: true, name: 'iPhone 11 Microphone',
    });
  });

  describe('values written before names were stored', () => {
    it('reads a bare integer', () => {
      window.localStorage.setItem(KEY, '2');
      expect(loadBackendDeviceId()).toBe(2);
    });

    it('accepts a nameless index that still points at a real device', () => {
      window.localStorage.setItem(KEY, '2');
      expect(resolveBackendDeviceId(WITHOUT_IPHONE)).toMatchObject({ id: 2, repaired: false, fellBack: false });
    });

    it('falls back when a nameless index no longer names an input', () => {
      // Exactly the state Chrome was in: id 1 stored, id 1 not an input device.
      window.localStorage.setItem(KEY, '1');
      expect(resolveBackendDeviceId(WITHOUT_IPHONE)).toMatchObject({ id: null, fellBack: true });
    });
  });

  it('survives a corrupt stored value', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(loadBackendDeviceId()).toBeNull();
    expect(resolveBackendDeviceId(WITHOUT_IPHONE).id).toBeNull();
  });
});

describe('persistBackendDeviceId', () => {
  it('round-trips through the resolver', () => {
    persistBackendDeviceId(2, 'Microsoft Teams Audio');
    expect(loadBackendDeviceId()).toBe(2);
    expect(resolveBackendDeviceId(WITHOUT_IPHONE).name).toBe('Microsoft Teams Audio');
  });

  it('clears the choice', () => {
    persistBackendDeviceId(2, 'Microsoft Teams Audio');
    persistBackendDeviceId(null);
    expect(loadBackendDeviceId()).toBeNull();
  });
});
