export type SfxName = 'success' | 'alert' | 'signal';

export const SOUND_PREFERENCE_KEY = 'mw-ui-sound-enabled';

const catalog: Record<SfxName, string> = {
  success: '/sounds/ui-success.wav',
  alert: '/sounds/ui-alert.wav',
  signal: '/sounds/ui-signal.wav',
};

type SoundStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

type AudioPlayback = {
  preload: string;
  volume: number;
  ended: boolean;
  onended: ((event: Event) => unknown) | null;
  play: () => Promise<unknown>;
};

let activeAudio: AudioPlayback | null = null;

export function readSoundPreference(storage: SoundStorage): boolean {
  try {
    return storage.getItem(SOUND_PREFERENCE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistSoundPreference(storage: SoundStorage, enabled: boolean): void {
  try {
    storage.setItem(SOUND_PREFERENCE_KEY, String(enabled));
  } catch {
    // Preference storage may be unavailable; the in-memory control still works.
  }
}

export function playCatalogSound(
  name: SfxName,
  enabled: boolean,
  ready: boolean,
  createAudio: (source: string) => AudioPlayback
): void {
  if (!enabled || !ready) return;
  if (activeAudio && !activeAudio.ended) return;
  try {
    const audio = createAudio(catalog[name]);
    activeAudio = audio;
    audio.onended = () => {
      if (activeAudio === audio) activeAudio = null;
    };
    audio.preload = 'none';
    audio.volume = 0.32;
    void audio.play().catch(() => {
      if (activeAudio === audio) activeAudio = null;
    });
  } catch {
    activeAudio = null;
    // Missing audio never interrupts the action.
  }
}
